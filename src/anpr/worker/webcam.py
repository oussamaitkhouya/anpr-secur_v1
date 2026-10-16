"""Camera worker for this PC's webcam: read frames, find and read plates, report them to the API.

    $env:PYTHONPATH = "src"
    $env:DETECTION_TOKEN = "<token from scripts/new_detection_token.py>"
    .venv\\Scripts\\python -m anpr.worker.webcam --camera-id <uuid from Cities & Cameras> --show

The webcam must first be registered in Cities & Cameras (protocol "file": a local source the
server never connects to) so its reads land in the right city. Each detected plate becomes one
POST /api/v1/detections; the API matches it against watchlists and opens a pending alert for a
person to review. The worker never decides anything.

What it keeps: the JPEG of a frame only when it produced a report, under --evidence-dir
(git-ignored, deleted after 30 days); the API gets its SHA-256. Video is never recorded and audio
is never opened. Ctrl+C (or q in the preview window) stops it and releases the camera.

Models: anpr.pipeline.live.FrameDetector (ANPR_DETECTOR_WEIGHTS, ANPR_OCR_WEIGHTS). Without OCR
weights it only finds boxes and reports nothing.
"""

import argparse
import logging
import os
import signal
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from anpr.utils.settings import load_env_file
from anpr.worker.core import (
    Debouncer,
    EvidenceStore,
    FatalSendError,
    Sender,
    to_payload,
    usable_text,
)

log = logging.getLogger("anpr.worker")
MIN_BOX_CONFIDENCE = 0.5


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--camera-id", required=True, help="the webcam's camera id in Cities & Cameras")
    p.add_argument("--device", type=int, default=0, help="webcam index (0 = default camera)")
    p.add_argument("--fps", type=float, default=4.0, help="frames analysed per second (default 4)")
    p.add_argument("--api", default=os.environ.get("ANPR_API", "http://127.0.0.1:8000"))
    p.add_argument("--evidence-dir", default="var/evidence", help="where report frames are kept (git-ignored)")
    p.add_argument("--min-box", type=float, default=MIN_BOX_CONFIDENCE, help="minimum plate-box confidence")
    p.add_argument("--show", action="store_true", help="open a preview window with the boxes and reads")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    load_env_file()
    args = parse_args(argv)
    try:
        camera_id = str(uuid.UUID(args.camera_id))
    except ValueError:
        log.error("--camera-id must be the UUID shown in Cities & Cameras.")
        return 2
    token = os.environ.get("DETECTION_TOKEN")
    if not token:
        log.error("Set DETECTION_TOKEN (scripts/new_detection_token.py prints one). It is never taken as an argument.")
        return 2

    import cv2  # heavy imports after argument checks

    from anpr.pipeline.live import FrameDetector

    detector = FrameDetector()
    if not detector.reads_plates:
        log.warning("ANPR_OCR_WEIGHTS is not set: plates will be boxed but not read, so nothing is reported.")
    sender = Sender(args.api, token)
    evidence = EvidenceStore(Path(args.evidence_dir))
    debounce = Debouncer()
    log.info("Evidence older than %d days removed: %d files", evidence.days, evidence.prune())

    backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY  # DirectShow opens fast on Windows
    cap = cv2.VideoCapture(args.device, backend)
    if not cap.isOpened():
        log.error("Could not open webcam %d. Is another app using it?", args.device)
        return 1

    stop = False

    def on_signal(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, on_signal)
    log.info("Webcam %d open. Model: %s. Reporting to %s as camera %s. Ctrl+C to stop.", args.device, detector.version, args.api, camera_id)
    period = 1.0 / max(args.fps, 0.2)
    reported = 0
    try:
        while not stop:
            started = time.monotonic()
            ok, frame = cap.read()
            if not ok:
                log.warning("No frame from the webcam; retrying.")
                time.sleep(1)
                continue
            observed_at = datetime.now(UTC)
            found = detector.detect(frame)
            for f in found:
                text = usable_text(f.plate)
                if f.box_confidence < args.min_box or text is None or not debounce.should_send(text):
                    continue
                ok_jpg, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
                digest = evidence.save(jpg.tobytes(), observed_at) if ok_jpg else None
                try:
                    out = sender.send(to_payload(camera_id, observed_at, text, f.confidence, f.chars, digest, f.box))
                except FatalSendError as e:
                    log.error("%s Stopping.", e)
                    return 1
                except ConnectionError as e:
                    log.warning("%s The read was not delivered.", e)
                    continue
                reported += 1
                log.info("Reported read #%d: valid plate=%s, alerts opened=%s", reported, out.get("plateValid"), out.get("alertsCreated"))
            if args.show and _preview(cv2, frame, found):
                break
            time.sleep(max(0.0, period - (time.monotonic() - started)))
    finally:
        cap.release()
        if args.show:
            cv2.destroyAllWindows()
        log.info("Webcam released. %d reads reported.", reported)
    return 0


def _preview(cv2, frame, found) -> bool:
    """Draw boxes and reads; returns True when the user pressed q."""
    h, w = frame.shape[:2]
    for f in found:
        x, y, bw, bh = f.box
        p1, p2 = (int(x * w), int(y * h)), (int((x + bw) * w), int((y + bh) * h))
        cv2.rectangle(frame, p1, p2, (200, 224, 52), 2)
        label = f"{usable_text(f.plate) or '?'} {f.confidence:.2f}"
        cv2.putText(frame, label, (p1[0], max(16, p1[1] - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 224, 52), 2)
    cv2.imshow("ANPR camera worker (q to quit)", frame)
    return (cv2.waitKey(1) & 0xFF) == ord("q")


if __name__ == "__main__":
    sys.exit(main())
