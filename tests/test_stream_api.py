"""Network-camera video relay: the API opens the RTSP stream with the stored credentials and serves
MJPEG to signed-in operators. No real camera: OpenCV's capture is replaced by a fake that yields
synthetic frames, and the detector is a fake, so plate reads go through the real ingest."""

import json
import time
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pg_support import add_user, cookie, make_settings, migrate_fresh, requires_pg
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.main import create_app
from anpr.api.routes import admin as admin_routes
from anpr.api.routes import stream as stream_routes
from anpr.api.services import stream_relay
from anpr.api.services.stream_relay import StreamRefused, build_target, draw_boxes
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
from anpr.security import crypto
from anpr.security.keys import EnvKeyProvider

STOLEN = "12345|أ|6"


# --- target building: no database ------------------------------------------------------------

class Keys:
    """Minimal key provider for crypto.encrypt/decrypt."""

    def active_key_id(self):
        return "k1"

    def data_key(self, key_id):
        return b"k" * 32


def camera(**over) -> Camera:
    base = {"id": uuid.uuid4(), "name": "Sale", "protocol": "rtsp", "host": "192.168.1.10", "port": 554,
                "stream_path": "/channel=1_stream=0.sdp?real_stream", "credentials_encrypted": None, "credentials_key_id": None}
    base.update(over)
    return Camera(**base)


def with_credentials(cam: Camera, keys, username="admin", password="p@ss:w/rd#1") -> Camera:
    plaintext = json.dumps({"username": username, "password": password}).encode()
    cam.credentials_encrypted, cam.credentials_key_id = crypto.encrypt(
        keys, plaintext, purpose=stream_relay.CREDENTIALS_PURPOSE, row_id=str(cam.id))
    return cam


def fixed(*addresses):
    return lambda host, port: list(addresses)


def test_the_purpose_label_matches_the_one_credentials_are_encrypted_with():
    assert stream_relay.CREDENTIALS_PURPOSE == admin_routes.CREDENTIALS_PURPOSE


def test_credentials_are_url_encoded_and_never_in_the_label():
    keys = Keys()
    t = build_target(with_credentials(camera(), keys), keys, resolver=fixed("192.168.1.10"))
    assert t.url == "rtsp://admin:p%40ss%3Aw%2Frd%231@192.168.1.10:554/channel=1_stream=0.sdp?real_stream"
    assert t.label == "rtsp://192.168.1.10:554"


def test_ffmpeg_connects_to_the_checked_ip_not_the_host_name():
    t = build_target(camera(host="cam.example"), Keys(), resolver=fixed("10.0.0.7"))
    assert t.url.startswith("rtsp://10.0.0.7:554/")


@pytest.mark.parametrize("address", ["127.0.0.1", "169.254.169.254", "::1"])
def test_ssrf_policy_refuses_internal_addresses(address):
    with pytest.raises(StreamRefused, match="Refused"):
        build_target(camera(host="evil.example"), Keys(), resolver=fixed("192.168.1.10", address))


@pytest.mark.parametrize("protocol", ["file", "webhook", "mqtt", "onvif"])
def test_only_rtsp_and_rtsps_are_streamed(protocol):
    with pytest.raises(StreamRefused):
        build_target(camera(protocol=protocol), Keys(), resolver=fixed("192.168.1.10"))


@pytest.mark.parametrize("path", ["/a b", "/x\n", "/\x00"])
def test_stream_path_with_spaces_or_control_characters_is_refused(path):
    with pytest.raises(StreamRefused, match="characters"):
        build_target(camera(stream_path=path), Keys(), resolver=fixed("192.168.1.10"))


def test_default_port_and_path():
    t = build_target(camera(protocol="rtsps", port=None, stream_path=None), Keys(), resolver=fixed("192.168.1.10"))
    assert t.url == "rtsps://192.168.1.10:322/"


def test_boxes_are_drawn_even_with_an_arabic_letter():
    frame = np.zeros((90, 160, 3), np.uint8)
    draw_boxes(frame, [((0.1, 0.4, 0.5, 0.2), STOLEN, True), ((0.6, 0.1, 0.2, 0.1), None, False)])
    assert frame.any()


# --- API: needs PostgreSQL --------------------------------------------------------------------

class FakeCapture:
    def __init__(self, url):
        self.url = url

    def isOpened(self):
        return True

    def read(self):
        time.sleep(0.02)
        return True, np.full((360, 640, 3), 80, np.uint8)

    def release(self):
        pass


