"""Append-only, hash-chained audit log.

    hash_n = SHA-256(hash_{n-1} + "\\n" + canonical_json(entry_n)),   hash_0 = 64 zeros

Editing any entry changes its hash; deleting one breaks the next entry's prev_hash. verify()
recomputes the whole chain. Details must never contain passwords or tokens.
"""

import hashlib
import json
import sqlite3

from anpr.db.database import now_iso

GENESIS = "0" * 64
FIELDS = ("at", "actor", "role", "action", "target", "detail", "ip")


def canonical_json(payload: dict) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def link_hash(prev_hash: str, payload: dict) -> str:
    return hashlib.sha256(f"{prev_hash}\n{canonical_json(payload)}".encode()).hexdigest()


def append(conn: sqlite3.Connection, *, actor: str, role: str, action: str, target: str,
           detail: str | None = None, ip: str = "unknown") -> dict:
    """Add one entry. BEGIN IMMEDIATE serialises writers, so two requests cannot fork the chain.
    Inside a caller's transaction, the entry commits (or rolls back) together with the change it records.
    """
    entry = {"at": now_iso(), "actor": actor[:64], "role": role, "action": action,
             "target": target[:200], "detail": detail[:500] if detail else None, "ip": ip[:64]}
    own = not conn.in_transaction
    if own:
        conn.execute("BEGIN IMMEDIATE")
    try:
        last = conn.execute("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").fetchone()
        prev = last["hash"] if last else GENESIS
        h = link_hash(prev, entry)
        conn.execute(
            "INSERT INTO audit_log (at, actor, role, action, target, detail, ip, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)",
            (*[entry[f] for f in FIELDS], prev, h),
        )
        if own:
            conn.execute("COMMIT")
    except Exception:
        if own:
            conn.execute("ROLLBACK")
        raise
    return {**entry, "prev_hash": prev, "hash": h}


def verify(conn: sqlite3.Connection) -> tuple[bool, int | None]:
    """(True, None) if intact, else (False, seq of the first bad entry)."""
    prev = GENESIS
    for row in conn.execute("SELECT * FROM audit_log ORDER BY seq"):
        payload = {f: row[f] for f in FIELDS}
        if row["prev_hash"] != prev or link_hash(prev, payload) != row["hash"]:
            return False, row["seq"]
        prev = row["hash"]
    return True, None
