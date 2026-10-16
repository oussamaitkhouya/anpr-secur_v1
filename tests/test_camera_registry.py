"""Cities & Cameras registry on PostgreSQL: CRUD, RBAC, city scoping in the query layer,
write-only credentials (never in responses, logs or audit), AES-GCM rotation, connection tests
with SSRF refusals, CSV import, and the audit chain staying valid."""

import io
import json
import logging
import socket
import uuid
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from pg_support import (
    add_user,
    cookie,
    data_key,
    make_settings,
    migrate_fresh,
    requires_pg,
)
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from anpr.api.main import create_app
from anpr.db import scoping
from anpr.db.models import AuditEntry, Camera, CameraStatusEvent
from anpr.security import audit_chain, crypto
from anpr.security.keys import EnvKeyProvider, KeyConfigError
from anpr.security.rbac import Actor

pytestmark = requires_pg

USERNAME_CANARY = "cam-user-CANARY-7f3a"
PASSWORD_CANARY = "pw-CANARY-9b1e-Secret!"


@pytest.fixture(scope="module")
def env():
    migrate_fresh()
    settings = make_settings()
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    app = create_app(settings, keys)
    client = TestClient(app)
    db = app.state.session_factory()

    admin = add_user(db, "admin1", "admin")
    auditor = add_user(db, "auditor1", "auditor")
    hdr = cookie(settings, admin)
    rabat = client.post("/api/v1/admin/cities", json={"name": "Rabat", "region": "Rabat-Salé-Kénitra"}, headers=hdr).json()
    casa = client.post("/api/v1/admin/cities", json={"name": "Casablanca", "region": "Casablanca-Settat"}, headers=hdr).json()
    analyst = add_user(db, "analyst1", "analyst", [uuid.UUID(rabat["id"])])
    lonely = add_user(db, "analyst2", "analyst")

    ctx = {
        "app": app, "client": client, "db": db, "settings": settings, "keys": keys,
        "rabat": rabat["id"], "casa": casa["id"],
        "as": {"admin": hdr, "analyst": cookie(settings, analyst), "auditor": cookie(settings, auditor),
               "lonely": cookie(settings, lonely), "anonymous": {}},
    }
    yield ctx
    db.close()
    app.state.engine.dispose()


def new_camera(env, city="rabat", **over):
    body = {"cityId": env[city], "name": f"cam-{uuid.uuid4().hex[:6]}", "kind": "anpr_camera",
            "latitude": 34.0, "longitude": -6.85, "protocol": "rtsps", "host": "10.20.0.11", "port": 322,
            "streamPath": "/stream1"}
    body.update(over)
    r = env["client"].post("/api/v1/admin/cameras", json=body, headers=env["as"]["admin"])
    assert r.status_code == 201, r.text
    return r.json()


# ---- CRUD -------------------------------------------------------------------------------

def test_city_crud_and_delete_blocked_while_cameras_exist(env):
    c, h = env["client"], env["as"]["admin"]
    city = c.post("/api/v1/admin/cities", json={"name": "Tanger", "region": "Tanger-Tétouan"}, headers=h).json()
    assert c.post("/api/v1/admin/cities", json={"name": "Tanger", "region": "x"}, headers=h).status_code == 409
    assert c.patch(f"/api/v1/admin/cities/{city['id']}", json={"region": "TTA"}, headers=h).json()["region"] == "TTA"
    cam = new_camera(env, city="rabat")  # unrelated
    tanger_cam = c.post("/api/v1/admin/cameras", json={**{k: cam[k] for k in ("kind", "latitude", "longitude", "protocol")},
                                                       "cityId": city["id"], "name": "t1"}, headers=h).json()
    r = c.delete(f"/api/v1/admin/cities/{city['id']}", headers=h)
    assert r.status_code == 409 and "1 camera" in r.json()["detail"]
    assert c.delete(f"/api/v1/admin/cameras/{tanger_cam['id']}", headers=h).status_code == 204
    assert c.delete(f"/api/v1/admin/cities/{city['id']}", headers=h).status_code == 204


