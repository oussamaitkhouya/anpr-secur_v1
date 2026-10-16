"""Issue a new token for the detection service (the camera worker that calls POST /api/v1/detections).

    .venv\\Scripts\\python scripts\\new_detection_token.py

Generates a random token, writes only its SHA-256 into .env (DETECTION_TOKEN_SHA256), and prints
the token ONCE. Give it to the camera worker as the DETECTION_TOKEN environment variable; it is
not stored anywhere by this script. Running it again rotates the token: restart the API, and the
old token stops working.
"""

import hashlib
import secrets
import sys
from pathlib import Path

ENV = Path(".env")
KEY = "DETECTION_TOKEN_SHA256"


def main() -> int:
    if not ENV.exists():
        print("No .env here. Run from the repo root after creating .env.", file=sys.stderr)
        return 1
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    lines = ENV.read_text(encoding="utf-8").splitlines()
    out, seen = [], False
    for line in lines:
        if line.partition("=")[0].strip() == KEY and not line.lstrip().startswith("#"):
            out.append(f"{KEY}={digest}")
            seen = True
        else:
            out.append(line)
    if not seen:
        out.append(f"{KEY}={digest}")
    ENV.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"{KEY} updated in .env. Restart the API.")
    print("Detection token (shown once, store it in the camera worker's environment as DETECTION_TOKEN):")
    print(token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
