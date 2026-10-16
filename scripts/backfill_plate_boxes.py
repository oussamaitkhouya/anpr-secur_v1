"""Give older reads a plate box, by running the plate detector on their evidence frame.

    .venv\\Scripts\\python scripts\\backfill_plate_boxes.py            # dry run: prints what it would set
    .venv\\Scripts\\python scripts\\backfill_plate_boxes.py --apply

Reads stored before migration 0003 have an evidence frame but no detection_events.plate_box, so
the Live Alerts radar view cannot draw the target on them. This fills only rows where the box is
NULL. Each frame is hashed first and skipped if it no longer matches the SHA-256 recorded at
capture; frames are read, never modified. The box kept is the detector's most confident plate.
Uses MIGRATION_DATABASE_URL (schema owner) and EVIDENCE_DIR from the environment or .env.
"""

import argparse
import hashlib
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from anpr.api.routes.alerts import evidence_path
from anpr.api.routes.live import frame_box
from anpr.db.models import DetectionEvent
from anpr.pipeline.live import FrameDetector, FrameError, decode_jpeg
from anpr.utils.settings import load_env_file


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write the boxes (default: dry run)")
    args = ap.parse_args()

    load_env_file(str(REPO / ".env"))
    url = os.environ.get("MIGRATION_DATABASE_URL")
    if not url:
        print("MIGRATION_DATABASE_URL is not set (see .env.example).")
        return 2
    root = Path(os.environ.get("EVIDENCE_DIR", "var/evidence"))
    root = root if root.is_absolute() else REPO / root
    detector = FrameDetector()

    filled = skipped = 0
    with Session(create_engine(url)) as db:
        rows = db.scalars(select(DetectionEvent).where(DetectionEvent.plate_box.is_(None),
                                                      DetectionEvent.evidence_sha256.is_not(None))).all()
        for det in rows:
            path = evidence_path(root, det.evidence_sha256, det.observed_at)
            try:
                data = path.read_bytes()
            except OSError:
                print(f"skip {det.id}: frame not in the evidence store")
                skipped += 1
                continue
            if hashlib.sha256(data).hexdigest() != det.evidence_sha256:
                print(f"skip {det.id}: frame does not match its recorded hash")
                skipped += 1
                continue
            try:
                found = detector.detect(decode_jpeg(data))
            except FrameError as e:
                print(f"skip {det.id}: {e}")
                skipped += 1
                continue
            if not found:
                print(f"skip {det.id}: no plate found in the frame")
                skipped += 1
                continue
            box = frame_box(max(found, key=lambda f: f.box_confidence).box)
            print(f"{'set ' if args.apply else 'would set'} {det.id}: {list(box)}")
            if args.apply:
                det.plate_box = list(box)
            filled += 1
        if args.apply:
            db.commit()
    print(f"{filled} {'filled' if args.apply else 'to fill'}, {skipped} skipped" + ("" if args.apply else " (dry run: add --apply)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