def test_camera_crud_status_history_and_maintenance(env):
    c, h = env["client"], env["as"]["admin"]
    cam = new_camera(env, notes="North-bound", viewDirectionDeg=270, lane="2")
    assert cam["status"] == "unknown" and cam["credentialsSet"] is False and cam["host"] == "10.20.0.11"
    assert c.get(f"/api/v1/cameras/{cam['id']}", headers=h).json()["notes"] == "North-bound"
    r = c.patch(f"/api/v1/admin/cameras/{cam['id']}", json={"status": "maintenance"}, headers=h)
    assert r.json()["status"] == "maintenance"
    events = env["db"].scalars(select(CameraStatusEvent.reason).where(
        CameraStatusEvent.camera_id == uuid.UUID(cam["id"])).order_by(CameraStatusEvent.at)).all()
    assert events == ["created", "maintenance mode"]
    assert c.patch(f"/api/v1/admin/cameras/{cam['id']}", json={"name": None}, headers=h).status_code == 422
    dup = c.post("/api/v1/admin/cameras", json={"cityId": env["rabat"], "name": cam["name"], "kind": "ptz",
                                                "latitude": 1, "longitude": 1, "protocol": "rtsp"}, headers=h)
    assert dup.status_code == 409
    assert c.delete(f"/api/v1/admin/cameras/{cam['id']}", headers=h).status_code == 204
    assert c.get(f"/api/v1/cameras/{cam['id']}", headers=h).status_code == 404


# ---- RBAC matrix ------------------------------------------------------------------------

READS = [("GET", "/api/v1/cameras"), ("GET", "/api/v1/cameras/map")]
WRITES = [("POST", "/api/v1/admin/cities"), ("POST", "/api/v1/admin/cameras"),
          ("POST", "/api/v1/admin/cameras/test-connection"), ("GET", "/api/v1/admin/cameras/import/template")]


@pytest.mark.parametrize("role, read_status, write_status", [
    ("admin", 200, None),        # writes: anything but 401/403
    ("analyst", 200, 403),
    ("auditor", 403, 403),       # no camera registry for auditors
    ("anonymous", 401, 401),
])
def test_rbac_matrix(env, role, read_status, write_status):
    c, h = env["client"], env["as"][role]
    for method, path in READS:
        assert c.request(method, path, headers=h).status_code == read_status, (role, path)
    for method, path in WRITES:
        status = c.request(method, path, headers=h, json={}).status_code
        if write_status is None:
            assert status not in (401, 403), (role, path)
        else:
            assert status == write_status, (role, path)


def test_auditor_keeps_city_list_but_not_cameras(env):
    c = env["client"]
    assert c.get("/api/v1/cities", headers=env["as"]["auditor"]).status_code == 200
    assert c.get(f"/api/v1/cameras/{uuid.uuid4()}", headers=env["as"]["auditor"]).status_code == 403


# ---- city scoping -----------------------------------------------------------------------

def test_analyst_only_sees_allowed_cities_everywhere(env):
    c = env["client"]
    mine, other = new_camera(env, "rabat"), new_camera(env, "casa")
    a = env["as"]["analyst"]
    ids = {x["id"] for x in c.get("/api/v1/cameras", headers=a).json()}
    assert mine["id"] in ids and other["id"] not in ids
    map_ids = {x["id"] for x in c.get("/api/v1/cameras/map", headers=a).json()}
    assert mine["id"] in map_ids and other["id"] not in map_ids
    assert c.get(f"/api/v1/cameras/{other['id']}", headers=a).status_code == 404  # 404, not 403: no probing
    assert c.get("/api/v1/cameras", params={"city_id": env["casa"]}, headers=a).json() == []
    assert {x["id"] for x in c.get("/api/v1/cities", headers=a).json()} == {env["rabat"]}


def test_analyst_without_cities_sees_nothing(env):
    c, h = env["client"], env["as"]["lonely"]
    new_camera(env)
    assert c.get("/api/v1/cameras", headers=h).json() == []
    assert c.get("/api/v1/cameras/map", headers=h).json() == []