class FakeDetector:
    reads_plates = True
    version = "fake"

    def __init__(self):
        self.plates: list[str] = []

    def detect(self, frame):
        chars = lambda p: tuple((c, 0.97) for c in p if c != "|")
        return [Found((0.4, 0.5, 0.2, 0.08), 0.9, p, 0.97, chars(p)) for p in self.plates]


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
    cctv = Camera(city_id=rabat.id, name="Sale", kind="fixed_cctv", latitude=34, longitude=-6.8, protocol="rtsp",
                  host="192.168.1.10", port=554, stream_path="/live")
    webcam = Camera(city_id=rabat.id, name="PC webcam", kind="fixed_cctv", latitude=34, longitude=-6.8, protocol="file")
    far = Camera(city_id=casa.id, name="casa cctv", kind="fixed_cctv", latitude=33, longitude=-7.6, protocol="rtsp",
                 host="192.168.1.11")
    wl = WatchlistList(name="Stolen", source="test", created_by=admin)
    db.add_all([cctv, webcam, far, wl])
    db.flush()
    db.add(WatchlistEntry(list_id=wl.id, plate_canonical=STOLEN, reason="stolen", case_ref="CASE-1"))
    db.commit()
    yield {"c": TestClient(app), "app": app, "db": db, "det": detector,
           "cctv": str(cctv.id), "webcam": str(webcam.id), "far": str(far.id),
           "as": {"admin": cookie(settings, admin), "analyst": cookie(settings, analyst), "auditor": cookie(settings, auditor)}}
    for feed_id in (cctv.id, far.id):
        app.state.streams.stop(feed_id)
    db.close()
    app.state.engine.dispose()


@pytest.fixture
def fake_camera(monkeypatch):
    opened: list[str] = []

    def open_capture(url):
        opened.append(url)
        return FakeCapture(url)

    monkeypatch.setattr(stream_relay, "open_capture", open_capture)
    monkeypatch.setattr(stream_routes, "MAX_VIEW_SECONDS", 1.5)
    return opened


def first_frame(env, role, camera) -> tuple[int, bytes]:
    with env["c"].stream("GET", f"/api/v1/cameras/{camera}/stream.mjpg", headers=env["as"][role]) as r:
        if r.status_code != 200:
            r.read()
            return r.status_code, r.content
        assert r.headers["content-type"].startswith("multipart/x-mixed-replace")
        body = b""
        for chunk in r.iter_bytes():
            body += chunk
            if b"\xff\xd9" in body:  # end of the first JPEG
                break
        return 200, body


@requires_pg
def test_an_analyst_watches_a_network_camera_in_their_city_and_it_is_audited(env, fake_camera):
    status, body = first_frame(env, "analyst", env["cctv"])
    assert status == 200
    assert b"Content-Type: image/jpeg" in body and b"\xff\xd8" in body
    assert fake_camera[-1].startswith("rtsp://192.168.1.10:554/live")
    env["db"].expire_all()
    entry = env["db"].scalars(select(AuditEntry).where(AuditEntry.action == "camera.stream.view")
                              .order_by(AuditEntry.seq.desc())).first()
    assert entry is not None and entry.target_id == env["cctv"]
    state = env["c"].get(f"/api/v1/cameras/{env['cctv']}/stream", headers=env["as"]["analyst"]).json()
    assert state["state"] == "live" and state["width"] == 640


@requires_pg
@pytest.mark.parametrize(("role", "camera", "code"), [
    ("analyst", "far", 404),      # outside the analyst's cities
    ("auditor", "cctv", 403),     # auditors do not watch live video
    ("admin", "webcam", 409),     # a local webcam has no server-side stream
])
def test_who_may_watch_what(env, fake_camera, role, camera, code):
    status, _ = first_frame(env, role, env[camera])
    assert status == code


@requires_pg
def test_a_stolen_plate_seen_by_the_network_camera_opens_a_pending_alert(env, fake_camera):
    env["det"].plates = [STOLEN]
    try:
        first_frame(env, "admin", env["cctv"])
        deadline = time.monotonic() + 5
        alert = None
        while time.monotonic() < deadline and alert is None:
            env["db"].expire_all()
            alert = env["db"].scalars(select(Alert).join(DetectionEvent, DetectionEvent.id == Alert.detection_id)
                                      .where(DetectionEvent.camera_id == uuid.UUID(env["cctv"]))).first()
            time.sleep(0.1)
    finally:
        env["det"].plates = []
    assert alert is not None and alert.status == "pending"
    read = env["db"].get(DetectionEvent, alert.detection_id)
    assert read.plate_canonical == STOLEN and read.evidence_sha256  # the frame is kept as evidence


@requires_pg
def test_replacing_credentials_restarts_the_feed_with_the_new_ones(env, fake_camera):
    first_frame(env, "admin", env["cctv"])
    feed = env["app"].state.streams.get(uuid.UUID(env["cctv"]))
    assert feed is not None
    r = env["c"].put(f"/api/v1/admin/cameras/{env['cctv']}/credentials", headers=env["as"]["admin"],
                     json={"username": "viewer", "password": "n3w-Secret!"})
    assert r.status_code == 204, r.text
    assert feed.closed
    first_frame(env, "admin", env["cctv"])
    assert fake_camera[-1].startswith("rtsp://viewer:n3w-Secret%21@192.168.1.10:554/")
    assert "n3w-Secret" not in env["c"].get(f"/api/v1/cameras/{env['cctv']}", headers=env["as"]["admin"]).text
