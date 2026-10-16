"""Accounts API: login, lockout, sessions, who may manage whom, and the audit chain."""

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from anpr.api.app import create_app
from anpr.db import create_super_admin
from anpr.db.database import connect
from anpr.security import audit
from anpr.security.login import LOCKOUT, MAX_ATTEMPTS, login
from anpr.security.passwords import hash_password, policy_problems, verify_password
from anpr.security.sessions import create_session, resolve

ROOT_PW = "correct horse battery staple"
GOOD_PW = "a-long-enough-test-pass"


@pytest.fixture
def db_file(tmp_path):
    path = tmp_path / "test.sqlite3"
    answers = iter([ROOT_PW, ROOT_PW])
    assert create_super_admin.main(["--username", "root", "--db", str(path)], read_password=lambda _: next(answers)) == 0
    return path


@pytest.fixture
def client(db_file):
    return TestClient(create_app(db_file))


def sign_in(client, username, password):
    r = client.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def make_user(client, headers, username, role, password=GOOD_PW, cities=()):
    r = client.post("/users", headers=headers, json={"username": username, "name": username.title(), "role": role,
                                                      "password": password, "allowedCityIds": list(cities)})
    assert r.status_code == 201, r.text
    return r.json()


# ---- passwords and sessions ----------------------------------------------------------

def test_password_hash_is_argon2id_and_verifies():
    h = hash_password(GOOD_PW)
    assert h.startswith("$argon2id$")
    assert verify_password(h, GOOD_PW)
    assert not verify_password(h, GOOD_PW + "x")
    assert not verify_password("not-a-hash", GOOD_PW)


def test_password_policy():
    assert policy_problems("short", "bob")
    assert policy_problems("bob-is-my-password", "bob")  # contains the username
    assert policy_problems("aaaaaaaaaaaaaaaa")
    assert policy_problems("password1234")
    assert policy_problems(GOOD_PW, "bob") == []


def test_sessions_store_only_a_token_hash_and_expire(db_file):
    conn = connect(db_file)
    uid = conn.execute("SELECT id FROM users").fetchone()["id"]
    t0 = datetime(2026, 10, 8, tzinfo=timezone.utc)
    token, _ = create_session(conn, uid, now=t0)
    stored = conn.execute("SELECT token_hash FROM sessions").fetchone()["token_hash"]
    assert token not in stored
    assert resolve(conn, token, now=t0 + timedelta(hours=1)) is not None
    assert resolve(conn, token, now=t0 + timedelta(hours=9)) is None  # expired and removed
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


# ---- bootstrap -----------------------------------------------------------------------

def test_super_admin_bootstrap_runs_once(db_file):
    again = create_super_admin.main(["--username", "other", "--db", str(db_file)], read_password=lambda _: ROOT_PW)
    assert again == 1


def test_bootstrap_rejects_weak_or_mismatched_passwords(tmp_path):
    path = str(tmp_path / "x.sqlite3")
    assert create_super_admin.main(["--username", "root", "--db", path], read_password=lambda _: "short") == 2
    answers = iter([ROOT_PW, ROOT_PW + "!"])
    assert create_super_admin.main(["--username", "root", "--db", path], read_password=lambda _: next(answers)) == 2


# ---- login ---------------------------------------------------------------------------

def test_login_errors_do_not_reveal_whether_the_user_exists(client):
    unknown = client.post("/auth/login", json={"username": "nobody", "password": GOOD_PW})
    wrong = client.post("/auth/login", json={"username": "root", "password": GOOD_PW})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()


def test_lockout_after_repeated_failures(db_file):
    conn = connect(db_file)
    t0 = datetime.now(timezone.utc)
    for _ in range(MAX_ATTEMPTS):
        assert login(conn, "root", "wrong-password-123", "1.2.3.4", now=t0) is None
    # correct password, but locked
    assert login(conn, "root", ROOT_PW, "1.2.3.4", now=t0 + timedelta(minutes=1)) is None
    # after the lockout window it works again
    assert login(conn, "root", ROOT_PW, "1.2.3.4", now=t0 + LOCKOUT + timedelta(seconds=1)) is not None
    actions = [r["action"] for r in conn.execute("SELECT action FROM audit_log")]
    assert "auth.lockout" in actions


def test_me_and_logout(client):
    h = sign_in(client, "root", ROOT_PW)
    assert client.get("/auth/me", headers=h).json()["role"] == "super_admin"
    assert client.post("/auth/logout", headers=h).status_code == 204
    assert client.get("/auth/me", headers=h).status_code == 401
    assert client.get("/auth/me").status_code == 401


# ---- who may manage whom -------------------------------------------------------------

def test_super_admin_creates_admin_and_admin_is_limited(client):
    root = sign_in(client, "root", ROOT_PW)
    make_user(client, root, "boss", "admin")
    boss = sign_in(client, "boss", GOOD_PW)

    analyst = make_user(client, boss, "ana", "analyst", cities=["city-local", "city-local", "city-north"])
    assert analyst["allowedCityIds"] == ["city-local", "city-north"]  # deduplicated, sorted

    # an admin cannot create admins or super admins, nor promote anyone to admin
    for role in ("admin", "super_admin"):
        r = client.post("/users", headers=boss, json={"username": f"x{role}", "name": "X", "role": role, "password": GOOD_PW})
        assert r.status_code == 403
    assert client.patch(f"/users/{analyst['id']}", headers=boss, json={"role": "admin"}).status_code == 403

    users = {u["username"]: u for u in client.get("/users", headers=boss).json()}
    assert users["ana"]["manageable"] is True
    assert users["root"]["manageable"] is False
    assert users["boss"]["manageable"] is False  # not even yourself, for role changes