def test_scoping_is_a_where_clause_in_the_sql(env):
    """The filter is part of the query sent to PostgreSQL, not a filter applied after loading."""
    city = uuid.UUID(env["rabat"])
    stmt = scoping.cameras(select(Camera), Actor(id="x", role="analyst", ip="t", city_ids=frozenset({city})))
    sql = str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "WHERE cameras.city_id IN" in sql and str(city) in sql
    empty = scoping.cameras(select(Camera), Actor(id="x", role="analyst", ip="t", city_ids=frozenset()))
    assert "false" in str(empty.compile(dialect=postgresql.dialect())).lower()


# ---- credentials ------------------------------------------------------------------------

def test_credentials_are_write_only_and_never_leak(env, caplog):
    c, h, db = env["client"], env["as"]["admin"], env["db"]
    caplog.set_level(logging.DEBUG)
    cam = new_camera(env)
    body = {"username": USERNAME_CANARY, "password": PASSWORD_CANARY}
    assert c.put(f"/api/v1/admin/cameras/{cam['id']}/credentials", json=body, headers=h).status_code == 204

    responses = [
        c.get(f"/api/v1/cameras/{cam['id']}", headers=h),
        c.get("/api/v1/cameras", headers=h),
        c.get("/api/v1/cameras/map", headers=h),
        c.get(f"/api/v1/cameras/{cam['id']}", headers=env["as"]["analyst"]),
        c.patch(f"/api/v1/admin/cameras/{cam['id']}", json={"lane": "1"}, headers=h),
        c.get(f"/api/v1/admin/cameras/{cam['id']}/audit", headers=h),
        # a rejected body must not echo the submitted password back
        c.put(f"/api/v1/admin/cameras/{cam['id']}/credentials",
              json={"username": USERNAME_CANARY, "password": PASSWORD_CANARY * 20}, headers=h),
    ]
    assert responses[0].json()["credentialsSet"] is True
    assert responses[-1].status_code == 422
    for r in responses:
        assert USERNAME_CANARY not in r.text and PASSWORD_CANARY not in r.text
        assert "credentialsEncrypted" not in r.text and "credentialsKeyId" not in r.text

    logged = "\n".join(rec.getMessage() for rec in caplog.records)
    assert PASSWORD_CANARY not in logged and USERNAME_CANARY not in logged

    db.expire_all()
    row = db.get(Camera, uuid.UUID(cam["id"]))
    assert PASSWORD_CANARY.encode() not in row.credentials_encrypted and row.credentials_key_id == "k1"
    assert row.stream_path == "/stream1" and "@" not in (row.host or "")
    plain = json.loads(crypto.decrypt(env["keys"], row.credentials_encrypted, row.credentials_key_id,
                                      purpose="camera-credentials", row_id=str(row.id)))
    assert plain == body

    audit_text = " ".join(f"{e.action} {e.justification}" for e in db.scalars(select(AuditEntry)))
    assert PASSWORD_CANARY not in audit_text and USERNAME_CANARY not in audit_text
    assert "camera.credentials.replace" in audit_text


def test_ciphertext_copied_to_another_camera_does_not_decrypt(env):
    c, h, db = env["client"], env["as"]["admin"], env["db"]
    a, b = new_camera(env), new_camera(env)
    c.put(f"/api/v1/admin/cameras/{a['id']}/credentials", json={"username": "u", "password": "p"}, headers=h)
    db.expire_all()
    blob = db.get(Camera, uuid.UUID(a["id"])).credentials_encrypted
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt(env["keys"], blob, "k1", purpose="camera-credentials", row_id=b["id"])


