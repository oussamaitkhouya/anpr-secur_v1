"""Super admin: every permission in every city, sole manager of admin accounts, CLI promotion."""

import pytest
from fastapi.testclient import TestClient
from pg_support import (
    SKIP_REASON,
    TEST_URL,
    add_user,
    cookie,
    make_settings,
    migrate_fresh,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.main import create_app
from anpr.db import make_super_admin
from anpr.db.models import AuditEntry, User
from anpr.security import rbac
from anpr.security.keys import EnvKeyProvider

PASSWORD = "Correct-Horse-Battery-9"


def test_super_admin_has_every_permission_and_every_city():
    assert rbac.PERMISSIONS["super_admin"] == rbac.ALL_PERMISSIONS
    assert {"alerts.review", "plates.reveal", "users.write", "audit.verify"} <= rbac.PERMISSIONS["super_admin"]
    assert "super_admin" in rbac.UNSCOPED_ROLES
    assert not rbac.allowed("admin", "plates.reveal")  # admins keep the separation of duties


@pytest.fixture(scope="module")
def env():
    if SKIP_REASON:
        pytest.skip(SKIP_REASON)
    migrate_fresh()
    settings = make_settings()
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    app = create_app(settings, keys)
    db: Session = app.state.session_factory()
    root = add_user(db, "root1", "super_admin")
    admin = add_user(db, "admin1", "admin")
    analyst = add_user(db, "analyst1", "analyst")
    yield {"c": TestClient(app), "db": db, "settings": settings, "ids": {"root": root, "admin": admin, "analyst": analyst},
           "as": {"root": cookie(settings, root), "admin": cookie(settings, admin)}}
    db.close()
    app.state.engine.dispose()


def post(env, who, path, body):
    return env["c"].post(f"/api/v1{path}", json=body, headers=env["as"][who])


def patch(env, who, path, body):
    return env["c"].patch(f"/api/v1{path}", json=body, headers=env["as"][who])


def test_me_reports_super_admin(env):
    assert env["c"].get("/api/v1/auth/me", headers=env["as"]["root"]).json()["role"] == "super_admin"


def test_only_super_admin_creates_admins(env):
    assert post(env, "admin", "/admin/users", {"username": "admin2", "password": PASSWORD, "role": "admin"}).status_code == 403
    assert post(env, "admin", "/admin/users", {"username": "root2", "password": PASSWORD, "role": "super_admin"}).status_code == 403
    assert post(env, "admin", "/admin/users", {"username": "analyst2", "password": PASSWORD, "role": "analyst"}).status_code == 201
    assert post(env, "root", "/admin/users", {"username": "admin3", "password": PASSWORD, "role": "admin"}).status_code == 201


def test_admin_cannot_touch_privileged_accounts(env):
    ids = env["ids"]
    assert patch(env, "admin", f"/admin/users/{ids['analyst']}", {"role": "admin"}).status_code == 403
    assert patch(env, "admin", f"/admin/users/{ids['root']}", {"is_active": False}).status_code == 403
    assert env["c"].post(f"/api/v1/admin/users/{ids['root']}/reset-mfa", headers=env["as"]["admin"]).status_code == 403
    r = env["c"].put(f"/api/v1/admin/users/{ids['root']}/password", json={"password": PASSWORD}, headers=env["as"]["admin"])
    assert r.status_code == 403


def test_super_admin_cannot_demote_self(env):
    assert patch(env, "root", f"/admin/users/{env['ids']['root']}", {"role": "admin"}).status_code == 409


def test_cli_promotes_and_audits(env):
    db = env["db"]
    assert make_super_admin.main(["--username", "admin1"], url=TEST_URL) == 0
    db.expire_all()
    assert db.scalar(select(User.role).where(User.username == "admin1")) == "super_admin"
    entry = db.scalars(select(AuditEntry).where(AuditEntry.action == "user.update").order_by(AuditEntry.seq.desc())).first()
    assert entry.target_id == str(env["ids"]["admin"]) and "super_admin" in (entry.justification or "")
    assert make_super_admin.main(["--username", "nobody"], url=TEST_URL) == 1
