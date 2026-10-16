"""POST /admin/detections/purge: who may clear the detection history, what goes and what stays."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pg_support import add_user, cookie, make_settings, migrate_fresh, requires_pg
from sqlalchemy import func, select
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

URL = "/api/v1/admin/detections/purge"
WHY = "Resetting the test data after the webcam demo session."


@pytest.fixture
def env(tmp_path):
    migrate_fresh()
    settings = make_settings(evidence_dir=str(tmp_path / "evidence"))
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    app = create_app(settings, keys)
    db: Session = app.state.session_factory()
    city = City(name="Rabat", region="RSK")
    db.add(city)
    db.flush()
    admin = add_user(db, "admin1", "admin")
    analyst = add_user(db, "analyst1", "analyst", [city.id])
    auditor = add_user(db, "auditor1", "auditor")
    cam = Camera(city_id=city.id, name="gate", kind="anpr_camera", latitude=34, longitude=-6.8, protocol="file", status="online")
    wl = WatchlistList(name="Stolen", source="test", created_by=admin)
    db.add_all([cam, wl])
    db.flush()
    entry = WatchlistEntry(list_id=wl.id, plate_canonical="12345|أ|6", reason="stolen")
    db.add(entry)
    db.flush()

    now = datetime.now(UTC)
    frames = {}

    def read(name: str, status: str | None, sha: str | None = None) -> DetectionEvent:
        det = DetectionEvent(camera_id=cam.id, observed_at=now - timedelta(minutes=1), received_at=now, source_kind="video",
                             plate_raw="12345أ6", plate_canonical="12345|أ|6", char_confidences=[0.9] * 7, plate_confidence=0.9,
                             evidence_sha256=sha)
        db.add(det)
        db.flush()
        if sha:
            path = evidence_path(Path(settings.evidence_dir), sha, det.observed_at)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"jpeg")
            frames[name] = path
        if status:
            db.add(Alert(detection_id=det.id, entry_id=entry.id, kind="full_match", score=1.0, status=status,
                         reviewed_by=None if status == "pending" else admin,
                         reviewed_at=None if status == "pending" else now, justification=None if status == "pending" else WHY))
        return det

    read("plain", None)
    read("decided", "approved", "a" * 64)
    read("pending", "pending", "b" * 64)
    db.commit()
    yield {"client": TestClient(app), "db": db, "keys": keys, "frames": frames,
           "as": {"admin": cookie(settings, admin), "analyst": cookie(settings, analyst), "auditor": cookie(settings, auditor)}}
    db.close()


def _count(db, model) -> int:
    db.expire_all()
    return db.scalar(select(func.count()).select_from(model))


@pytest.mark.parametrize("role", ["analyst", "auditor"])
def test_only_admins_may_purge(env, role):
    r = env["client"].post(URL, json={"justification": WHY}, headers=env["as"][role])
    assert r.status_code == 403
    assert _count(env["db"], DetectionEvent) == 3


def test_justification_is_required(env):
    r = env["client"].post(URL, json={"justification": "reset"}, headers=env["as"]["admin"])
    assert r.status_code == 422
    assert _count(env["db"], DetectionEvent) == 3


def test_purge_keeps_pending_alerts_and_the_audit_log(env):
    db = env["db"]
    audit_before = _count(db, AuditEntry)
    r = env["client"].post(URL, json={"justification": WHY}, headers=env["as"]["admin"])
    assert r.status_code == 200, r.text
    assert r.json() == {"detections": 2, "alerts": 1, "evidenceFiles": 1, "keptPending": 1}

    assert _count(db, DetectionEvent) == 1
    assert db.scalar(select(Alert.status)) == "pending"
    assert not env["frames"]["decided"].exists()
    assert env["frames"]["pending"].exists()  # the undecided alert keeps its evidence

    # the purge is itself audited, and the chain still verifies
    assert _count(db, AuditEntry) == audit_before + 1
    last = db.scalars(select(AuditEntry).order_by(AuditEntry.seq.desc())).first()
    assert last.action == "detections.purge" and WHY in last.justification and "1 pending alerts kept" in last.justification
    assert audit_chain.verify(db, env["keys"].audit_signing_key().public_key()).ok


def test_include_pending_clears_everything(env):
    r = env["client"].post(URL, json={"justification": WHY, "includePending": True}, headers=env["as"]["admin"])
    assert r.json() == {"detections": 3, "alerts": 2, "evidenceFiles": 2, "keptPending": 0}
    assert _count(env["db"], DetectionEvent) == 0 and _count(env["db"], Alert) == 0
    assert not any(p.exists() for p in env["frames"].values())


def test_unknown_fields_are_refused(env):
    r = env["client"].post(URL, json={"justification": WHY, "before": str(uuid.uuid4())}, headers=env["as"]["admin"])
    assert r.status_code == 422
