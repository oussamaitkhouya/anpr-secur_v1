"""Search/reveal, recent reads, evidence, audit log, security center, system settings, models and
own-account endpoints, on PostgreSQL: masking, scoping, permissions and audit trail."""

import hashlib
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from pg_support import add_user, cookie, make_settings, migrate_fresh, requires_pg
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.main import create_app
from anpr.db.models import AuditEntry, Camera, City, DetectionEvent, RefreshToken, User
from anpr.security.keys import EnvKeyProvider
from anpr.security.passwords import hash_password, verify_password
from anpr.security.tokens import issue_refresh

pytestmark = requires_pg

PLATE = "12345|أ|6"
OTHER = "98765|ب|1"
FRAME = b"jpeg-bytes-of-a-frame"
WHY = "Following up alert on the stolen-vehicle case CASE-77."
OLD_PW = "Correct-Horse-Battery-9"


@pytest.fixture(scope="module")
def env():
    migrate_fresh()
    settings = make_settings()
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    app = create_app(settings, keys)
    db: Session = app.state.session_factory()
    rabat, casa = City(name="Rabat", region="R"), City(name="Casablanca", region="C")
    db.add_all([rabat, casa])
    db.flush()
    admin = add_user(db, "admin1", "admin")
    analyst = add_user(db, "analyst1", "analyst", [rabat.id])
    auditor = add_user(db, "auditor1", "auditor")
    cam_r = Camera(city_id=rabat.id, name="gate", kind="anpr_camera", latitude=34, longitude=-6.8, protocol="rtsp", status="online")
    cam_c = Camera(city_id=casa.id, name="quay", kind="anpr_camera", latitude=33, longitude=-7.6, protocol="rtsps", status="online")
    db.add_all([cam_r, cam_c])
    db.flush()
    now = datetime.now(UTC)
    mine = DetectionEvent(camera_id=cam_r.id, observed_at=now, received_at=now, source_kind="video", plate_raw=PLATE,
                          plate_canonical=PLATE, plate_confidence=0.95, evidence_sha256=hashlib.sha256(FRAME).hexdigest())
    theirs = DetectionEvent(camera_id=cam_c.id, observed_at=now, received_at=now, source_kind="video", plate_raw=OTHER,
                            plate_canonical=OTHER, plate_confidence=0.7)
    db.add_all([mine, theirs])
    db.commit()
    yield {"c": TestClient(app), "app": app, "db": db, "settings": settings, "mine": str(mine.id), "theirs": str(theirs.id),
           "admin_id": admin, "as": {"admin": cookie(settings, admin), "analyst": cookie(settings, analyst), "auditor": cookie(settings, auditor)}}
    db.close()
    app.state.engine.dispose()


def get(env, role, path, **kw):
    return env["c"].get(f"/api/v1{path}", headers=env["as"][role], **kw)


def post(env, role, path, json=None):
    return env["c"].post(f"/api/v1{path}", headers=env["as"][role], json=json)


def actions(env) -> list[AuditEntry]:
    with Session(env["app"].state.engine) as db:
        return db.scalars(select(AuditEntry).order_by(AuditEntry.seq)).all()


# ---- search and reveal --------------------------------------------------------------------

def test_search_is_masked_scoped_and_audited(env):
    r = get(env, "analyst", "/plates/search", params={"q": "2345"})
    assert r.status_code == 200 and len(r.json()) == 1 and "12345" not in r.text
    assert r.json()[0]["plateMasked"].startswith("••••")
    assert get(env, "analyst", "/plates/search", params={"q": "8765"}).json() == []  # other city's read
    assert get(env, "analyst", "/plates/search", params={"q": "12"}).status_code == 422
    assert get(env, "auditor", "/plates/search", params={"q": "2345"}).status_code == 403
    last = [e for e in actions(env) if e.action == "plates.search"][-1]
    assert "2345" not in last.justification and "results=" in last.justification


def test_reveal_needs_a_reason_and_the_right_role(env):
    assert post(env, "analyst", f"/plates/{env['mine']}/reveal", {"justification": "why"}).status_code == 422
    assert post(env, "admin", f"/plates/{env['mine']}/reveal", {"justification": WHY}).status_code == 403
    assert post(env, "analyst", f"/plates/{env['theirs']}/reveal", {"justification": WHY}).status_code == 404
    r = post(env, "analyst", f"/plates/{env['mine']}/reveal", {"justification": WHY})
    assert r.status_code == 200 and r.json()["plateCanonical"] == PLATE
    entry = [e for e in actions(env) if e.action == "plates.reveal"][-1]
    assert entry.justification == WHY and entry.target_id == env["mine"]


