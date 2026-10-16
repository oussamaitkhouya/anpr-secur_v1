"""Operational API (anpr.api.operations): RBAC, city scoping, watchlists, live frames -> pending
alerts, evidence chain, search masking, and parity of the permission map with the dashboard."""

import base64
import importlib.util
import json
import re

import cv2
import numpy as np
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)
from fastapi.testclient import TestClient

from anpr.api.app import create_app
from anpr.db import create_super_admin
from anpr.pipeline import watchlist_csv
from anpr.pipeline.live import Found
from anpr.security import evidence
from anpr.security.audit import GENESIS, link_hash
from anpr.security.permissions import PERMISSIONS
from anpr.utils.config import REPO_ROOT

ROOT_PW = "correct horse battery staple"
GOOD_PW = "a-long-enough-test-pass"
PLATE = "12345|ب|6"  # test plate; the tests never use real registrations
CSV = f"plate,reason,caseRef,source,expiresAt\n{PLATE},stolen,CASE-1,Test desk,\n7305|د|41,wanted,CASE-2,Test desk,2999-01-01\n"


class FakeDetector:
    """Stands in for YOLO + CRNN: returns whatever the test sets in `next`."""

    def __init__(self, reads_plates=True):
        self.reads_plates = reads_plates
        self.version = "yolo:test/last.pt + crnn:test/best.pt" if reads_plates else "yolo:test/last.pt"
        self.next: list[Found] = []

    def detect(self, _frame):
        return self.next

    def ocr_metrics(self):
        return {"plate_acc": 0.5} if self.reads_plates else None


