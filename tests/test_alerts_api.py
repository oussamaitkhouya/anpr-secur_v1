"""Alerts and overview on PostgreSQL: city scoping, plate masking by role, the human review rule
(justification, single decision, audited), and overview counts from real rows."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pg_support import add_user, cookie, make_settings, migrate_fresh, requires_pg
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.main import create_app
from anpr.api.routes.alerts import evidence_path
from anpr.db.models import (
    Alert,
    AuditEntry,
    Camera,
    City,
    DetectionEvent,
    WatchlistEntry,
    WatchlistList,
)
from anpr.security import audit_chain
from anpr.security.keys import EnvKeyProvider

pytestmark = requires_pg

PLATE_RABAT = "12345|أ|6"
PLATE_CASA = "777|ب|1"
WHY = "Plate and letter legible on the crop; region matches the entry."
FRAME = bytes.fromhex("ffd8ffe0") + b" fake jpeg frame of the Rabat gate " + bytes.fromhex("ffd9")
FRAME_SHA = hashlib.sha256(FRAME).hexdigest()


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    migrate_fresh()
    settings = make_settings(evidence_dir=str(tmp_path_factory.mktemp("evidence")))
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    app = create_app(settings, keys)
    db: Session = app.state.session_factory()

    rabat, casa = City(name="Rabat", region="RSK"), City(name="Casablanca", region="CS")
    db.add_all([rabat, casa])
    db.flush()
    admin = add_user(db, "admin1", "admin")
    analyst = add_user(db, "analyst1", "analyst", [rabat.id])
    other = add_user(db, "analyst2", "analyst", [casa.id])
    auditor = add_user(db, "auditor1", "auditor")
    cam_r = Camera(city_id=rabat.id, name="gate", kind="anpr_camera", latitude=34, longitude=-6.8, protocol="rtsps", status="online",
                   street_address="Avenue Mohammed V", view_direction_deg=90)
    cam_c = Camera(city_id=casa.id, name="quay", kind="anpr_camera", latitude=33.6, longitude=-7.6, protocol="rtsps", status="offline")
    wl = WatchlistList(name="Stolen", source="test", created_by=admin)
    db.add_all([cam_r, cam_c, wl])
    db.flush()
    now = datetime.now(UTC)
    ids = {}
    for key, cam, plate in (("rabat", cam_r, PLATE_RABAT), ("casa", cam_c, PLATE_CASA)):
        entry = WatchlistEntry(list_id=wl.id, plate_canonical=plate, reason="stolen", case_ref=f"CASE-{key}")
        det = DetectionEvent(camera_id=cam.id, observed_at=now - timedelta(seconds=2), received_at=now, source_kind="video",
                             plate_raw=plate.replace("|", ""), plate_canonical=plate,
                             char_confidences=[0.99] * len(plate.replace("|", "")), plate_confidence=0.97,
                             evidence_sha256=FRAME_SHA if key == "rabat" else "a" * 64)
        db.add_all([entry, det])
        db.flush()
        if key == "rabat":
            frame = evidence_path(Path(settings.evidence_dir), FRAME_SHA, det.observed_at)
            frame.parent.mkdir(parents=True)
            frame.write_bytes(FRAME)
        alert = Alert(detection_id=det.id, entry_id=entry.id, kind="full_match", score=1.0)
        db.add(alert)
        db.flush()
        ids[key] = str(alert.id)
    db.commit()
    yield {"client": TestClient(app), "db": db, "keys": keys, "ids": ids, "app": app, "frame": frame,
           "as": {"admin": cookie(settings, admin), "analyst": cookie(settings, analyst), "other": cookie(settings, other),
                  "auditor": cookie(settings, auditor), "anonymous": {}}}
    db.close()
    app.state.engine.dispose()


def test_alerts_are_city_scoped(env):
    c, ids = env["client"], env["ids"]
    mine = c.get("/api/v1/alerts", headers=env["as"]["analyst"]).json()
    assert [a["id"] for a in mine] == [ids["rabat"]]
    assert c.get(f"/api/v1/alerts/{ids['casa']}", headers=env["as"]["analyst"]).status_code == 404
    assert {a["id"] for a in c.get("/api/v1/alerts", headers=env["as"]["admin"]).json()} == set(ids.values())
    assert c.get("/api/v1/alerts", headers=env["as"]["anonymous"]).status_code == 401


def test_reviewers_see_the_plate_others_get_it_masked(env):
    c, rid = env["client"], env["ids"]["rabat"]
    analyst = c.get(f"/api/v1/alerts/{rid}", headers=env["as"]["analyst"]).json()
    assert analyst["plate"] == PLATE_RABAT and analyst["plateMasked"] is False
    assert len(analyst["chars"]) == 7 and analyst["watchlistEntry"]["plate"] == PLATE_RABAT
    for role in ("auditor", "admin"):
        r = c.get(f"/api/v1/alerts/{rid}", headers=env["as"][role])
        assert r.status_code == 200
        out = r.json()
        assert out["plateMasked"] is True and "12345" not in r.text and out["chars"] == []


def test_review_needs_a_justification_and_the_right_role(env):
    c, rid = env["client"], env["ids"]["rabat"]
    assert c.post(f"/api/v1/alerts/{rid}/review", json={"action": "approve", "justification": "ok"}, headers=env["as"]["analyst"]).status_code == 422
    for role in ("admin", "auditor"):
        assert c.post(f"/api/v1/alerts/{rid}/review", json={"action": "approve", "justification": WHY}, headers=env["as"][role]).status_code == 403
    assert c.post(f"/api/v1/alerts/{env['ids']['casa']}/review", json={"action": "approve", "justification": WHY},
                  headers=env["as"]["analyst"]).status_code == 404


def test_a_human_decides_once_and_it_is_audited(env):
    c, rid = env["client"], env["ids"]["rabat"]
    r = c.post(f"/api/v1/alerts/{rid}/review", json={"action": "approve", "justification": WHY}, headers=env["as"]["analyst"])
    assert r.status_code == 200
    out = r.json()
    assert out["status"] == "approved" and out["decision"]["reviewer"] == "analyst1" and out["decision"]["justification"] == WHY
    again = c.post(f"/api/v1/alerts/{rid}/review", json={"action": "reject", "justification": WHY}, headers=env["as"]["analyst"])
    assert again.status_code == 409
    with Session(env["app"].state.engine) as db:
        entry = db.scalars(select(AuditEntry).where(AuditEntry.action == "alert.approve", AuditEntry.target_id == rid)).one()
        assert entry.justification == WHY
        assert db.get(Alert, uuid.UUID(rid)).status == "approved"
        assert audit_chain.verify(db, env["keys"].audit_signing_key().public_key()).ok


def test_overview_counts_real_rows_and_is_scoped(env):
    c = env["client"]
    admin = c.get("/api/v1/overview", headers=env["as"]["admin"]).json()
    assert admin["platesToday"] == 2 and admin["watchlistHitsToday"] == 2 and admin["totalCameras"] == 2
    assert admin["activeCameras"] == 1
    assert admin["avgLatencyMs"] == pytest.approx(2000, abs=50)
    assert len(admin["daily"]) == 14 and len(admin["hourly"]) == 24
    assert sum(h["reads"] for h in admin["hourly"]) == 2 and admin["daily"][-1]["reads"] == 2
    assert admin["integrity"]["ok"] is True

    other = c.get("/api/v1/overview", headers=env["as"]["other"]).json()
    assert other["platesToday"] == 1 and other["totalCameras"] == 1 and other["activeCameras"] == 0
    assert other["integrity"] is None  # analysts cannot verify the audit chain

    auditor = c.get("/api/v1/overview", headers=env["as"]["auditor"]).json()
    assert auditor["integrity"]["ok"] is True


def _audited(env, action: str, alert_id: str) -> int:
    env["db"].expire_all()
    return len(env["db"].scalars(select(AuditEntry).where(AuditEntry.action == action,
                                                         AuditEntry.target_id == alert_id)).all())


def test_alerts_carry_the_camera_location(env):
    a = env["client"].get(f"/api/v1/alerts/{env['ids']['rabat']}", headers=env["as"]["analyst"]).json()
    assert (a["cameraAddress"], a["cameraLatitude"], a["cameraLongitude"], a["cameraViewDeg"]) ==         ("Avenue Mohammed V", 34, -6.8, 90)


def test_the_reviewer_sees_the_captured_frame_and_the_view_is_audited(env):
    c, alert_id = env["client"], env["ids"]["rabat"]
    before = _audited(env, "evidence.view", alert_id)
    r = c.get(f"/api/v1/alerts/{alert_id}/evidence", headers=env["as"]["analyst"])
    assert r.status_code == 200 and r.content == FRAME
    assert r.headers["content-type"] == "image/jpeg" and r.headers["cache-control"] == "no-store"
    assert r.headers["x-evidence-sha256"] == FRAME_SHA
    assert _audited(env, "evidence.view", alert_id) == before + 1


def test_evidence_follows_scope_and_roles(env):
    c, ids = env["client"], env["ids"]
    assert c.get(f"/api/v1/alerts/{ids['rabat']}/evidence", headers=env["as"]["other"]).status_code == 404
    assert c.get(f"/api/v1/alerts/{ids['rabat']}/evidence", headers=env["as"]["anonymous"]).status_code == 401
    for role in ("admin", "auditor"):  # evidence.read
        assert c.get(f"/api/v1/alerts/{ids['rabat']}/evidence", headers=env["as"][role]).status_code == 200


def test_a_missing_frame_is_a_clear_404(env):
    r = env["client"].get(f"/api/v1/alerts/{env['ids']['casa']}/evidence", headers=env["as"]["admin"])
    assert r.status_code == 404 and "retention" in r.json()["detail"]


def test_a_tampered_frame_is_refused_and_audited(env):
    c, alert_id, frame = env["client"], env["ids"]["rabat"], env["frame"]
    frame.write_bytes(FRAME + b"edited")
    try:
        r = c.get(f"/api/v1/alerts/{alert_id}/evidence", headers=env["as"]["analyst"])
        assert r.status_code == 409 and "hash" in r.json()["detail"]
        assert _audited(env, "evidence.mismatch", alert_id) == 1
    finally:
        frame.write_bytes(FRAME)
