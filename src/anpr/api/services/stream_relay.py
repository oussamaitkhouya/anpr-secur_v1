"""Live video from network cameras (RTSP/RTSPS), relayed by the API to signed-in operators.

A browser cannot open rtsp://, and the camera's credentials must never reach the browser. So the
API opens the stream itself and serves it as MJPEG to the dashboard:

    camera --RTSP(S)--> CameraFeed (one reader thread per camera) --MJPEG--> every viewer

One feed per camera, shared by every viewer: N people watching = 1 connection to the camera.
A second thread reads plates on the latest frame (~2/s) through the same ingest as the camera
worker, so a watchlisted plate seen by a network camera opens a pending alert like any other read.

Security:
- Credentials are decrypted only here, in memory, to build the URL handed to FFmpeg. The URL is
  never logged, returned or put in an error message, and FFmpeg's own logging is silenced (it
  prints URLs). Errors shown to users are fixed sentences.
- SSRF: the host is resolved once and every address must pass the connection-test policy
  (anpr.security.netprobe); FFmpeg then connects to the checked IP, so DNS cannot redirect it.
- Only rtsp and rtsps; the scheme is ours, the path is checked, so a stored stream path cannot
  turn into another FFmpeg protocol (file:, http:, concat:...).
- Bounded: at most MAX_FEEDS cameras open at once; a feed with no viewer closes after IDLE_SECONDS.
- Video is never recorded. As with the webcam, only a frame that produced a plate report is kept
  (evidence store, 30-day retention), and only its SHA-256 goes into the database.
"""

import ipaddress
import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

# Before OpenCV opens any stream: RTSP over TCP (no lost UDP packets over Wi-Fi) and FFmpeg quiet,
# because FFmpeg error lines contain the full URL, credentials included.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
os.environ.setdefault("OPENCV_FFMPEG_LOGLEVEL", "-8")

import cv2
import numpy as np

from anpr.db.models import Camera
from anpr.pipeline.matcher import canonical_or_none
from anpr.security import crypto, netprobe, rbac
from anpr.security.rbac import Actor
from anpr.worker.core import Debouncer, EvidenceStore, usable_text

log = logging.getLogger("anpr.stream")

STREAMABLE = {"rtsp", "rtsps"}
CREDENTIALS_PURPOSE = "camera-credentials"  # must equal anpr.api.routes.admin.CREDENTIALS_PURPOSE
MAX_FEEDS = 8
IDLE_SECONDS = 15.0
OPEN_TIMEOUT_MS = 8000
READ_TIMEOUT_MS = 8000
MAX_WIDTH = 960           # what viewers get; detection runs on the full frame
OUTPUT_FPS = 12.0
JPEG_QUALITY = 80
DETECT_EVERY = 0.5        # seconds between plate reads
BOX_TTL = 1.2             # boxes are drawn this long after the frame they describe
MIN_BOX_CONFIDENCE = 0.5
RETRY_SECONDS = (2, 5, 10, 20, 30)
_PATH_RE = re.compile(r"/[!-~]*")  # with fullmatch: printable ASCII, no spaces, starts with "/"


class StreamRefused(Exception):
    """The camera cannot be streamed (wrong protocol, address refused...). Message is safe to show."""


@dataclass(frozen=True)
class Target:
    """Where to connect. `url` contains the credentials: never log or return it."""
    url: str
    label: str  # scheme://ip:port, no credentials, no path: safe for logs


def build_target(camera: Camera, keys, *, allowed_networks=(), resolver=netprobe.system_resolver) -> Target:
    if camera.protocol not in STREAMABLE:
        raise StreamRefused("Only RTSP and RTSPS cameras can be streamed.")
    if not camera.host:
        raise StreamRefused("The camera has no address. Edit it and set the host.")
    path = camera.stream_path or "/"
    if not path.startswith("/"):
        path = "/" + path
    if not _PATH_RE.fullmatch(path):
        raise StreamRefused("The stream path contains characters that are not allowed.")
    port = camera.port or netprobe.DEFAULT_PORTS[camera.protocol]
    try:
        addresses = resolver(camera.host, port)
    except OSError:
        raise StreamRefused("The camera's host name could not be resolved.") from None
    if not addresses:
        raise StreamRefused("The camera's host name could not be resolved.")
    for addr in addresses:
        reason = netprobe.refusal_reason(addr, allowed_networks)
        if reason:
            raise StreamRefused(f"Refused: the camera address resolves to a {reason}.")
    ip = addresses[0]
    host = f"[{ip}]" if ipaddress.ip_address(ip).version == 6 else ip
    auth = ""
    if camera.credentials_encrypted is not None:
        creds = json.loads(crypto.decrypt(keys, camera.credentials_encrypted, camera.credentials_key_id,
                                          purpose=CREDENTIALS_PURPOSE, row_id=str(camera.id)))
        auth = f"{quote(creds['username'], safe='')}:{quote(creds['password'], safe='')}@"
    return Target(url=f"{camera.protocol}://{auth}{host}:{port}{path}", label=f"{camera.protocol}://{host}:{port}")