def _init_db():
    spec = importlib.util.spec_from_file_location("init_db", REPO_ROOT / "scripts" / "init_db.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.main


def jpeg() -> bytes:
    ok, buf = cv2.imencode(".jpg", np.zeros((48, 64, 3), np.uint8))
    assert ok
    return buf.tobytes()


@pytest.fixture
def signing_key(monkeypatch):
    raw = Ed25519PrivateKey.generate().private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    monkeypatch.setenv("AUDIT_SIGNING_KEY", base64.b64encode(raw).decode())
    evidence.signing_key.cache_clear()
    yield
    evidence.signing_key.cache_clear()


@pytest.fixture
def db_file(tmp_path):
    path = tmp_path / "ops.sqlite3"
    answers = iter([ROOT_PW, ROOT_PW])
    assert create_super_admin.main(["--username", "root", "--db", str(path)], read_password=lambda _: next(answers)) == 0
    assert _init_db()(["--db", str(path), "--city", "rabat:Rabat", "--city", "fes:Fes", "--watchlist", "Stolen"]) == 0
    return path


@pytest.fixture
def detector():
    return FakeDetector()


@pytest.fixture
def client(db_file, detector, signing_key):
    return TestClient(create_app(db_file, detector=detector))


def sign_in(client, username, password):
    r = client.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def root(client):
    return sign_in(client, "root", ROOT_PW)


def make_user(client, headers, username, role, cities=()):
    r = client.post("/users", headers=headers, json={"username": username, "name": username, "role": role,
                                                      "password": GOOD_PW, "allowedCityIds": list(cities)})
    assert r.status_code == 201, r.text
    return sign_in(client, username, GOOD_PW)


def webcam(client, headers, city="rabat", name="Desk webcam"):
    r = client.post("/cameras", headers=headers, json={"cityId": city, "name": name, "sourceType": "browser-webcam", "endpoint": ""})
    assert r.status_code == 201, r.text
    return r.json()


def list_id(client, headers):
    return client.get("/watchlists", headers=headers).json()["lists"][0]["id"]


def send_frame(client, headers, camera_id, seq=0, session="cam-test"):
    return client.post("/detections/frame", headers=headers, files={"file": ("f.jpg", jpeg(), "image/jpeg")},
                       data={"sessionId": session, "cameraId": camera_id, "seq": str(seq)})


def plate_found(plate=PLATE, confidence=0.95):
    chars = tuple((c, confidence) for c in plate if c != "|")
    return Found((0.1, 0.2, 0.3, 0.1), 0.9, plate, confidence, chars)


# ---- permissions ---------------------------------------------------------------------

def test_permission_map_matches_the_dashboard():
    source = (REPO_ROOT / "dashboard" / "src" / "lib" / "rbac.ts").read_text(encoding="utf-8")
    admin = set(re.findall(r'"([a-z]+:[a-z]+)"', source.split("const ADMIN")[1].split("];")[0]))
    perms = source.split("const PERMISSIONS")[1]
    analyst = set(re.findall(r'"([a-z]+:[a-z]+)"', perms.split("analyst:")[1].split("]")[0]))
    auditor = set(re.findall(r'"([a-z]+:[a-z]+)"', perms.split("auditor:")[1].split("]")[0]))
    assert PERMISSIONS["admin"] == PERMISSIONS["super_admin"] == admin
    assert PERMISSIONS["analyst"] == analyst
    assert PERMISSIONS["auditor"] == auditor


def test_every_route_needs_a_session(client):
    for path in ("/metrics/overview", "/alerts", "/cameras", "/watchlists", "/evidence", "/audit"):
        assert client.get(path).status_code == 401


def test_auditor_cannot_see_cameras_or_alerts(client, root):
    auditor = make_user(client, root, "audrey", "auditor")
    assert client.get("/cameras", headers=auditor).status_code == 403
    assert client.get("/alerts", headers=auditor).status_code == 403
    assert client.get("/evidence", headers=auditor).status_code == 200


# ---- empty database ------------------------------------------------------------------

def test_fresh_database_has_no_operational_rows(client, root):
    o = client.get("/metrics/overview", headers=root).json()
    assert (o["platesToday"], o["watchlistHits"], o["totalCameras"]) == (0, 0, 0)
    assert o["integrity"] == {"status": "verified", "checkedLinks": 0, "brokenLinks": 0}
    assert client.get("/alerts", headers=root).json() == []
    assert client.get("/watchlists", headers=root).json()["entries"] == []
    assert [c["id"] for c in client.get("/cities", headers=root).json()] == ["fes", "rabat"]


# ---- cameras and scoping -------------------------------------------------------------

def test_analyst_only_sees_cameras_of_allowed_cities(client, root):
    rabat = webcam(client, root, "rabat")
    fes = webcam(client, root, "fes")
    analyst = make_user(client, root, "anna", "analyst", cities=["rabat"])
    assert [c["id"] for c in client.get("/cameras", headers=analyst).json()] == [rabat["id"]]
    assert client.get(f"/cameras/{fes['id']}", headers=analyst).status_code == 404
    assert client.post("/cameras", headers=analyst, json={"cityId": "rabat", "name": "x1", "sourceType": "browser-webcam"}).status_code == 403


def test_camera_urls_never_carry_credentials(client, root):
    body = {"cityId": "rabat", "name": "Gate", "sourceType": "rtsp", "endpoint": "rtsps://user:pw@10.0.0.5:322/s"}
    assert client.post("/cameras", headers=root, json=body).status_code == 422
    body["endpoint"] = "rtsp://10.0.0.5/s"
    assert client.post("/cameras", headers=root, json=body).status_code == 422  # TLS required


def test_rtsp_camera_reports_unknown_tls_and_no_fake_uptime(client, root):
    body = {"cityId": "rabat", "name": "Gate", "sourceType": "rtsp", "endpoint": "rtsps://10.0.0.5:322/s"}
    cam = client.post("/cameras", headers=root, json=body).json()
    assert (cam["tlsStatus"], cam["uptimePct"], cam["status"], cam["credentialsSet"]) == ("unknown", 0, "offline", False)


# ---- watchlists ----------------------------------------------------------------------

def test_csv_import_validates_server_side(client, root):
    lid = list_id(client, root)
    bad = "plate,reason,caseRef,source,expiresAt\n=cmd(),stolen,C1,x,\n"
    assert client.post("/watchlists/imports", headers=root, json={"listId": lid, "fileName": "a.csv", "csvText": bad}).status_code == 422
    r = client.post("/watchlists/imports", headers=root, json={"listId": lid, "fileName": "../../x.csv", "csvText": CSV})
    assert r.status_code == 201, r.text
    assert (r.json()["rowsAccepted"], r.json()["version"], r.json()["fileName"]) == (2, 1, "x.csv")
    # importing the same plates again: all rows rejected as already active
    assert client.post("/watchlists/imports", headers=root, json={"listId": lid, "fileName": "b.csv", "csvText": CSV}).status_code == 422


def test_add_entry_conflict_and_removal(client, root):
    lid = list_id(client, root)
    r = client.post(f"/watchlists/{lid}/entries", headers=root, json={"plate": "12345 ب 6", "reason": "stolen"})
    assert r.status_code == 201 and r.json()["plate"] == PLATE
    assert client.post(f"/watchlists/{lid}/entries", headers=root, json={"plate": PLATE, "reason": "stolen"}).status_code == 409
    entry_id = r.json()["id"]
    assert client.post(f"/watchlists/entries/{entry_id}/status", headers=root, json={"status": "removed", "reason": "short"}).status_code == 422
    r = client.post(f"/watchlists/entries/{entry_id}/status", headers=root, json={"status": "removed", "reason": "case closed by police"})
    assert r.json()["status"] == "removed"


def test_csv_validation_rules():
    from datetime import UTC, datetime
    now = datetime(2026, 1, 1, tzinfo=UTC)
    v = watchlist_csv.validate(CSV + f"{PLATE},stolen,C3,x,\n9|ب|6,stolen,C4,x,2020-01-01\n", now, set())
    assert v.fatal is None
    assert [bool(r.entry) for r in v.rows] == [True, True, False, False]
    assert "Duplicate of line 2." in v.rows[2].problems
    assert watchlist_csv.validate("a,b\n1,2\n", now, set()).fatal.startswith("The first line")


# ---- live frames -> reads, evidence, alerts ------------------------------------------

def test_detector_without_ocr_returns_boxes_and_stores_nothing(db_file, signing_key):
    det = FakeDetector(reads_plates=False)
    det.next = [Found((0.1, 0.1, 0.2, 0.1), 0.8)]
    client = TestClient(create_app(db_file, detector=det))
    root = sign_in(client, "root", ROOT_PW)
    cam = webcam(client, root)
    assert send_frame(client, root, cam["id"]).status_code == 200
    dets = client.get("/detections", headers=root, params={"sessionId": "cam-test"}).json()
    assert len(dets) == 1 and dets[0]["plate"] is None and dets[0]["watchlistMatch"] is None
    assert client.get("/metrics/overview", headers=root).json()["platesToday"] == 0
    assert client.get("/metrics/overview", headers=root).json()["ocrAccuracy"] is None


def test_watchlist_match_creates_one_pending_alert_and_signed_evidence(client, root, detector):
    lid = list_id(client, root)
    client.post(f"/watchlists/{lid}/entries", headers=root, json={"plate": PLATE, "reason": "stolen", "caseRef": "C-9"})
    cam = webcam(client, root)
    detector.next = [plate_found()]
    for seq in range(3):  # three frames of the same car
        assert send_frame(client, root, cam["id"], seq).status_code == 200
    dets = client.get("/detections", headers=root, params={"sessionId": "cam-test"}).json()
    assert dets[0]["watchlistMatch"]["plate"] == PLATE and dets[0]["alertId"]

    alerts = client.get("/alerts", headers=root).json()
    assert len(alerts) == 1 and alerts[0]["status"] == "pending" and alerts[0]["decision"] is None
    assert len(client.get("/plates/search", headers=root).json()) == 1  # one read, not three

    ev = client.get("/evidence", headers=root).json()
    assert len(ev["records"]) == 1 and ev["publicKey"]
    rec = ev["records"][0]
    assert PLATE not in json.dumps(rec["payload"], ensure_ascii=False)
    assert rec["prevHash"] == GENESIS and link_hash(GENESIS, rec["payload"]) == rec["hash"]
    o = client.get("/metrics/overview", headers=root).json()
    assert (o["platesToday"], o["watchlistHits"], o["integrity"]["status"]) == (1, 1, "verified")


def test_frames_from_other_users_sessions_are_not_shared(client, root, detector):
    cam = webcam(client, root)
    detector.next = [plate_found()]
    send_frame(client, root, cam["id"])
    analyst = make_user(client, root, "anna", "analyst", cities=["rabat"])
    assert client.get("/detections", headers=analyst, params={"sessionId": "cam-test"}).json() == []


def test_frames_rejected_for_non_webcam_or_bad_image(client, root):
    cam = webcam(client, root)
    r = client.post("/detections/frame", headers=root, files={"file": ("f.jpg", b"not a jpeg", "image/jpeg")},
                    data={"sessionId": "s", "cameraId": cam["id"], "seq": "0"})
    assert r.status_code == 422
    auditor = make_user(client, root, "audrey", "auditor")
    assert send_frame(client, auditor, cam["id"]).status_code == 403


def test_tampered_evidence_is_detected(client, root, detector, db_file):
    import sqlite3
    cam = webcam(client, root)
    detector.next = [plate_found()]
    send_frame(client, root, cam["id"])
    conn = sqlite3.connect(db_file)
    conn.execute("UPDATE evidence SET payload = replace(payload, 'capturedAt', 'capturedAT')")
    conn.commit()
    conn.close()
    assert client.get("/metrics/overview", headers=root).json()["integrity"]["status"] == "tamper_detected"


# ---- human review --------------------------------------------------------------------

def test_review_needs_justification_and_happens_once(client, root, detector):
    lid = list_id(client, root)
    client.post(f"/watchlists/{lid}/entries", headers=root, json={"plate": PLATE, "reason": "stolen"})
    cam = webcam(client, root)
    detector.next = [plate_found()]
    send_frame(client, root, cam["id"])
    alert_id = client.get("/alerts", headers=root).json()[0]["id"]
    url = f"/alerts/{alert_id}/review"
    assert client.post(url, headers=root, json={"action": "approve", "justification": "ok"}).status_code == 422
    r = client.post(url, headers=root, json={"action": "approve", "justification": "Plate and car checked on video"})
    assert r.status_code == 200 and r.json()["decision"]["reviewer"] == "root"
    assert client.post(url, headers=root, json={"action": "reject", "justification": "Plate and car checked on video"}).status_code == 409
    assert any(e["action"] == "alert.approve" for e in client.get("/audit", headers=root).json())


# ---- search and reveal ---------------------------------------------------------------

def test_search_masks_plates_and_reveal_is_audited(client, root, detector):
    cam = webcam(client, root)
    detector.next = [plate_found()]
    send_frame(client, root, cam["id"])
    assert client.get("/plates/search", headers=root, params={"plate": "12"}).status_code == 422
    results = client.get("/plates/search", headers=root, params={"plate": "234"}).json()
    assert [r["plateMasked"] for r in results] == ["••••5|ب|6"]
    read_id = results[0]["readId"]
    assert client.post(f"/plates/{read_id}/reveal", headers=root, json={"reason": "aaaaaaaaaaaa"}).status_code == 422
    r = client.post(f"/plates/{read_id}/reveal", headers=root, json={"reason": "Case CASE-1 follow-up"})
    assert r.json()["plate"] == PLATE
    actions = [e["action"] for e in client.get("/audit", headers=root).json()]
    assert "plate.reveal" in actions and "plate.search" in actions