def test_recent_reads_are_masked_and_scoped(env):
    reads = get(env, "analyst", "/detections/recent").json()
    assert [r["detectionId"] for r in reads] == [env["mine"]] and "12345" not in str(reads)
    assert get(env, "auditor", "/detections/recent").status_code == 403


# ---- evidence -------------------------------------------------------------------------------

def test_evidence_list_and_verification(env):
    listed = get(env, "auditor", "/evidence").json()
    assert [r["detectionId"] for r in listed] == [env["mine"]]
    assert get(env, "analyst", "/evidence").status_code == 403
    ok = post(env, "auditor", f"/evidence/{env['mine']}/verify", {"sha256": hashlib.sha256(FRAME).hexdigest()}).json()
    bad = post(env, "auditor", f"/evidence/{env['mine']}/verify", {"sha256": "0" * 64}).json()
    assert ok["match"] is True and bad["match"] is False
    assert [e.justification for e in actions(env) if e.action == "evidence.verify"][-2:] == ["match", "MISMATCH"]
    assert post(env, "auditor", f"/evidence/{env['theirs']}/verify", {"sha256": "0" * 64}).status_code == 404


# ---- audit log ------------------------------------------------------------------------------

def test_audit_log_filters_verify_and_export(env):
    every = get(env, "auditor", "/audit").json()
    assert every and every[0]["seq"] > every[-1]["seq"] and {"hash", "signature", "prevHash"} <= set(every[0])
    only = get(env, "auditor", "/audit", params={"action": "plates."}).json()
    assert only and all(e["action"].startswith("plates.") for e in only)
    assert get(env, "auditor", "/audit/verify").json()["ok"] is True
    assert "publicKey" in get(env, "auditor", "/audit/public-key").json()
    assert post(env, "auditor", "/audit/exports", {"rows": 12, "filters": "action=plates."}).status_code == 204
    assert [e for e in actions(env) if e.action == "audit.export"][-1].justification.startswith("rows=12")
    assert get(env, "analyst", "/audit").status_code == 403


# ---- security center, system settings, models ---------------------------------------------

def test_security_overview_is_computed_live(env):
    r = get(env, "auditor", "/security/overview")
    assert r.status_code == 200
    checks = {c["id"]: c for c in r.json()["checks"]}
    assert checks["cam-transport"]["status"] == "warn" and checks["cam-transport"]["count"] == 1  # the plain RTSP camera
    assert checks["audit-chain"]["status"] == "ok"
    assert checks["acct-mfa"]["count"] == 3  # test users never enrolled MFA
    assert get(env, "analyst", "/security/overview").status_code == 403


def test_system_settings_show_limits_but_never_keys(env):
    r = get(env, "admin", "/system/settings")
    assert r.status_code == 200 and r.json()["dataKeyIds"] == ["k1"]
    key_material = env["settings"].data_keys.partition(":")[2]
    assert key_material not in r.text and env["settings"].jwt_secret not in r.text
    assert get(env, "auditor", "/system/settings").status_code == 403


def test_models_page_data_for_every_role(env):
    for role in ("admin", "analyst", "auditor"):
        r = get(env, role, "/models")
        assert r.status_code == 200
    body = get(env, "analyst", "/models").json()
    assert body["live"]["last24h"]["reads"] == 1  # only the analyst's city
    assert "detector" in body and "note" in body
    assert ":\\" not in str(body["detector"]["weights"])  # no absolute Windows paths


# ---- own account ----------------------------------------------------------------------------

def test_change_password_and_sign_out_everywhere(env):
    db = env["db"]
    user = db.get(User, env["admin_id"])
    user.password_hash = hash_password(OLD_PW)
    issue_refresh(db, user.id, 7)
    db.commit()
    assert post(env, "admin", "/auth/password", {"currentPassword": "wrong-password-1", "newPassword": "Another-Long-Pass-42"}).status_code == 401
    assert post(env, "admin", "/auth/password", {"currentPassword": OLD_PW, "newPassword": "short"}).status_code == 422
    r = post(env, "admin", "/auth/password", {"currentPassword": OLD_PW, "newPassword": "Another-Long-Pass-42"})
    assert r.status_code == 204
    db.expire_all()
    assert verify_password(db.get(User, env["admin_id"]).password_hash, "Another-Long-Pass-42")
    assert all(t.revoked_at for t in db.scalars(select(RefreshToken).where(RefreshToken.user_id == env["admin_id"])))
    assert post(env, "analyst", "/auth/sessions/revoke").status_code == 204
    names = [e.action for e in actions(env)]
    assert {"auth.password.change.failure", "auth.password.change", "auth.sessions.revoke"} <= set(names)