def open_capture(url: str):
    """FFmpeg capture with open and read timeouts, so a dead camera cannot hang a thread forever."""
    return cv2.VideoCapture(url, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, OPEN_TIMEOUT_MS,
                                                  cv2.CAP_PROP_READ_TIMEOUT_MSEC, READ_TIMEOUT_MS])


def draw_boxes(frame: np.ndarray, boxes: list[tuple[tuple[float, float, float, float], str | None, bool]]) -> None:
    """Burn plate boxes into the frame viewers get: teal = valid read, amber = unreadable."""
    h, w = frame.shape[:2]
    for (x, y, bw, bh), text, valid in boxes:
        color = (200, 224, 52) if valid else (71, 179, 255)  # BGR
        p1, p2 = (int(x * w), int(y * h)), (int((x + bw) * w), int((y + bh) * h))
        cv2.rectangle(frame, p1, p2, color, 2)
        label = (text or "plate").replace("|", " ")
        # OpenCV fonts have no Arabic glyphs: the letter is shown as "?" here; the dashboard
        # feed shows the full read.
        label = "".join(c if c.isascii() else "?" for c in label)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
        top = max(0, p1[1] - th - 8)
        cv2.rectangle(frame, (p1[0], top), (p1[0] + tw + 8, top + th + 8), color, -1)
        cv2.putText(frame, label, (p1[0] + 4, top + th + 3), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (31, 10, 10), 2)


