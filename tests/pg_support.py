"""Shared PostgreSQL test harness for the /api/v1 backend.

Uses TEST_DATABASE_URL (from the environment or .env). Tests that need it are skipped with a
clear reason when it is not a reachable PostgreSQL URL, so the rest of the suite still runs.
The schema is rebuilt from the Alembic migrations (never create_all), so the tests also prove
the migrations work. The database is wiped at the start of each module that uses it.
"""

import base64
import os
import secrets
import uuid
from dataclasses import replace
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from anpr.utils.settings import Settings, load_env_file

ROOT = Path(__file__).resolve().parents[1]
load_env_file(str(ROOT / ".env"))
TEST_URL = os.environ.get("TEST_DATABASE_URL", "")
ORIGIN = "http://localhost:5173"


def _reachable(url: str) -> str | None:
    if not url.startswith("postgresql"):
        return "TEST_DATABASE_URL is not a PostgreSQL URL (run scripts/setup_local_postgres.py)"
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 3})
        with engine.connect():
            pass
        engine.dispose()
    except Exception as e:  # noqa: BLE001 - any failure means "skip", with the reason shown
        return f"PostgreSQL at TEST_DATABASE_URL is not reachable ({type(e).__name__})"
    return None


SKIP_REASON = _reachable(TEST_URL)
requires_pg = pytest.mark.skipif(SKIP_REASON is not None, reason=SKIP_REASON or "")


def data_key() -> str:
    return base64.b64encode(secrets.token_bytes(32)).decode()


def signing_key_b64() -> str:
    raw = Ed25519PrivateKey.generate().private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    return base64.b64encode(raw).decode()


def make_settings(**over) -> Settings:
    base = Settings(
        app_env="development", database_url=TEST_URL, jwt_secret=secrets.token_urlsafe(48),
        data_keys=f"k1:{data_key()}", active_data_key_id="k1", audit_signing_key=signing_key_b64(),
        detection_token_sha256="0" * 64, cors_origins=(ORIGIN,), camera_rate_per_minute=10_000,
        probe_rate_per_minute=10_000, auth_rate_per_minute=10_000,
    )
    return replace(base, **over)


def migrate_fresh(url: str = TEST_URL) -> None:
    """Drop everything, then run every migration up, down to 0001 and up again."""
    from alembic import command
    from alembic.config import Config

    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
        conn.execute(text("DROP FUNCTION IF EXISTS audit_entries_append_only() CASCADE"))
    engine.dispose()
    cfg = Config(toml_file=str(ROOT / "pyproject.toml"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0001")
    command.upgrade(cfg, "head")


def add_user(db: Session, username: str, role: str, city_ids=()) -> uuid.UUID:
    from anpr.db.models import User, UserCity

    user = User(username=username, password_hash="x", role=role, is_active=True, failed_attempts=0)
    db.add(user)
    db.flush()
    db.add_all(UserCity(user_id=user.id, city_id=c) for c in city_ids)
    db.commit()
    return user.id


def cookie(settings: Settings, user_id: uuid.UUID) -> dict[str, str]:
    from anpr.security.tokens import create_jwt

    return {"Cookie": f"access_token={create_jwt(settings.jwt_secret, str(user_id), 'access', 15)}"}