def test_analysts_and_auditors_cannot_manage_accounts(client):
    root = sign_in(client, "root", ROOT_PW)
    make_user(client, root, "ana", "analyst")
    make_user(client, root, "audi", "auditor")
    for name in ("ana", "audi"):
        h = sign_in(client, name, GOOD_PW)
        assert client.get("/users", headers=h).status_code == 403
        assert client.post("/users", headers=h, json={"username": "zz9", "name": "Z", "role": "analyst", "password": GOOD_PW}).status_code == 403


def test_last_super_admin_and_self_are_protected(client):
    root = sign_in(client, "root", ROOT_PW)
    me = client.get("/auth/me", headers=root).json()
    assert client.delete(f"/users/{me['id']}", headers=root).status_code == 403
    assert client.patch(f"/users/{me['id']}", headers=root, json={"role": "admin"}).status_code == 403
    assert client.patch(f"/users/{me['id']}", headers=root, json={"active": False}).status_code == 403

    second = make_user(client, root, "root2", "super_admin")
    r2 = sign_in(client, "root2", GOOD_PW)
    # with two super admins, one may demote the other, but not the last one left
    assert client.patch(f"/users/{me['id']}", headers=r2, json={"role": "admin"}).status_code == 200
    root_as_admin = sign_in(client, "root", ROOT_PW)
    assert client.delete(f"/users/{second['id']}", headers=root_as_admin).status_code == 403


def test_role_change_deactivation_and_reset_end_sessions(client):
    root = sign_in(client, "root", ROOT_PW)
    ana = make_user(client, root, "ana", "analyst")
    h = sign_in(client, "ana", GOOD_PW)
    client.patch(f"/users/{ana['id']}", headers=root, json={"role": "auditor"})
    assert client.get("/auth/me", headers=h).status_code == 401

    h = sign_in(client, "ana", GOOD_PW)
    assert client.put(f"/users/{ana['id']}/password", headers=root, json={"password": "another-long-password"}).status_code == 204
    assert client.get("/auth/me", headers=h).status_code == 401
    assert client.post("/auth/login", json={"username": "ana", "password": GOOD_PW}).status_code == 401
    h = sign_in(client, "ana", "another-long-password")

    client.patch(f"/users/{ana['id']}", headers=root, json={"active": False})
    assert client.get("/auth/me", headers=h).status_code == 401
    assert client.post("/auth/login", json={"username": "ana", "password": "another-long-password"}).status_code == 401


def test_validation(client):
    root = sign_in(client, "root", ROOT_PW)
    bad = [
        {"username": "A B", "name": "x", "role": "analyst", "password": GOOD_PW},
        {"username": "okname", "name": "x", "role": "wizard", "password": GOOD_PW},
        {"username": "okname", "name": "x", "role": "analyst", "password": "short"},
        {"username": "okname", "name": "x", "role": "analyst", "password": GOOD_PW, "allowedCityIds": ["../etc"]},
        {"username": "okname", "name": "x", "role": "analyst", "password": GOOD_PW, "isAdmin": True},  # unknown field
    ]
    for body in bad:
        assert client.post("/users", headers=root, json=body).status_code == 422, body
    make_user(client, root, "okname", "analyst")
    assert client.post("/users", headers=root, json={"username": "OKNAME", "name": "x", "role": "analyst", "password": GOOD_PW}).status_code == 409


# ---- secrets never leave, audit chain holds ------------------------------------------

def test_no_hash_or_password_in_any_response(client, db_file):
    root = sign_in(client, "root", ROOT_PW)
    make_user(client, root, "ana", "analyst")
    bodies = [client.get("/users", headers=root).text, client.get("/auth/me", headers=root).text]
    for text in bodies:
        assert "argon2" not in text and "password" not in text.lower() and GOOD_PW not in text
    conn = connect(db_file)
    log = " ".join(" ".join(str(v) for v in tuple(r)) for r in conn.execute("SELECT * FROM audit_log"))
    assert GOOD_PW not in log and ROOT_PW not in log


def test_every_action_is_audited_and_the_chain_verifies(client, db_file):
    root = sign_in(client, "root", ROOT_PW)
    ana = make_user(client, root, "ana", "analyst")
    client.patch(f"/users/{ana['id']}", headers=root, json={"name": "Ana B"})
    client.put(f"/users/{ana['id']}/password", headers=root, json={"password": "another-long-password"})
    client.delete(f"/users/{ana['id']}", headers=root)
    client.post("/auth/login", json={"username": "root", "password": "nope-nope-nope"})

    conn = connect(db_file)
    actions = [r["action"] for r in conn.execute("SELECT action FROM audit_log ORDER BY seq")]
    for a in ("user.create", "auth.login", "user.update", "user.password_reset", "user.delete", "auth.login_failed"):
        assert a in actions
    assert audit.verify(conn) == (True, None)
    assert client.get("/audit/verify", headers=root).json()["ok"] is True

    # tamper with one entry: verification points at it
    conn.execute("UPDATE audit_log SET detail = 'edited' WHERE seq = 3")
    ok, bad = audit.verify(conn)
    assert not ok and bad == 3


def test_failed_change_leaves_no_audit_entry(db_file):
    """The audit entry and the change it records commit together or not at all."""
    conn = connect(db_file)
    before = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
    with pytest.raises(sqlite3.IntegrityError):
        from anpr.db.database import transaction
        with transaction(conn):
            audit.append(conn, actor="t", role="system", action="test", target="x")
            conn.execute("INSERT INTO users (id) VALUES ('broken')")  # violates NOT NULL
    assert conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == before
