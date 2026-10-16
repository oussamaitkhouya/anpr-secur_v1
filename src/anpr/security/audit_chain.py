"""Tamper-evident, signed audit chain (PostgreSQL).

    payload_n   = the entry's fields as canonical JSON (sorted keys, no spaces, UTF-8)
    hash_n      = SHA-256( prev_hash + "\\n" + payload_n ),     prev_hash of the first entry = 64 zeros
    signature_n = Ed25519_sign( private_key, hash_n )

- Editing any field changes that entry's hash, so the stored hash no longer matches.
- Deleting or inserting an entry breaks the next entry's prev_hash (and the seq sequence).
- Rewriting the whole chain after an edit needs the signing key, which the database never sees.
  Anyone holding only the public key (GET /api/v1/audit/public-key) can verify.

append() is called inside the caller's transaction, so the action and its audit record commit
together. A transaction-scoped advisory lock serialises appends: two requests can never read the
same last hash and fork the chain.
"""

import base64
import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from anpr.db.models import AuditEntry
from anpr.security.rbac import Actor

GENESIS = "0" * 64
LOCK_KEY = 0x414E5052  # "ANPR": the advisory lock id that serialises audit appends
HASHED_FIELDS = ("id", "seq", "ts", "actor_id", "actor_role", "action", "target_type", "target_id",
                 "justification", "ip")


def canonical_json(payload: dict) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _ts(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def payload_of(entry: AuditEntry) -> dict:
    values = {f: getattr(entry, f) for f in HASHED_FIELDS}
    values["id"] = str(values["id"])
    values["ts"] = _ts(values["ts"])
    return values


def link_hash(prev_hash: str, payload: dict) -> str:
    return hashlib.sha256(f"{prev_hash}\n{canonical_json(payload)}".encode()).hexdigest()


def append(session: Session, signer: Ed25519PrivateKey, actor: Actor, action: str, target_type: str,
           target_id: str | None = None, justification: str | None = None) -> AuditEntry:
    """Add one entry to the chain in the current transaction. Never put secrets in any field."""
    session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": LOCK_KEY})
    last = session.execute(select(AuditEntry.seq, AuditEntry.hash).order_by(AuditEntry.seq.desc()).limit(1)).first()
    entry = AuditEntry(
        id=uuid.uuid4(),
        seq=(last.seq + 1) if last else 1,
        ts=datetime.now(UTC),
        actor_id=actor.id[:64],
        actor_role=actor.role[:16],
        action=action,
        target_type=target_type,
        target_id=target_id[:64] if target_id else None,
        justification=justification,
        ip=actor.ip[:45],
        prev_hash=last.hash if last else GENESIS,
    )
    entry.hash = link_hash(entry.prev_hash, payload_of(entry))
    entry.signature = base64.b64encode(signer.sign(entry.hash.encode())).decode()
    session.add(entry)
    session.flush()
    return entry


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    entries: int
    first_bad_seq: int | None = None
    reason: str | None = None


def verify(session: Session, public_key: Ed25519PublicKey) -> VerifyResult:
    """Walk the chain from the start and report the first entry that does not check out."""
    prev, expected_seq, count = GENESIS, 1, 0
    rows = session.execute(select(AuditEntry).order_by(AuditEntry.seq).execution_options(yield_per=1000)).scalars()
    for entry in rows:
        count += 1
        reason = None
        if entry.seq != expected_seq:
            reason = "missing or reordered entry"
        elif entry.prev_hash != prev:
            reason = "prev_hash does not match the previous entry"
        elif link_hash(prev, payload_of(entry)) != entry.hash:
            reason = "entry content does not match its hash"
        else:
            try:
                public_key.verify(base64.b64decode(entry.signature), entry.hash.encode())
            except (InvalidSignature, ValueError):
                reason = "signature is not valid"
        if reason:
            return VerifyResult(False, count, entry.seq, reason)
        prev, expected_seq = entry.hash, expected_seq + 1
    return VerifyResult(True, count)
