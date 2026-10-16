"""Live monitoring: a webcam frame from the browser -> detector -> the shared ingest -> a pending
alert for a watchlist plate. The detector is a fake so the test needs no model weights."""

import io
import uuid
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from pg_support import add_user, cookie, make_settings, migrate_fresh, requires_pg
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.main import create_app
from anpr.db.models import (
    Alert,
    AuditEntry,
    Camera,
    City,
    DetectionEvent,
    WatchlistEntry,
    WatchlistList,
)
from anpr.pipeline.live import Found
from anpr.security.keys import EnvKeyProvider

pytestmark = requires_pg

STOLEN = "12345|أ|6"


class FakeDetector:
    reads_plates = True
    version = "fake"

    def __init__(self):
        self.plates: list[str | None] = []

    def detect(self, frame):
        chars = lambda p: tuple((c, 0.97) for c in p if c != "|")
        return [Found((0.4, 0.5, 0.2, 0.08), 0.9, p, 0.97, chars(p) if p else ()) for p in self.plates]


def jpeg() -> bytes:
    _, buf = cv2.imencode(".jpg", np.full((120, 160, 3), 90, np.uint8))
    return buf.tobytes()


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    migrate_fresh()
    settings = make_settings(evidence_dir=str(tmp_path_factory.mktemp("evidence")))
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    detector = FakeDetector()
    app = create_app(settings, keys, detector=detector)
    db: Session = app.state.session_factory()
    rabat, casa = City(name="Rabat", region="R"), City(name="Casablanca", region="C")
    db.add_all([rabat, casa])
    db.flush()
    admin = add_user(db, "admin1", "admin")
    analyst = add_user(db, "analyst1", "analyst", [rabat.id])
    auditor = add_user(db, "auditor1", "auditor")
    webcam = Camera(city_id=rabat.id, name="PC webcam", kind="fixed_cctv", latitude=34, longitude=-6.8, protocol="file")
    street = Camera(city_id=rabat.id, name="street", kind="anpr_camera", latitude=34, longitude=-6.8, protocol="rtsps")
    far = Camera(city_id=casa.id, name="casa webcam", kind="fixed_cctv", latitude=33, longitude=-7.6, protocol="file")
    wl = WatchlistList(name="Stolen", source="test", created_by=admin)
    db.add_all([webcam, street, far, wl])
    db.flush()
    db.add(WatchlistEntry(list_id=wl.id, plate_canonical=STOLEN, reason="stolen", case_ref="CASE-1"))
    db.commit()
    yield {"c": TestClient(app), "app": app, "db": db, "det": detector, "settings": settings,
           "webcam": str(webcam.id), "street": str(street.id), "far": str(far.id),
           "as": {"admin": cookie(settings, admin), "analyst": cookie(settings, analyst), "auditor": cookie(settings, auditor)}}
    db.close()
    app.state.engine.dispose()


def send(env, role, camera):
    return env["c"].post(f"/api/v1/cameras/{camera}/frames", headers=env["as"][role],
                         files={"file": ("frame.jpg", io.BytesIO(jpeg()), "image/jpeg")})


def test_a_stolen_plate_on_the_webcam_opens_an_alert_at_once(env):
    env["det"].plates = [STOLEN]
    r = send(env, "analyst", env["webcam"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["boxes"][0]["plate"] == STOLEN and out["boxes"][0]["reported"] is True and out["boxes"][0]["plateValid"]
    assert len(out["alerts"]) == 1 and out["alerts"][0]["reason"] == "stolen"
    pending = env["c"].get("/api/v1/alerts?status=pending", headers=env["as"]["analyst"]).json()
    assert [a["id"] for a in pending] == [out["alerts"][0]["id"]]
    assert pending[0]["plateBox"] == [0.4, 0.5, 0.2, 0.08]
    with Session(env["app"].state.engine) as db:
        det = db.get(DetectionEvent, db.get(Alert, uuid.UUID(out["alerts"][0]["id"])).detection_id)
        assert det.evidence_sha256 and len(det.evidence_sha256) == 64
        assert det.plate_box == [0.4, 0.5, 0.2, 0.08]  # where the plate is in the evidence frame
        assert db.scalars(select(AuditEntry).where(AuditEntry.action == "alert.create")).first().actor_role == "analyst"
    files = list(Path(env["settings"].evidence_dir).rglob("*.jpg"))
    assert len(files) == 1  # the frame that produced the report is the evidence


def test_the_same_plate_is_not_reported_again_within_seconds(env):
    env["det"].plates = [STOLEN]
    out = send(env, "analyst", env["webcam"]).json()
    assert out["boxes"][0]["reported"] is False and out["alerts"] == []


def test_plain_reads_and_unreadable_boxes(env):
    env["det"].plates = ["4321|د|7", None, "garbage"]
    boxes = send(env, "analyst", env["webcam"]).json()["boxes"]
    assert [b["plateValid"] for b in boxes] == [True, False, False]
    assert boxes[1]["plate"] is None and boxes[1]["reported"] is False


def test_non_reviewers_see_masked_plates(env):
    env["det"].plates = ["55555|ب|1"]
    out = send(env, "admin", env["webcam"]).json()
    assert out["boxes"][0]["plateMasked"] is True and "55555" not in str(out)


def test_only_local_sources_in_your_cities_and_the_right_roles(env):
    env["det"].plates = []
    assert send(env, "analyst", env["street"]).status_code == 409  # networked camera: no browser frames
    assert send(env, "analyst", env["far"]).status_code == 404     # other city
    assert send(env, "auditor", env["webcam"]).status_code == 403
    bad = env["c"].post(f"/api/v1/cameras/{env['webcam']}/frames", headers=env["as"]["analyst"],
                        files={"file": ("x.jpg", io.BytesIO(b"not an image"), "image/jpeg")})
    assert bad.status_code == 422


def test_missing_model_is_a_clear_503(env):
    class Broken(FakeDetector):
        def detect(self, frame):
            raise FileNotFoundError("weights")

    app = create_app(env["settings"], env["app"].state.keys, detector=Broken())
    try:
        r = TestClient(app).post(f"/api/v1/cameras/{env['webcam']}/frames", headers=env["as"]["analyst"],
                                 files={"file": ("f.jpg", io.BytesIO(jpeg()), "image/jpeg")})
        assert r.status_code == 503 and "model" in r.json()["detail"]
    finally:
        app.state.engine.dispose()
