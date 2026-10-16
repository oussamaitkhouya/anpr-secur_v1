"""Send one plate read to the API, as the camera worker would. For manual end-to-end checks.

    $env:DETECTION_TOKEN = "<token from new_detection_token.py>"
    .venv\\Scripts\\python scripts\\send_detection.py --camera <camera uuid> --plate "12345|أ|6"

Uses the real endpoint (POST /api/v1/detections) and the real watchlist matching: if the plate is
on an active watchlist, a pending alert appears in /alerts for a person to review. The token is
read from the environment, never from the command line (shell history).
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--camera", required=True, help="camera id (UUID) from Cities & Cameras")
    p.add_argument("--plate", required=True, help='canonical or raw plate, e.g. "12345|أ|6"')
    p.add_argument("--confidence", type=float, default=0.97)
    p.add_argument("--color")
    p.add_argument("--api", default=os.environ.get("ANPR_API", "http://127.0.0.1:8000"))
    args = p.parse_args()

    token = os.environ.get("DETECTION_TOKEN")
    if not token:
        print("Set DETECTION_TOKEN first (scripts/new_detection_token.py prints one).", file=sys.stderr)
        return 2
    chars = [c for c in args.plate if c not in "|- "]
    body = {
        "cameraId": args.camera, "observedAt": datetime.now(UTC).isoformat(), "sourceKind": "video",
        "plateRaw": args.plate, "plateConfidence": args.confidence, "charConfidences": [args.confidence] * len(chars),
        "observedColor": args.color,
    }
    req = urllib.request.Request(f"{args.api}/api/v1/detections", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(r.status, r.read().decode())
            return 0
    except urllib.error.HTTPError as e:
        print(e.code, e.read().decode(), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