class CameraFeed:
    """One camera's stream: a reader thread keeps the latest frame, a detector thread reads plates."""

    def __init__(self, app, camera_id: uuid.UUID, target: Target, name: str):
        self.app, self.camera_id, self.name = app, camera_id, name
        self._target = target
        self._lock = threading.Lock()
        self._raw: np.ndarray | None = None   # latest decoded frame, for the detector
        self._raw_seq = 0
        self.jpeg: bytes | None = None        # latest frame for viewers, boxes drawn
        self.seq = 0
        self.state = "connecting"             # connecting | live | error
        self.message: str | None = None
        self.size: tuple[int, int] | None = None
        self.fps = 0.0
        self.reads = 0
        self.last_read_at: datetime | None = None
        self.viewers = 0
        self._idle_since = time.monotonic()
        self._boxes: list = []
        self._boxes_at = 0.0
        self._stop = threading.Event()
        self._debounce = Debouncer()
        threading.Thread(target=self._read_loop, name=f"stream-{camera_id}", daemon=True).start()
        threading.Thread(target=self._detect_loop, name=f"stream-detect-{camera_id}", daemon=True).start()

    # viewers ---------------------------------------------------------------------------------
    def attach(self) -> None:
        with self._lock:
            self.viewers += 1

    def detach(self) -> None:
        with self._lock:
            self.viewers = max(0, self.viewers - 1)
            if self.viewers == 0:
                self._idle_since = time.monotonic()

    @property
    def closed(self) -> bool:
        return self._stop.is_set()

    def close(self) -> None:
        self._stop.set()

    def _idle(self) -> bool:
        with self._lock:
            return self.viewers == 0 and time.monotonic() - self._idle_since > IDLE_SECONDS

    # reader ----------------------------------------------------------------------------------
    def _read_loop(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            if self._idle():
                break
            self.state, self.message = "connecting", None
            cap = open_capture(self._target.url)
            if not cap.isOpened():
                cap.release()
                self._fail("Could not open the stream. Check the address, port, stream path and credentials.", attempt)
                attempt += 1
                continue
            attempt = 0
            log.info("stream opened: camera %s at %s", self.camera_id, self._target.label)
            self._pump(cap)
            cap.release()
            if not self._stop.is_set() and not self._idle():
                self._fail("The camera stopped sending video. Reconnecting.", 0)
        self._stop.set()
        log.info("stream closed: camera %s", self.camera_id)

    def _fail(self, message: str, attempt: int) -> None:
        self.state, self.message = "error", message
        self._stop.wait(RETRY_SECONDS[min(attempt, len(RETRY_SECONDS) - 1)])

    def _pump(self, cap) -> None:
        last_out, frames, since = 0.0, 0, time.monotonic()
        while not self._stop.is_set() and not self._idle():
            ok, frame = cap.read()  # read every frame, so the picture never lags behind the camera
            if not ok or frame is None:
                return
            now = time.monotonic()
            with self._lock:
                self._raw, self._raw_seq = frame, self._raw_seq + 1
            frames += 1
            if now - since >= 2:
                self.fps, frames, since = round(frames / (now - since), 1), 0, now
            if now - last_out < 1 / OUTPUT_FPS:
                continue
            last_out = now
            out = frame
            if out.shape[1] > MAX_WIDTH:
                out = cv2.resize(out, (MAX_WIDTH, round(out.shape[0] * MAX_WIDTH / out.shape[1])), interpolation=cv2.INTER_AREA)
            else:
                out = out.copy()
            if now - self._boxes_at < BOX_TTL:
                draw_boxes(out, self._boxes)
            ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                with self._lock:
                    self.jpeg, self.seq = buf.tobytes(), self.seq + 1
                self.state, self.message, self.size = "live", None, (frame.shape[1], frame.shape[0])

    # plates ----------------------------------------------------------------------------------
    def _detect_loop(self) -> None:
        detector = self.app.state.detector
        seen = 0
        while not self._stop.wait(DETECT_EVERY):
            with self._lock:
                frame, seq = self._raw, self._raw_seq
            if frame is None or seq == seen:
                continue
            seen = seq
            try:
                found = detector.detect(frame)
            except FileNotFoundError:
                continue  # no model on this server: video only
            except Exception:
                log.exception("plate detection failed on camera %s", self.camera_id)
                continue
            self._boxes = [(f.box, usable_text(f.plate), canonical_or_none(f.plate or "") is not None) for f in found
                           if f.box_confidence >= MIN_BOX_CONFIDENCE]
            self._boxes_at = time.monotonic()
            reportable = [f for f in found if (t := usable_text(f.plate)) and f.box_confidence >= MIN_BOX_CONFIDENCE
                          and self._debounce.should_send(t)]
            if reportable:
                try:
                    self._report(frame, reportable)
                except Exception:
                    log.exception("could not record plate reads from camera %s", self.camera_id)

    def _report(self, frame: np.ndarray, found: list) -> None:
        from anpr.api.services.ingest import ReadIn, candidates, record_read

        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            return
        now = datetime.now(UTC)
        evidence = EvidenceStore(Path(self.app.state.settings.evidence_dir)).save(buf.tobytes(), now)
        # The relay acts as a camera worker, under the same service identity.
        actor = Actor(id=rbac.SERVICE_DETECTIONS, role="service", ip="stream-relay")
        holder = SimpleNamespace(app=self.app)  # record_read only needs request.app (audit signing key)
        with self.app.state.session_factory() as db:
            camera = db.get(Camera, self.camera_id)
            if camera is None:
                self.close()
                return
            pool = candidates(db, now)
            for f in found:
                text = usable_text(f.plate)
                letters = [c for c in text if c not in "|- "]
                confs = tuple(p for _, p in f.chars) if len(f.chars) == len(letters) else ()
                x, y = min(max(f.box[0], 0.0), 1.0), min(max(f.box[1], 0.0), 1.0)
                box = (round(x, 5), round(y, 5), round(min(max(f.box[2], 0.0), 1.0 - x), 5), round(min(max(f.box[3], 0.0), 1.0 - y), 5))
                record_read(db, holder, actor, camera, ReadIn(
                    plate_raw=text, plate_confidence=max(0.0, min(1.0, f.confidence)), observed_at=now,
                    char_confidences=confs, evidence_sha256=evidence, plate_box=box), now, cached_candidates=pool)
            db.commit()
        self.reads += len(found)
        self.last_read_at = now


class StreamHub:
    """The open feeds, at most MAX_FEEDS. Lives on app.state.streams."""

    def __init__(self):
        self._feeds: dict[uuid.UUID, CameraFeed] = {}
        self._lock = threading.Lock()

    def get(self, camera_id: uuid.UUID) -> CameraFeed | None:
        with self._lock:
            feed = self._feeds.get(camera_id)
            return feed if feed and not feed.closed else None

    def feed(self, app, camera: Camera, target_factory) -> CameraFeed:
        """The camera's running feed, or a new one. `target_factory` builds the Target only if needed."""
        with self._lock:
            self._feeds = {k: f for k, f in self._feeds.items() if not f.closed}
            feed = self._feeds.get(camera.id)
            if feed is None:
                if len(self._feeds) >= MAX_FEEDS:
                    raise StreamRefused(f"At most {MAX_FEEDS} camera streams can be open at once.")
                feed = CameraFeed(app, camera.id, target_factory(), camera.name)
                self._feeds[camera.id] = feed
            feed.attach()
            return feed

    def stop(self, camera_id: uuid.UUID) -> None:
        """Close a feed now (camera edited, credentials replaced): the next viewer reconnects fresh."""
        with self._lock:
            feed = self._feeds.pop(camera_id, None)
        if feed:
            feed.close()
