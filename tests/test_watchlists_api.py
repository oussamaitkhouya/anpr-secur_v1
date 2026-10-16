"""Watchlists on PostgreSQL: canonical plates, single active entry, removal/expiry with
justifications, CSV import, masking for non-managers, audit, and the path to an alert."""

import hashlib
import io
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pg_support import add_user, cookie, make_settings, migrate_fresh, requires_pg
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.main import create_app
from anpr.db.models import AuditEntry, Camera, City
from anpr.security import audit_chain
from anpr.security.keys import EnvKeyProvider

pytestmark = requires_pg

TOKEN = "watchlist-test-detection-token-0123456789"
WHY = "Vehicle recovered by the owner; case closed by the prosecutor."
HEADER = "plate,reason,color,make,model,vehicle_type,case_ref,source,expires_at\n"


@pytest.fixture(scope="module")
def env():
    migrate_fresh()
    settings = make_settings(detection_token_sha256=hashlib.sha256(TOKEN.encode()).hexdigest())
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    app = create_app(settings, keys)
    db: Session = app.state.session_factory()
    city = City(name="Rabat", region="RSK")
    db.add(city)
    db.flush()
    admin, analyst = add_user(db, "admin1", "admin"), add_user(db, "analyst1", "analyst", [city.id])
    cam = Camera(city_id=city.id, name="gate", kind="anpr_camera", latitude=34, longitude=-6.8, protocol="file")
    db.add(cam)
    db.commit()
    c = TestClient(app)
    hdr = cookie(settings, admin)
    wl = c.post("/api/v1/watchlists", json={"name": "Stolen vehicles", "source": "DGSN"}, headers=hdr).json()
    yield {"c": c, "app": app, "db": db, "keys": keys, "wl": wl["id"], "cam": str(cam.id),
           "admin": hdr, "analyst": cookie(settings, analyst)}
    db.close()
    app.state.engine.dispose()


def add(env, plate, **extra):
    return env["c"].post(f"/api/v1/watchlists/{env['wl']}/entries", json={"plate": plate, "reason": "stolen", **extra}, headers=env["admin"])


def test_create_list_and_refuse_duplicates(env):
    c = env["c"]
    assert c.post("/api/v1/watchlists", json={"name": "Stolen vehicles", "source": "x"}, headers=env["admin"]).status_code == 409
    lists = c.get("/api/v1/watchlists", headers=env["admin"]).json()
    assert [w["name"] for w in lists] == ["Stolen vehicles"]
    assert c.post("/api/v1/watchlists", json={"name": "Nope", "source": "x"}, headers=env["analyst"]).status_code == 403


def test_plates_are_validated_and_stored_canonical(env):
    r = add(env, "12345-أ-6", color="white", caseRef="CASE-1")
    assert r.status_code == 201 and r.json()["plateCanonical"] == "12345|أ|6" and r.json()["status"] == "active"
    assert add(env, "12345|أ|6").status_code == 409            # already active on this list
    assert add(env, "ABC-123").status_code == 422               # not a Moroccan plate
    bad_reason = env["c"].post(f"/api/v1/watchlists/{env['wl']}/entries", json={"plate": "777|ب|1", "reason": "speeding"}, headers=env["admin"])
    assert bad_reason.status_code == 422
    assert add(env, "777|ب|1", expiresAt=(datetime.now(UTC) - timedelta(days=1)).isoformat()).status_code == 422


def test_non_managers_get_masked_plates(env):
    entries = env["c"].get(f"/api/v1/watchlists/{env['wl']}/entries", headers=env["analyst"])
    assert entries.status_code == 200 and "12345" not in entries.text
    assert entries.json()[0]["plateCanonical"].startswith("••••")
    assert "12345|أ|6" in env["c"].get(f"/api/v1/watchlists/{env['wl']}/entries", headers=env["admin"]).text


def test_remove_needs_a_justification_and_keeps_history(env):
    entry = add(env, "4321|د|7").json()
    base = f"/api/v1/watchlists/{env['wl']}/entries/{entry['id']}"
    assert env["c"].post(f"{base}/remove", json={"justification": "short"}, headers=env["admin"]).status_code == 422
    r = env["c"].post(f"{base}/remove", json={"justification": WHY}, headers=env["admin"])
    assert r.status_code == 200 and r.json()["status"] == "removed"
    assert env["c"].post(f"{base}/remove", json={"justification": WHY}, headers=env["admin"]).status_code == 409
    assert add(env, "4321|د|7").status_code == 201  # can be listed again; the old row stays
    rows = [e for e in env["c"].get(f"/api/v1/watchlists/{env['wl']}/entries", headers=env["admin"]).json() if e["plateCanonical"] == "4321|د|7"]
    assert sorted(e["status"] for e in rows) == ["active", "removed"]


def test_expire(env):
    entry = add(env, "88|ه|12").json()
    r = env["c"].post(f"/api/v1/watchlists/{env['wl']}/entries/{entry['id']}/expire",
                      json={"expiresAt": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(), "justification": WHY}, headers=env["admin"])
    assert r.status_code == 200 and r.json()["status"] == "expired"


def test_csv_import_preview_confirm_and_same_file_twice(env):
    def files():
        return {"file": ("list.csv", io.BytesIO(csv), "text/csv")}

    c, wl = env["c"], env["wl"]
    csv = (HEADER + "55555|ب|1,wanted,red,,,car,CASE-9,DGSN,\n" + "bad-plate,stolen,,,,,,,\n").encode()
    preview = c.post(f"/api/v1/watchlists/{wl}/import", params={"mode": "preview"}, files=files(), headers=env["admin"]).json()
    assert preview["rowsAccepted"] == 1 and preview["rowsRejected"] == 1 and preview["importId"] is None
    confirm = c.post(f"/api/v1/watchlists/{wl}/import", params={"mode": "confirm"}, files=files(), headers=env["admin"]).json()
    assert confirm["version"] == 1 and confirm["importId"]
    assert c.post(f"/api/v1/watchlists/{wl}/import", params={"mode": "confirm"}, files=files(), headers=env["admin"]).status_code == 409
    history = c.get(f"/api/v1/watchlists/{wl}/imports", headers=env["admin"]).json()
    assert history[0]["sha256"] == preview["sha256"]


def test_a_listed_plate_seen_by_a_camera_becomes_an_alert(env):
    add(env, "246|ج|3")
    r = env["c"].post("/api/v1/detections", headers={"Authorization": f"Bearer {TOKEN}"}, json={
        "cameraId": env["cam"], "observedAt": datetime.now(UTC).isoformat(), "sourceKind": "video", "plateRaw": "246|ج|3",
        "plateConfidence": 0.97, "charConfidences": [0.97] * 5})
    assert r.status_code == 201 and r.json()["alertsCreated"] == 1


def test_changes_are_audited_without_full_plates(env):
    with Session(env["app"].state.engine) as db:
        actions = {e.action: e for e in db.scalars(select(AuditEntry))}
        assert {"watchlist.create", "watchlist.entry.add", "watchlist.entry.remove", "watchlist.entry.expire", "watchlist.import"} <= set(actions)
        text = " ".join(e.justification or "" for e in actions.values())
        assert "12345" not in text and WHY in text
        assert audit_chain.verify(db, env["keys"].audit_signing_key().public_key()).ok
    assert uuid.UUID(env["wl"])
