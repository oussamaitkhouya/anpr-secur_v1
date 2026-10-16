"""Camera worker logic: debounce, payload, sending with retries, evidence retention, CLI guards."""

import io
import json
import urllib.error
from datetime import UTC, datetime, timedelta
from email.message import Message

import pytest

from anpr.worker import webcam
from anpr.worker.core import (
    Debouncer,
    EvidenceStore,
    FatalSendError,
    Sender,
    to_payload,
    usable_text,
)

T0 = datetime(2026, 10, 9, 10, 0, tzinfo=UTC)
CAM = "6f1c0b0e-1111-4222-8333-444455556666"


def test_debouncer_reports_a_plate_once_per_window():
    now = [T0]
    d = Debouncer(window=timedelta(seconds=10), clock=lambda: now[0])
    assert d.should_send("12345|أ|6")
    assert not d.should_send("12345|أ|6")
    assert d.should_send("777|ب|1")  # a different car is not held back
    now[0] = T0 + timedelta(seconds=11)
    assert d.should_send("12345|أ|6")


@pytest.mark.parametrize("text, expected", [(None, None), ("", None), ("EMPTY_OCR", None), ("  12345|أ|6 ", "12345|أ|6"), ("x" * 41, None)])
def test_usable_text(text, expected):
    assert usable_text(text) == expected


def test_payload_aligns_character_confidences_or_drops_them():
    chars = tuple((c, 0.9) for c in "12345أ6")
    body = to_payload(CAM, T0, "12345|أ|6", 0.87654, chars, "a" * 64)
    assert body["charConfidences"] == [0.9] * 7 and body["plateConfidence"] == 0.8765
    assert body["observedAt"].startswith("2026-10-09T10:00:00") and body["sourceKind"] == "video"
    misaligned = to_payload(CAM, T0, "12345|أ|6", 0.9, (("1", 0.9),), None)
    assert misaligned["charConfidences"] == []
    assert set(body) == {"cameraId", "observedAt", "sourceKind", "plateRaw", "plateConfidence", "charConfidences", "evidenceSha256"}
    boxed = to_payload(CAM, T0, "12345|أ|6", 0.9, chars, "a" * 64, (0.41234567, 0.5, 0.2, 0.08))
    assert boxed["plateBox"] == [0.41235, 0.5, 0.2, 0.08]
    assert "plateBox" not in to_payload(CAM, T0, "12345|أ|6", 0.9, chars, None, (0.4, 0.5, 0.2, 0.08))  # no frame, no box


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code, retry_after=None):
    headers = Message()
    if retry_after:
        headers["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("u", code, "x", headers, io.BytesIO(b"{}"))


def test_sender_uses_the_token_and_returns_the_reply():
    seen = {}

    def opener(req, timeout):
        seen["auth"] = req.get_header("Authorization")
        seen["body"] = json.loads(req.data)
        return FakeResponse(b'{"plateValid": true, "alertsCreated": 1}')

    out = Sender("http://api", "tok", opener=opener).send({"plateRaw": "x"})
    assert out == {"plateValid": True, "alertsCreated": 1}
    assert seen == {"auth": "Bearer tok", "body": {"plateRaw": "x"}}


def test_sender_retries_network_errors_and_honours_retry_after():
    calls, sleeps = [], []
    replies = [urllib.error.URLError("down"), http_error(429, retry_after=3), http_error(503), FakeResponse(b"{}")]

    def opener(req, timeout):
        calls.append(1)
        r = replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    assert Sender("http://api", "t", opener=opener, sleep=sleeps.append).send({}) == {}
    assert len(calls) == 4 and 3.0 in sleeps


@pytest.mark.parametrize("code, words", [(401, "token"), (404, "camera id"), (422, "rejected")])
def test_sender_stops_on_errors_retrying_cannot_fix(code, words):
    def opener(req, timeout):
        raise http_error(code)

    with pytest.raises(FatalSendError, match=words):
        Sender("http://api", "t", opener=opener, sleep=lambda s: None).send({})


def test_sender_gives_up_after_max_attempts():
    def opener(req, timeout):
        raise urllib.error.URLError("down")

    with pytest.raises(ConnectionError):
        Sender("http://api", "t", opener=opener, sleep=lambda s: None, max_attempts=3).send({})


def test_evidence_is_named_by_hash_and_pruned_after_retention(tmp_path):
    store = EvidenceStore(tmp_path, days=30)
    digest = store.save(b"jpeg-bytes", T0)
    assert (tmp_path / "2026-10-09" / f"{digest}.jpg").read_bytes() == b"jpeg-bytes"
    old = store.save(b"old", T0 - timedelta(days=40))
    assert store.prune(now=T0) == 1
    assert not (tmp_path / (T0 - timedelta(days=40)).strftime("%Y-%m-%d") / f"{old}.jpg").exists()
    assert (tmp_path / "2026-10-09" / f"{digest}.jpg").exists()


def test_cli_refuses_a_bad_camera_id_or_a_missing_token(monkeypatch):
    monkeypatch.setattr(webcam, "load_env_file", lambda: None)
    monkeypatch.delenv("DETECTION_TOKEN", raising=False)
    assert webcam.main(["--camera-id", "not-a-uuid"]) == 2
    assert webcam.main(["--camera-id", CAM]) == 2  # no token: refuses before opening the camera
