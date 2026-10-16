# Live camera: stage 2 plan (backend)

Status: **plan only, not built.** Stage 1 (the dashboard page `/camera` with a mock detector)
is in `dashboard/src/pages/LiveCamera.tsx` and `dashboard/src/camera/`.

Scope: plate testing only. No face detection or recognition anywhere, in any stage.

## 1. Camera sources (Python)

A small interface so the pipeline does not care where frames come from.
Proposed module: `src/anpr/pipeline/camera.py`.

```python
@dataclass(frozen=True)
class Frame:
    source_id: str
    seq: int                 # assigned by the source, strictly increasing
    captured_at: datetime    # UTC
    image: np.ndarray        # BGR, as returned by OpenCV

class CameraSource(ABC):
    source_id: str
    def open(self) -> None: ...
    def read(self) -> Frame | None: ...   # None = no frame available right now
    def close(self) -> None: ...
    # context manager: `with make_source(cfg) as src: ...` always closes the device
```

| Class | Opens | Notes |
|---|---|---|
| `WebcamSource` | `cv2.VideoCapture(index)` | Sets width/height; on Windows try `cv2.CAP_DSHOW` if the default backend is slow to open. |
| `FileSource` | `cv2.VideoCapture(path)` | For repeatable tests and demos. Optional `loop`, and `fps` pacing so a file plays in real time instead of as fast as possible. |
| `RtspSource` | `cv2.VideoCapture(url, cv2.CAP_FFMPEG)` | TCP transport, reconnect with exponential backoff (cap 30 s). URL with credentials comes from an environment variable, never from YAML; it is redacted (`rtsp://***@host/...`) in every log and error message. |

Selected by config, `configs/camera.yaml`:

```yaml
camera:
  source: webcam            # webcam | file | rtsp
  max_fps: 5                # frames per second sent through the pipeline
  webcam: { index: 0, width: 1280, height: 720 }
  file:   { path: data/samples/test_plates.mp4, loop: true, fps: 10 }   # data/ is git-ignored
  rtsp:   { url_env: ANPR_RTSP_URL, transport: tcp, reconnect_max_s: 30 }
```

`make_source(cfg) -> CameraSource` validates the config (unknown source, missing env var, file
not found) and fails fast with a clear message.

Tests (pytest): factory picks the right class; `FileSource` reads a tiny video written with
`cv2.VideoWriter` into `tmp_path`; `seq` is strictly increasing; RTSP URL redaction; sources
close their device on exceptions.

## 2. WebSocket route (FastAPI)

`/ws/camera/{source_id}`: the server pushes frames and detections to the dashboard.

**Authentication and authorisation, before `accept()`:**
- Same session cookie as the REST API; the user is resolved server-side, never from a message.
- Role must have `camera:live` (Admin or Analyst), the same rule as `dashboard/src/lib/rbac.ts`.
- `Origin` header checked against an allowlist (WebSockets are not covered by CORS, so this
  blocks cross-site WebSocket hijacking).
- Connect and disconnect are written to the audit chain (`camera.start` / `camera.stop`),
  exactly like the mock does today.

**Rate limiting:**
- The server sends at most `max_fps` frames per second; the client can lower it (`set_fps`), not raise it above the cap.
- At most 2 concurrent camera sockets per user, and one per source per user.
- Token bucket on client messages (control messages only); oversize or malformed messages close the socket with code 1008.

**Messages** (server → client):

```jsonc
{ "type": "frame", "seq": 1042, "captured_at": "...", "width": 1280, "height": 720, "sha256": "..." }
// followed by one binary message: the JPEG
{ "type": "detections", "seq": 1042, "detections": [ /* same shape as Detection in dashboard/src/api/types.ts */ ] }
{ "type": "integrity", "event": "replay" | "frozen" | "frame_gap" | "clock_skew", "detail": "..." }
```

Client → server: `{"type": "set_fps", "fps": 2}`, `{"type": "ping"}`.

**Browser camera upload** (the dashboard's Model mode): a second route, `/ws/camera/browser`,
receives binary JPEG frames from `FrameCapturer`. Same auth and audit. Every message is checked
before decoding: at most 1 MB, JPEG magic bytes, decoded with `cv2.imdecode` inside a try, and
the resolution capped. Frames are processed in memory and dropped.

The dashboard side then only changes `dashboard/src/api/http.ts`: `sendFrame` and
`getDetections` move from "501 not implemented" to a WebSocket client, and the Model mode is
enabled when `/health` reports a loaded detector.

## 3. Per-frame pipeline and where the integrity checks plug in

```
CameraSource.read()
   → StreamGuard.check(frame)      # integrity: drop bad frames here, before any inference
   → detector (YOLO) → crop → OCR (CRNN) → validator (number|letter|region)
   → watchlist match?
        no  → detections pushed to the socket; read kept 30 days (retention policy)
        yes → evidence record hashed, chained, Ed25519-signed
              → alert created as PENDING; a human confirms it in Live Alerts
```

`StreamGuard` (proposed `src/anpr/security/stream_guard.py`, plain functions plus a small
state object, so each check is easy to explain and to unit-test):

| Check | How | On failure |
|---|---|---|
| Replay / reordering | `seq` must be greater than the last one seen for the source; `captured_at` within ±5 s of server time; for signed IP cameras, the frame nonce must not be in a recent-nonces LRU set and the frame signature must verify | drop frame, `replay` event |
| Frozen frames | Downscale to 32×32 grayscale; mean absolute difference with the previous frame below a threshold for more than N seconds (a stuck camera or a looped still injected into the stream). Exact SHA-256 repeats are flagged immediately | `frozen` event, frames still shown but marked |
| Frame gap | No frame for more than the heartbeat interval | `frame_gap` event |
| Clock skew | Camera timestamp drifts from server time beyond the window | `clock_skew` event, timestamps flagged |

Every event is written to the audit chain and appears in the Security Center's stream-integrity
list (the `StreamEvent` type already exists in the dashboard). A dropped frame never reaches the
detector, so it can never create an alert.

## 4. Privacy

- Frames are never written to disk, logs or the database, except the evidence for a watchlist
  hit, which is signed and covered by the retention policy.
- Logs carry frame metadata (seq, size, hash), never pixels and never full plates.
- No face detection, recognition or blurring code ships until a separate, reviewed decision.
  The dashboard's "Blur faces" switch is a disabled placeholder.

## 5. Open questions

- Which signed-camera scheme do real IP cameras support (per-frame signatures vs. mTLS only)?
- Frozen-frame thresholds need tuning on real footage from consented test drives.
- Should Model mode on a browser camera ever be allowed outside a test environment?
