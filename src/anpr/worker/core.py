"""Camera worker logic that needs no camera and no model, so it is unit-tested directly.

    Debouncer      one report per plate per camera per window (a parked car is not 300 reads)
    to_payload     a detector result -> the JSON body of POST /api/v1/detections
    Sender         POSTs with the service token; retries network errors with backoff, honours
                   429 Retry-After, never retries a 4xx it cannot fix (bad token, unknown camera)
    EvidenceStore  saves the JPEG of a frame that produced a report, named by its SHA-256

Privacy: frames are kept only when a plate was reported, in a local, git-ignored folder, and are
deleted after EVIDENCE_DAYS. The API receives the SHA-256, never the image.
"""

import hashlib
import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

EVIDENCE_DAYS = 30


class FatalSendError(Exception):
    """The API refused the request in a way retrying cannot fix. Message is safe to print."""


@dataclass
class Debouncer:
    window: timedelta = timedelta(seconds=10)
    clock: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    _last: dict[str, datetime] = field(default_factory=dict)

    def should_send(self, plate: str) -> bool:
        now = self.clock()
        last = self._last.get(plate)
        if last is not None and now - last < self.window:
            return False
        self._last[plate] = now
        # forget old plates so memory stays flat on a busy road
        self._last = {p: t for p, t in self._last.items() if now - t < self.window * 6}
        return True


def usable_text(plate: str | None) -> str | None:
    """The detector's text for a box, or None when there is nothing worth reporting."""
    if not plate or plate == "EMPTY_OCR":
        return None
    text = plate.strip()
    return text if 1 <= len(text) <= 40 else None


def to_payload(camera_id: str, observed_at: datetime, plate: str, confidence: float,
               chars: tuple[tuple[str, float], ...], evidence_sha256: str | None,
               box: tuple[float, float, float, float] | None = None) -> dict:
    """Body of POST /api/v1/detections. Per-character confidences only when they line up with the
    plate characters (the server's matcher relies on that alignment)."""
    letters = [c for c in plate if c not in "|- "]
    confidences = [round(p, 4) for _, p in chars]
    return {
        "cameraId": camera_id,
        "observedAt": observed_at.astimezone(UTC).isoformat(),
        "sourceKind": "video",
        "plateRaw": plate,
        "plateConfidence": round(max(0.0, min(1.0, confidence)), 4),
        "charConfidences": confidences if len(confidences) == len(letters) and len(confidences) <= 20 else [],
        "evidenceSha256": evidence_sha256,
        **({"plateBox": [round(min(max(v, 0.0), 1.0), 5) for v in box]} if box and evidence_sha256 else {}),
    }


@dataclass
class Sender:
    api: str
    token: str
    timeout: float = 5.0
    max_attempts: int = 4
    sleep: Callable[[float], None] = time.sleep
    opener: Callable = urllib.request.urlopen

    def send(self, payload: dict) -> dict:
        """POST one detection. Returns the API's JSON. Raises FatalSendError on a 4xx it cannot fix."""
        data = json.dumps(payload).encode()
        delay = 1.0
        for attempt in range(1, self.max_attempts + 1):
            req = urllib.request.Request(f"{self.api.rstrip('/')}/api/v1/detections", data=data, method="POST",
                                         headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"})
            try:
                with self.opener(req, timeout=self.timeout) as r:
                    return json.loads(r.read().decode() or "{}")
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = float(e.headers.get("Retry-After", delay)) if e.headers else delay
                    self.sleep(min(wait, 60))
                    continue
                if e.code == 401:
                    raise FatalSendError("The API refused the detection token (401). Check DETECTION_TOKEN and restart the API after rotating it.") from None
                if e.code == 404:
                    raise FatalSendError("The API does not know this camera id (404). Copy it from Cities & Cameras.") from None
                if 400 <= e.code < 500:
                    raise FatalSendError(f"The API rejected the detection ({e.code}).") from None
                # 5xx: fall through to retry
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                pass
            if attempt < self.max_attempts:
                self.sleep(delay)
                delay = min(delay * 2, 30)
        raise ConnectionError(f"Could not reach the API at {self.api} after {self.max_attempts} attempts.")


@dataclass
class EvidenceStore:
    root: Path
    days: int = EVIDENCE_DAYS

    def save(self, jpeg: bytes, when: datetime) -> str:
        digest = hashlib.sha256(jpeg).hexdigest()
        folder = self.root / when.astimezone(UTC).strftime("%Y-%m-%d")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{digest}.jpg"
        if not path.exists():
            path.write_bytes(jpeg)
        return digest

    def prune(self, now: datetime | None = None) -> int:
        """Delete day folders older than the retention period. Returns how many files went."""
        now = now or datetime.now(UTC)
        cutoff = (now - timedelta(days=self.days)).strftime("%Y-%m-%d")
        removed = 0
        if not self.root.is_dir():
            return 0
        for folder in self.root.iterdir():
            if folder.is_dir() and len(folder.name) == 10 and folder.name < cutoff:
                for f in folder.glob("*.jpg"):
                    f.unlink()
                    removed += 1
                folder.rmdir()
        return removed
