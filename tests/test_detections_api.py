"""POST /api/v1/detections on PostgreSQL: service-token auth, watchlist matching into pending
alerts, repeat suppression, maintenance cameras, camera liveness, and audit without plates."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pg_support import add_user, cookie, make_settings, migrate_fresh, requires_pg
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.main import create_app
from anpr.db.models import (
    AuditEntry,
    Camera,
    CameraStatusEvent,
    City,
    DetectionEvent,
    WatchlistEntry,
    WatchlistList,
)
from anpr.security import audit_chain
from anpr.security.keys import EnvKeyProvider

pytestmark = requires_pg

TOKEN = "test-detection-token-0123456789abcdef"
LISTED = "12345|أ|6"


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
    admin = add_user(db, "admin1", "admin")
    analyst = add_user(db, "analyst1", "analyst", [city.id])
    wl = WatchlistList(name="Stolen", source="test", created_by=admin)
    db.add(wl)
    db.flush()
    db.add_all([
        WatchlistEntry(list_id=wl.id, plate_canonical=LISTED, reason="stolen", color="white"),
        WatchlistEntry(list_id=wl.id, plate_canonical="555|ب|1", reason="wanted", removed_at=datetime.now(UTC)),
        WatchlistEntry(list_id=wl.id, plate_canonical="666|ب|1", reason="wanted", expires_at=datetime.now(UTC) - timedelta(days=1)),
    ])
    db.commit()
    yield {"client": TestClient(app), "app": app, "db": db, "keys": keys, "city": city.id,
           "admin": cookie(settings, admin), "analyst": cookie(settings, analyst)}
    db.close()
    app.state.engine.dispose()


def camera(env, status="unknown") -> str:
    cam = Camera(city_id=env["city"], name=f"cam-{uuid.uuid4().hex[:6]}", kind="anpr_camera", latitude=34, longitude=-6.8,
                 protocol="rtsps", status=status)
    env["db"].add(cam)
    env["db"].commit()
    return str(cam.id)


def send(env, cam: str, plate: str, confidence=0.97, chars=None, token=TOKEN, **extra):
    n = len([c for c in plate if c != "|"])
    body = {"cameraId": cam, "observedAt": datetime.now(UTC).isoformat(), "sourceKind": "video", "plateRaw": plate,
            "plateConfidence": confidence, "charConfidences": chars or [confidence] * n, **extra}
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return env["client"].post("/api/v1/detections", json=body, headers=headers)


def test_only_the_detection_service_token_is_accepted(env):
    cam = camera(env)
    assert send(env, cam, LISTED, token=None).status_code == 401
    assert send(env, cam, LISTED, token="wrong-token").status_code == 401
    r = env["client"].post("/api/v1/detections", json={}, headers=env["admin"])  # a user session is not enough
    assert r.status_code == 401
    # and the service token opens no user route
    assert env["client"].get("/api/v1/cameras", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401


def test_unknown_camera_and_future_timestamps_are_refused(env):
    assert send(env, str(uuid.uuid4()), LISTED).status_code == 404
    r = send(env, camera(env), LISTED, observedAt=(datetime.now(UTC) + timedelta(hours=1)).isoformat())
    assert r.status_code == 422


def test_a_read_not_on_any_watchlist_is_stored_and_marks_the_camera_online(env):
    cam = camera(env)
    r = send(env, cam, "4321|د|7")
    assert r.status_code == 201
    assert r.json()["plateValid"] is True and r.json()["alertsCreated"] == 0
    env["db"].expire_all()
    row = env["db"].get(Camera, uuid.UUID(cam))
    assert row.status == "online" and row.last_frame_at is not None
    assert env["db"].scalars(select(CameraStatusEvent.reason).where(CameraStatusEvent.camera_id == row.id)).all() == ["reads arriving"]


def test_invalid_plate_text_is_kept_but_flagged(env):
    r = send(env, camera(env), "XX-??")
    assert r.status_code == 201 and r.json()["plateValid"] is False and r.json()["alertsCreated"] == 0


def test_a_listed_plate_opens_one_pending_alert_and_repeats_are_suppressed(env):
    cam = camera(env)
    first = send(env, cam, LISTED, observedColor="white")
    assert first.status_code == 201 and first.json()["alertsCreated"] == 1
    assert send(env, cam, LISTED).json()["alertsCreated"] == 0  # same car, same camera, still pending
    alerts = env["client"].get("/api/v1/alerts?status=pending", headers=env["analyst"]).json()
    mine = [a for a in alerts if a["cameraId"] == cam]
    assert len(mine) == 1 and mine[0]["kind"] == "full_match" and mine[0]["plate"] == LISTED
    # another camera is a separate sighting
    assert send(env, camera(env), LISTED).json()["alertsCreated"] == 1


def test_attribute_mismatch_and_fuzzy_reads(env):
    cam = camera(env)
    clone = send(env, cam, LISTED, observedColor="red")
    assert clone.json()["alertsCreated"] == 1
    kinds = {a["kind"] for a in env["client"].get("/api/v1/alerts", headers=env["analyst"]).json() if a["cameraId"] == cam}
    assert kinds == {"plate_only_mismatch_vehicle"}
    # one digit differs: an alert only when that digit was a low-confidence OCR character
    chars = [0.99, 0.99, 0.99, 0.99, 0.30, 0.99, 0.99]
    assert send(env, camera(env), "12348|أ|6", confidence=0.9, chars=chars).json()["alertsCreated"] == 1
    assert send(env, camera(env), "12348|أ|6", confidence=0.99, chars=[0.99] * 7).json()["alertsCreated"] == 0


def test_removed_or_expired_entries_and_maintenance_cameras_raise_nothing(env):
    assert send(env, camera(env), "555|ب|1").json()["alertsCreated"] == 0
    assert send(env, camera(env), "666|ب|1").json()["alertsCreated"] == 0
    cam = camera(env, status="maintenance")
    assert send(env, cam, LISTED).json()["alertsCreated"] == 0
    env["db"].expire_all()
    assert env["db"].get(Camera, uuid.UUID(cam)).status == "maintenance"  # not flipped to online


def test_alerts_are_audited_without_the_plate_and_the_chain_holds(env):
    with Session(env["app"].state.engine) as db:
        entries = db.scalars(select(AuditEntry).where(AuditEntry.action == "alert.create")).all()
        assert entries and all(e.actor_role == "service" for e in entries)
        assert not any("12345" in (e.justification or "") for e in entries)
        assert db.scalar(select(DetectionEvent.id).limit(1)) is not None
        assert audit_chain.verify(db, env["keys"].audit_signing_key().public_key()).ok


def test_the_plate_box_is_kept_and_must_lie_inside_the_frame(env):
    cam = camera(env)
    r = send(env, cam, "4321|ب|9", evidenceSha256="b" * 64, plateBox=[0.1, 0.6, 0.25, 0.1])
    assert r.status_code == 201, r.text
    assert env["db"].get(DetectionEvent, uuid.UUID(r.json()["id"])).plate_box == [0.1, 0.6, 0.25, 0.1]
    for bad in ([0.9, 0.5, 0.2, 0.1], [0.1, 0.1, 0, 0.1], [0.1, 0.1, 0.2], [-0.1, 0.1, 0.2, 0.1]):
        assert send(env, cam, "4321|ب|9", plateBox=bad).status_code == 422
