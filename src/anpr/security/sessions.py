"""Server-side sessions with opaque random tokens.

The client gets the token once, at login. The database keeps only SHA-256(token), so reading the
database does not let anyone impersonate a user. Sessions expire after SESSION_TTL.
"""

import hashlib
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

SESSION_TTL = timedelta(hours=8)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def create_session(conn: sqlite3.Connection, user_id: str, now: datetime | None = None) -> tuple[str, str]:
    """Return (token, expires_at). The token is shown to the client once and never stored."""
    now = now or datetime.now(timezone.utc)
    token = secrets.token_urlsafe(32)
    expires = now + SESSION_TTL
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (_hash(token), user_id, _iso(now), _iso(expires)),
    )
    return token, _iso(expires)


def resolve(conn: sqlite3.Connection, token: str, now: datetime | None = None) -> sqlite3.Row | None:
    """The active user behind a token, or None (unknown, expired, or user deactivated)."""
    if not token or len(token) > 200:
        return None
    now = now or datetime.now(timezone.utc)
    row = conn.execute(
        "SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
        (_hash(token),),
    ).fetchone()
    if row is None:
        return None
    if row["expires_at"] <= _iso(now) or not row["active"]:
        revoke(conn, token)
        return None
    return row


def revoke(conn: sqlite3.Connection, token: str) -> None:
    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash(token),))


def revoke_all(conn: sqlite3.Connection, user_id: str) -> None:
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
