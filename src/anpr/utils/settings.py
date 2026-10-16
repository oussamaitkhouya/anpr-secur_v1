"""Runtime settings, read only from environment variables (see .env.example).

APP_ENV is one of:
    production   every secret must be set and must not be a placeholder; the app refuses to start otherwise
    development  same code paths as production, no fake data; secrets still come from the environment
    demo         like development, and scripts/seed_demo.py is allowed to insert fictional data

Secrets are never given defaults in code, so a forgotten variable fails loudly instead of
silently running with a known value.
"""

import os
from dataclasses import dataclass, field
from functools import lru_cache

APP_ENVS = ("production", "development", "demo")
# Values from .env.example. Seeing one of these in production means someone copied the example file.
PLACEHOLDER_MARKERS = ("change-me", "changeme", "placeholder", "example")


class SettingsError(RuntimeError):
    pass


def load_env_file(path: str = ".env") -> None:
    """Copy KEY=VALUE lines from a .env file into os.environ, without overriding variables that are
    already set (so the real environment always wins). Used by CLI tools, Alembic and the tests;
    uvicorn gets the same file with --env-file. A missing file is fine."""
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _get(env: dict, name: str, default: str | None = None) -> str:
    value = env.get(name, default)
    if value is None or value == "":
        raise SettingsError(f"environment variable {name} is required")
    return value


def _int(env: dict, name: str, default: int) -> int:
    try:
        return int(env.get(name, default))
    except ValueError:
        raise SettingsError(f"environment variable {name} must be an integer") from None


@dataclass(frozen=True)
class Settings:
    app_env: str
    database_url: str
    jwt_secret: str = field(repr=False)
    data_keys: str = field(repr=False)            # "k1:<base64 32 bytes>,k2:<...>"
    active_data_key_id: str
    audit_signing_key: str = field(repr=False)    # base64 of a raw 32-byte Ed25519 private key
    detection_token_sha256: str = field(repr=False)  # SHA-256 hex of the detection service token
    cors_origins: tuple[str, ...] = ()
    access_token_minutes: int = 15
    refresh_token_days: int = 7
    mfa_pending_minutes: int = 5
    max_failed_logins: int = 5
    lockout_minutes: int = 15
    auth_rate_per_minute: int = 10
    detection_rate_per_minute: int = 600
    max_body_bytes: int = 1_000_000
    max_csv_bytes: int = 2_000_000
    max_csv_rows: int = 10_000
    trust_proxy_headers: bool = False
    camera_rate_per_minute: int = 120
    probe_rate_per_minute: int = 20
    # CIDR ranges test-connection may reach even though they are normally refused (loopback,
    # link-local). Private LAN ranges are allowed by default: that is where cameras live.
    allowed_camera_networks: tuple[str, ...] = ()
    probe_timeout_seconds: float = 3.0
    live_frame_rate_per_minute: int = 240
    evidence_dir: str = "var/evidence"

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


def load_settings(env: dict | None = None) -> Settings:
    env = dict(os.environ if env is None else env)
    app_env = _get(env, "APP_ENV", "development")
    if app_env not in APP_ENVS:
        raise SettingsError(f"APP_ENV must be one of {', '.join(APP_ENVS)}")

    settings = Settings(
        app_env=app_env,
        database_url=_get(env, "DATABASE_URL"),
        jwt_secret=_get(env, "JWT_SECRET"),
        data_keys=_get(env, "APP_DATA_KEYS"),
        active_data_key_id=_get(env, "APP_ACTIVE_KEY_ID"),
        audit_signing_key=_get(env, "AUDIT_SIGNING_KEY"),
        detection_token_sha256=_get(env, "DETECTION_TOKEN_SHA256").lower(),
        cors_origins=tuple(o.strip() for o in env.get("CORS_ORIGINS", "").split(",") if o.strip()),
        access_token_minutes=_int(env, "ACCESS_TOKEN_MINUTES", 15),
        refresh_token_days=_int(env, "REFRESH_TOKEN_DAYS", 7),
        mfa_pending_minutes=_int(env, "MFA_PENDING_MINUTES", 5),
        max_failed_logins=_int(env, "MAX_FAILED_LOGINS", 5),
        lockout_minutes=_int(env, "LOCKOUT_MINUTES", 15),
        auth_rate_per_minute=_int(env, "AUTH_RATE_PER_MINUTE", 10),
        detection_rate_per_minute=_int(env, "DETECTION_RATE_PER_MINUTE", 600),
        max_body_bytes=_int(env, "MAX_BODY_BYTES", 1_000_000),
        max_csv_bytes=_int(env, "MAX_CSV_BYTES", 2_000_000),
        max_csv_rows=_int(env, "MAX_CSV_ROWS", 10_000),
        trust_proxy_headers=env.get("TRUST_PROXY_HEADERS", "false").lower() == "true",
        camera_rate_per_minute=_int(env, "CAMERA_RATE_PER_MINUTE", 120),
        probe_rate_per_minute=_int(env, "PROBE_RATE_PER_MINUTE", 20),
        live_frame_rate_per_minute=_int(env, "LIVE_FRAME_RATE_PER_MINUTE", 240),
        evidence_dir=env.get("EVIDENCE_DIR", "var/evidence"),
        allowed_camera_networks=tuple(n.strip() for n in env.get("ALLOWED_CAMERA_NETWORKS", "").split(",") if n.strip()),
    )

    if len(settings.jwt_secret) < 32:
        raise SettingsError("JWT_SECRET must be at least 32 characters")
    if len(settings.detection_token_sha256) != 64:
        raise SettingsError("DETECTION_TOKEN_SHA256 must be a SHA-256 hex digest")
    if settings.is_production:
        secrets = (settings.jwt_secret, settings.data_keys, settings.audit_signing_key, settings.database_url)
        if any(marker in s.lower() for s in secrets for marker in PLACEHOLDER_MARKERS):
            raise SettingsError("a secret still holds a placeholder value from .env.example")
        if "*" in settings.cors_origins:
            raise SettingsError("CORS_ORIGINS must list explicit origins in production")
    return settings


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return load_settings()
