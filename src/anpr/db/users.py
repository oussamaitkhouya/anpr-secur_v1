"""User accounts: creation, edits, password resets and deletion, with the management rules.

Who may manage whom:
    super_admin -> everyone (including other admins and super admins)
    admin       -> analyst and auditor accounts only
    analyst, auditor -> nobody
Guards: nobody changes their own role, deactivates or deletes themselves, and the last active
super admin can never be removed or demoted. Every change writes an audit entry in the same
transaction.
"""

import json
import re
import sqlite3
import uuid
from dataclasses import dataclass

from anpr.db.database import now_iso, transaction
from anpr.security import audit
from anpr.security.passwords import hash_password, policy_problems
from anpr.security.sessions import revoke_all

ROLES = ("super_admin", "admin", "analyst", "auditor")
USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
CITY_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
MAX_CITIES = 50


class UserError(Exception):
    """A request that breaks a rule; `status` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Actor:
    id: str
    username: str
    role: str
    ip: str = "unknown"
    allowed_city_ids: tuple[str, ...] = ()  # used for analysts only (see anpr.api.operations)


def can_manage(actor_role: str, target_role: str) -> bool:
    if actor_role == "super_admin":
        return True
    if actor_role == "admin":
        return target_role in ("analyst", "auditor")
    return False


def public_user(row: sqlite3.Row, actor: Actor | None = None) -> dict:
    """The only shape a user ever leaves the server in: no hash, no lockout counters."""
    user = {
        "id": row["id"],
        "username": row["username"],
        "name": row["display_name"],
        "role": row["role"],
        "allowedCityIds": json.loads(row["allowed_city_ids"]),
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "createdBy": row["created_by"],
    }
    if actor is not None:
        user["manageable"] = actor.id != row["id"] and can_manage(actor.role, row["role"])
    return user


def _clean_name(name: str) -> str:
    name = " ".join(name.split())
    if not 1 <= len(name) <= 60:
        raise UserError("Display name must be 1 to 60 characters.")
    return name


def _clean_cities(role: str, city_ids: list[str]) -> list[str]:
    if role != "analyst":
        return []  # admins see every city; auditors never get camera scope
    cities = sorted(set(city_ids))
    if len(cities) > MAX_CITIES or any(not CITY_ID.match(c) for c in cities):
        raise UserError("Invalid city list.")
    return cities


def _get(conn: sqlite3.Connection, user_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if row is None:
        raise UserError("User not found.", 404)
    return row


def _active_super_admins(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM users WHERE role = 'super_admin' AND active = 1").fetchone()[0]


def list_users(conn: sqlite3.Connection, actor: Actor) -> list[dict]:
    rows = conn.execute("SELECT * FROM users ORDER BY role = 'super_admin' DESC, role = 'admin' DESC, username").fetchall()
    return [public_user(r, actor) for r in rows]


def create_user(conn: sqlite3.Connection, actor: Actor, *, username: str, name: str, role: str,
                password: str, allowed_city_ids: list[str] | None = None) -> dict:
    username = username.strip().lower()
    if not USERNAME.match(username):
        raise UserError("Username: 3 to 32 characters, lowercase letters, digits, '.', '_' or '-'.")
    if role not in ROLES:
        raise UserError("Unknown role.")
    if not can_manage(actor.role, role):
        raise UserError(f"Your role cannot create {role} accounts.", 403)
    problems = policy_problems(password, username)
    if problems:
        raise UserError(" ".join(problems))
    name = _clean_name(name)
    cities = _clean_cities(role, allowed_city_ids or [])
    password_hash = hash_password(password)  # slow on purpose; done before the write lock

    user_id = f"u-{uuid.uuid4().hex[:12]}"
    now = now_iso()
    with transaction(conn):
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
            raise UserError("That username is taken.", 409)
        conn.execute(
            "INSERT INTO users (id, username, display_name, role, password_hash, allowed_city_ids, created_at, updated_at, created_by)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, username, name, role, password_hash, json.dumps(cities), now, now, actor.username),
        )
        audit.append(conn, actor=actor.username, role=actor.role, action="user.create", target=username,
                     detail=f"role={role}; cities={','.join(cities) or 'none'}", ip=actor.ip)
    return public_user(_get(conn, user_id), actor)


def update_user(conn: sqlite3.Connection, actor: Actor, user_id: str, *, name: str | None = None,
                role: str | None = None, allowed_city_ids: list[str] | None = None, active: bool | None = None) -> dict:
    target = _get(conn, user_id)
    if not can_manage(actor.role, target["role"]) and actor.id != user_id:
        raise UserError("You cannot change this account.", 403)
    is_self = actor.id == user_id
    if is_self and (role not in (None, target["role"]) or active is False):
        raise UserError("You cannot change your own role or deactivate yourself.", 403)

    new_role = role or target["role"]
    if new_role not in ROLES:
        raise UserError("Unknown role.")
    if not is_self and not can_manage(actor.role, new_role):
        raise UserError(f"Your role cannot assign the {new_role} role.", 403)
    new_name = _clean_name(name) if name is not None else target["display_name"]
    new_active = target["active"] if active is None else int(active)
    cities_in = allowed_city_ids if allowed_city_ids is not None else json.loads(target["allowed_city_ids"])
    new_cities = _clean_cities(new_role, cities_in)

    changes = []
    if new_name != target["display_name"]:
        changes.append("name")
    if new_role != target["role"]:
        changes.append(f"role {target['role']}->{new_role}")
    if new_cities != json.loads(target["allowed_city_ids"]):
        changes.append(f"cities={','.join(new_cities) or 'none'}")
    if new_active != target["active"]:
        changes.append("activated" if new_active else "deactivated")

    with transaction(conn):
        losing_super = target["role"] == "super_admin" and target["active"] and (new_role != "super_admin" or not new_active)
        if losing_super and _active_super_admins(conn) <= 1:
            raise UserError("The last super admin cannot be demoted or deactivated.", 409)
        conn.execute(
            "UPDATE users SET display_name = ?, role = ?, allowed_city_ids = ?, active = ?, updated_at = ? WHERE id = ?",
            (new_name, new_role, json.dumps(new_cities), new_active, now_iso(), user_id),
        )
        # A role change or deactivation ends existing sessions, so new rights apply at once.
        if new_role != target["role"] or not new_active:
            revoke_all(conn, user_id)
        audit.append(conn, actor=actor.username, role=actor.role, action="user.update", target=target["username"],
                     detail="; ".join(changes) or "no changes", ip=actor.ip)
    return public_user(_get(conn, user_id), actor)


def reset_password(conn: sqlite3.Connection, actor: Actor, user_id: str, password: str) -> None:
    target = _get(conn, user_id)
    if actor.id != user_id and not can_manage(actor.role, target["role"]):
        raise UserError("You cannot change this account's password.", 403)
    problems = policy_problems(password, target["username"])
    if problems:
        raise UserError(" ".join(problems))
    password_hash = hash_password(password)
    with transaction(conn):
        conn.execute(
            "UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
            (password_hash, now_iso(), user_id),
        )
        revoke_all(conn, user_id)  # every device must sign in again with the new password
        audit.append(conn, actor=actor.username, role=actor.role, action="user.password_reset", target=target["username"],
                     detail="password replaced (never logged); sessions revoked", ip=actor.ip)


def delete_user(conn: sqlite3.Connection, actor: Actor, user_id: str) -> None:
    target = _get(conn, user_id)
    if actor.id == user_id:
        raise UserError("You cannot delete your own account.", 403)
    if not can_manage(actor.role, target["role"]):
        raise UserError("You cannot delete this account.", 403)
    with transaction(conn):
        if target["role"] == "super_admin" and target["active"] and _active_super_admins(conn) <= 1:
            raise UserError("The last super admin cannot be deleted.", 409)
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))  # sessions go with it (ON DELETE CASCADE)
        audit.append(conn, actor=actor.username, role=actor.role, action="user.delete", target=target["username"],
                     detail=f"role={target['role']}", ip=actor.ip)
