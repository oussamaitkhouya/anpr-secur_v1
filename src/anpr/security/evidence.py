"""Evidence vault: one hash-chained, Ed25519-signed record per plate read.

    hash_n      = SHA-256(hash_{n-1} + "\\n" + canonical_json(payload_n)),   hash_0 = 64 zeros
    signature_n = Ed25519(private key, utf-8 bytes of hash_n), base64

Same construction as the audit log (anpr.security.audit) plus a signature, so the dashboard can
re-verify the whole chain with only the public key (dashboard/src/lib/chain.ts). The payload holds
SHA-256 digests of the plate and of the frame, never the plate or the image.

The signing key is AUDIT_SIGNING_KEY (base64 of a raw 32-byte Ed25519 key, see
anpr.security.keys). Without it records are still chained, but unsigned (signature NULL).
"""

import base64
import hashlib
import json
import os
import sqlite3
import uuid
from functools import lru_cache

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from anpr.db.database import now_iso
from anpr.security.audit import GENESIS, link_hash
from anpr.security.keys import load_signing_key, public_key_b64

KEY_ID = os.environ.get("EVIDENCE_KEY_ID", "ed25519-1")


@lru_cache(maxsize=1)
def signing_key() -> Ed25519PrivateKey | None:
    b64 = os.environ.get("AUDIT_SIGNING_KEY", "").strip()
    return load_signing_key(b64) if b64 else None


def public_key() -> str | None:
    key = signing_key()
    return public_key_b64(key.public_key()) if key else None


def plate_digest(plate: str) -> str:
    return hashlib.sha256(plate.encode()).hexdigest()


def append(conn: sqlite3.Connection, *, read_id: str, camera_id: str, captured_at: str, plate: str,
           frame_sha256: str, model_version: str) -> str:
    """Add the record for one read, inside the caller's transaction. Returns the evidence id."""
    payload = {"readId": read_id, "cameraId": camera_id, "capturedAt": captured_at,
               "plateDigest": plate_digest(plate), "frameSha256": frame_sha256, "modelVersion": model_version}
    last = conn.execute("SELECT hash FROM evidence ORDER BY seq DESC LIMIT 1").fetchone()
    prev = last["hash"] if last else GENESIS
    h = link_hash(prev, payload)
    key = signing_key()
    signature = base64.b64encode(key.sign(h.encode())).decode() if key else None
    evidence_id = f"ev-{uuid.uuid4().hex[:12]}"
    conn.execute(
        "INSERT INTO evidence (id, read_id, payload, prev_hash, hash, signature, key_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (evidence_id, read_id, json.dumps(payload, sort_keys=True, ensure_ascii=False), prev, h, signature, KEY_ID, now_iso()),
    )
    return evidence_id