def test_key_rotation_round_trip():
    k1, k2 = data_key(), data_key()
    from pg_support import signing_key_b64
    sign = signing_key_b64()
    old = EnvKeyProvider(f"k1:{k1}", "k1", sign)
    blob, kid = crypto.encrypt(old, b'{"username":"u","password":"p"}', purpose="camera-credentials", row_id="r1")
    assert kid == "k1"
    both = EnvKeyProvider(f"k1:{k1},k2:{k2}", "k2", sign)
    assert crypto.decrypt(both, blob, "k1", purpose="camera-credentials", row_id="r1") == b'{"username":"u","password":"p"}'
    new_blob, new_kid = crypto.reencrypt(both, blob, kid, purpose="camera-credentials", row_id="r1")
    assert new_kid == "k2" and new_blob != blob
    only_new = EnvKeyProvider(f"k2:{k2}", "k2", sign)
    assert crypto.decrypt(only_new, new_blob, "k2", purpose="camera-credentials", row_id="r1").startswith(b"{")
    with pytest.raises(KeyConfigError):
        crypto.decrypt(only_new, blob, "k1", purpose="camera-credentials", row_id="r1")


# ---- connection tests ---------------------------------------------------------------------

@pytest.mark.parametrize("host", ["127.0.0.1", "169.254.169.254", "localhost", "::1", "0.0.0.0"])
def test_connection_test_refuses_internal_targets(env, host):
    r = env["client"].post("/api/v1/admin/cameras/test-connection", json={"protocol": "rtsp", "host": host, "port": 554},
                           headers=env["as"]["admin"])
    assert r.status_code == 422 and "refused" in r.json()["detail"]


def test_connection_test_is_honest_and_audited(env):
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    app = create_app(replace(env["settings"], allowed_camera_networks=("127.0.0.1/32",)), env["keys"])
    try:
        with TestClient(app) as c:
            cam = new_camera(env, protocol="rtsp", host="127.0.0.1", port=port)
            r = c.post(f"/api/v1/admin/cameras/{cam['id']}/test-connection", headers=env["as"]["admin"])
            out = r.json()
            assert r.status_code == 200 and out["reachable"] is True
            assert out["verdict"] == "Network reachable, stream not verified"
            assert [s["name"] for s in out["steps"]] == ["dns", "tcp"]
    finally:
        srv.close()
        app.state.engine.dispose()
    entry = env["db"].scalars(select(AuditEntry).where(AuditEntry.action == "camera.test_connection",
                                                       AuditEntry.target_id == cam["id"])).one()
    assert "stream not verified" in entry.justification


# ---- CSV import -----------------------------------------------------------------------------

HEADER = ("city,name,kind,district,street_address,latitude,longitude,view_direction_deg,lane,installed_on,"
          "owner,protocol,host,port,stream_path,vlan,firmware_version,notes\n")


def upload(env, content: bytes, mode="preview", name="cams.csv"):
    return env["client"].post("/api/v1/admin/cameras/import", params={"mode": mode},
                              files={"file": (name, io.BytesIO(content), "text/csv")}, headers=env["as"]["admin"])


def test_import_preview_writes_nothing_then_confirm_writes_and_audits(env):
    rows = (HEADER
            + "Rabat,imp-a,anpr_camera,Agdal,,34.0,-6.85,90,2,2026-01-15,City,rtsps,10.20.0.21,322,/s1,120,4.2,\n"
            + "Rabat,imp-b,ptz,,,34.1,-6.80,,,,,rtsp,cam-b.rabat.local,554,/s2,,,\n")
    before = len(env["client"].get("/api/v1/cameras", headers=env["as"]["admin"]).json())
    p = upload(env, rows.encode()).json()
    assert p["rowsAccepted"] == 2 and p["rowsRejected"] == 0 and len(p["sha256"]) == 64
    assert len(env["client"].get("/api/v1/cameras", headers=env["as"]["admin"]).json()) == before
    c = upload(env, rows.encode(), mode="confirm").json()
    assert c["mode"] == "confirm"
    assert len(env["client"].get("/api/v1/cameras", headers=env["as"]["admin"]).json()) == before + 2
    entry = env["db"].scalars(select(AuditEntry).where(AuditEntry.action == "camera.import")).all()[-1]
    assert f"sha256={p['sha256']}" in entry.justification and "accepted=2" in entry.justification


