"""Password login with lockout.

Every failure looks the same to the caller (unknown user, wrong password, locked or deactivated
account), and an unknown username costs the same Argon2 work as a wrong password, so the login
form cannot be used to discover which usernames exist. After MAX_ATTEMPTS failures in a row the
account is locked for LOCKOUT.
"""

import sqlite3
from datetime import datetime, timedelta, timezone

from anpr.db.database import transaction
from anpr.security import audit
from anpr.security.passwords import (
    burn_time,
    hash_password,
    needs_rehash,
    verify_password,
)
from anpr.security.sessions import create_session

MAX_ATTEMPTS = 5
LOCKOUT = timedelta(minutes=15)


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def login(conn: sqlite3.Connection, username: str, password: str, ip: str,
          now: datetime | None = None) -> tuple[str, str, sqlite3.Row] | None:
    """(token, expires_at, user) on success, None on any failure."""
    now = now or datetime.now(timezone.utc)
    name = username.strip().lower()[:64]
    row = conn.execute("SELECT * FROM users WHERE username = ?", (name,)).fetchone()

    def fail(reason: str) -> None:
        audit.append(conn, actor=name or "(empty)", role=row["role"] if row else "unknown",
                     action="auth.login_failed", target="session", detail=reason, ip=ip)

    if row is None:
        burn_time(password)
        fail("unknown account")
        return None
    if row["locked_until"] and row["locked_until"] > _iso(now):
        burn_time(password)
        fail("account locked")
        return None

    ok = verify_password(row["password_hash"], password)
    if not ok or not row["active"]:
        attempts = row["failed_attempts"] + 1
        with transaction(conn):
            if attempts >= MAX_ATTEMPTS:
                conn.execute("UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?", (_iso(now + LOCKOUT), row["id"]))
                audit.append(conn, actor="system", role="system", action="auth.lockout", target=row["username"],
                             detail=f"{MAX_ATTEMPTS} failed attempts; locked for {int(LOCKOUT.total_seconds() // 60)} min", ip=ip)
            else:
                conn.execute("UPDATE users SET failed_attempts = ? WHERE id = ?", (attempts, row["id"]))
            fail("wrong password" if not ok else "account deactivated")
        return None

    with transaction(conn):
        conn.execute("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?", (row["id"],))
        if needs_rehash(row["password_hash"]):
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(password), row["id"]))
        token, expires_at = create_session(conn, row["id"], now)
        audit.append(conn, actor=row["username"], role=row["role"], action="auth.login", target="session", ip=ip)
    return token, expires_at, row