def test_import_reports_bad_rows_line_by_line(env):
    rows = (HEADER
            + "Rabat,ok-1,anpr_camera,,,34,-6.8,,,,,rtsp,10.0.0.1,554,/s,,,\n"
            + "Rabat,ok-1,anpr_camera,,,34,-6.8,,,,,rtsp,10.0.0.2,554,/s,,,\n"          # duplicate in file
            + "Atlantis,x,anpr_camera,,,34,-6.8,,,,,rtsp,10.0.0.3,554,/s,,,\n"          # unknown city
            + "Rabat,bad-lat,anpr_camera,,,95,-6.8,,,,,rtsp,10.0.0.4,554,/s,,,\n"       # latitude
            + "Rabat,bad-host,anpr_camera,,,34,-6.8,,,,,rtsp,admin:pw@10.0.0.5,554,/s,,,\n"
            + "Rabat,=HYPERLINK(1),anpr_camera,,,34,-6.8,,,,,rtsp,10.0.0.6,554,/s,,,\n")  # CSV injection
    out = upload(env, rows.encode()).json()
    assert out["rowsAccepted"] == 1 and out["rowsRejected"] == 5
    reasons = {r["line"]: " ".join(r["reasons"]) for r in out["rejected"]}
    assert "duplicate of line 2" in reasons[3]
    assert "no city" in reasons[4]
    assert "latitude" in reasons[5]
    assert "host" in reasons[6] and "pw" not in reasons[6]
    assert "must not start with" in reasons[7]


def test_import_refuses_existing_names_bad_files_and_credential_columns(env):
    cam = new_camera(env)
    dup = HEADER + f"Rabat,{cam['name']},anpr_camera,,,34,-6.8,,,,,rtsp,10.0.0.1,554,/s,,,\n"
    assert "already exists" in upload(env, dup.encode()).json()["rejected"][0]["reasons"][0]
    assert upload(env, b"name,kind\nx,ptz\n").status_code == 422
    assert upload(env, "é".encode("latin-1") + b"\n").status_code == 422
    creds = HEADER.replace("notes", "password") + "Rabat,x,ptz,,,1,1,,,,,rtsp,,,,,,p\n"
    r = upload(env, creds.encode())
    assert r.status_code == 422 and "Credentials cannot be imported" in r.json()["detail"]
    big = HEADER.encode() + b"x" * (env["settings"].max_csv_bytes + 10)
    assert upload(env, big).status_code == 413
    assert upload(env, HEADER.encode(), mode="confirm").status_code == 422


# ---- audit and limits ---------------------------------------------------------------------

def test_every_change_is_in_a_valid_signed_chain(env):
    with Session(env["app"].state.engine) as db:
        actions = set(db.scalars(select(AuditEntry.action)))
        result = audit_chain.verify(db, env["keys"].audit_signing_key().public_key())
    assert {"city.create", "city.update", "city.delete", "camera.create", "camera.update", "camera.delete",
            "camera.credentials.replace", "camera.import", "camera.test_connection"} <= actions
    assert result.ok, result


def test_camera_endpoints_are_rate_limited(env):
    app = create_app(replace(env["settings"], camera_rate_per_minute=3), env["keys"])
    try:
        with TestClient(app) as c:
            codes = [c.post("/api/v1/admin/cities", json={}, headers=env["as"]["admin"]).status_code for _ in range(4)]
    finally:
        app.state.engine.dispose()
    assert codes[:3] == [422, 422, 422] and codes[3] == 429


def test_status_history_is_city_scoped(env):
    c = env["client"]
    mine, other = new_camera(env, "rabat"), new_camera(env, "casa")
    history = c.get(f"/api/v1/cameras/{mine['id']}/status-events", headers=env["as"]["analyst"])
    assert history.status_code == 200 and history.json()[0]["reason"] == "created"
    assert c.get(f"/api/v1/cameras/{other['id']}/status-events", headers=env["as"]["analyst"]).status_code == 404
    assert c.get(f"/api/v1/cameras/{mine['id']}/status-events", headers=env["as"]["auditor"]).status_code == 403
