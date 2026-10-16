"""Local SQLite database: accounts, sessions, the audit log, and the operational data (cities,
cameras, watchlists, plate reads, alerts, evidence).

The file lives under data/ (git-ignored). Override the location with ANPR_DB_PATH.
Uses only the standard library; one connection per request keeps it thread-safe.
"""

import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from anpr.utils.config import REPO_ROOT

DEFAULT_DB_PATH = REPO_ROOT / "data" / "app" / "anpr.sqlite3"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,
    username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name     TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('super_admin', 'admin', 'analyst', 'auditor')),
    password_hash    TEXT NOT NULL,
    allowed_city_ids TEXT NOT NULL DEFAULT '[]',   -- JSON list; used for analysts only
    active           INTEGER NOT NULL DEFAULT 1,
    failed_attempts  INTEGER NOT NULL DEFAULT 0,
    locked_until     TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    created_by       TEXT
);

-- Only a SHA-256 of each session token is stored: a copied database file holds no usable session.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- Append-only, hash-chained (see anpr.security.audit).
CREATE TABLE IF NOT EXISTS audit_log (
    seq       INTEGER PRIMARY KEY,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL,
    role      TEXT NOT NULL,
    action    TEXT NOT NULL,
    target    TEXT NOT NULL,
    detail    TEXT,
    ip        TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash      TEXT NOT NULL
);

-- ---- operational data (anpr.api.operations) ----------------------------------------
-- Added by an admin with scripts/init_db.py; nothing is pre-filled.

CREATE TABLE IF NOT EXISTS cities (
    id         TEXT PRIMARY KEY,               -- slug, e.g. "rabat"; users.allowed_city_ids refers to it
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

-- Credentials are AES-GCM ciphertext (anpr.security.crypto) and never leave the server.
CREATE TABLE IF NOT EXISTS cameras (
    id                    TEXT PRIMARY KEY,
    city_id               TEXT NOT NULL REFERENCES cities (id) ON DELETE RESTRICT,
    name                  TEXT NOT NULL,
    source_type           TEXT NOT NULL CHECK (source_type IN ('browser-webcam', 'rtsp', 'file')),
    endpoint              TEXT NOT NULL DEFAULT '',
    credentials_encrypted BLOB,
    credentials_key_id    TEXT,
    streaming             INTEGER NOT NULL DEFAULT 0,
    last_frame_at         TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    UNIQUE (city_id, name)
);

CREATE TABLE IF NOT EXISTS watchlist_lists (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist_imports (
    id            TEXT PRIMARY KEY,
    list_id       TEXT NOT NULL REFERENCES watchlist_lists (id) ON DELETE RESTRICT,
    file_name     TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    rows_total    INTEGER NOT NULL,
    rows_accepted INTEGER NOT NULL,
    rows_rejected INTEGER NOT NULL,
    imported_by   TEXT NOT NULL,
    imported_at   TEXT NOT NULL,
    version       INTEGER NOT NULL,
    UNIQUE (list_id, version)
);

CREATE TABLE IF NOT EXISTS watchlist_entries (
    id           TEXT PRIMARY KEY,
    list_id      TEXT NOT NULL REFERENCES watchlist_lists (id) ON DELETE RESTRICT,
    import_id    TEXT REFERENCES watchlist_imports (id) ON DELETE RESTRICT,
    plate        TEXT NOT NULL,                -- canonical number|letter|region
    reason       TEXT NOT NULL CHECK (reason IN ('stolen', 'wanted', 'other')),
    case_ref     TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT '',
    color        TEXT,
    make         TEXT,
    model        TEXT,
    vehicle_type TEXT,
    added_at     TEXT NOT NULL,
    expires_at   TEXT,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'removed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_plate_per_list ON watchlist_entries (list_id, plate) WHERE status = 'active';

-- One validated plate read. Frames are never stored: only the SHA-256 in the evidence record.
CREATE TABLE IF NOT EXISTS plate_reads (
    id            TEXT PRIMARY KEY,
    camera_id     TEXT NOT NULL REFERENCES cameras (id) ON DELETE RESTRICT,
    plate         TEXT NOT NULL,
    confidence    REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    chars         TEXT NOT NULL DEFAULT '[]',  -- JSON [{char, confidence}]
    captured_at   TEXT NOT NULL,
    latency_ms    INTEGER,
    watchlist_hit INTEGER NOT NULL DEFAULT 0,
    evidence_id   TEXT
);
CREATE INDEX IF NOT EXISTS ix_reads_captured ON plate_reads (captured_at);
CREATE INDEX IF NOT EXISTS ix_reads_camera ON plate_reads (camera_id);

-- A watchlist match. Always created 'pending': only a person moves it on.
CREATE TABLE IF NOT EXISTS alerts (
    id            TEXT PRIMARY KEY,
    read_id       TEXT NOT NULL REFERENCES plate_reads (id) ON DELETE RESTRICT,
    entry_id      TEXT NOT NULL REFERENCES watchlist_entries (id) ON DELETE RESTRICT,
    match_score   REAL NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'escalated')),
    created_at    TEXT NOT NULL,
    reviewer      TEXT,
    decided_at    TEXT,
    justification TEXT,
    audit_seq     INTEGER,
    UNIQUE (read_id, entry_id)
);
CREATE INDEX IF NOT EXISTS ix_alerts_status ON alerts (status);

-- Append-only, hash-chained and Ed25519-signed (see anpr.security.evidence).
CREATE TABLE IF NOT EXISTS evidence (
    seq       INTEGER PRIMARY KEY,
    id        TEXT NOT NULL UNIQUE,
    read_id   TEXT NOT NULL REFERENCES plate_reads (id) ON DELETE RESTRICT,
    payload   TEXT NOT NULL,                   -- canonical JSON; holds a plate digest, never the plate
    prev_hash TEXT NOT NULL,
    hash      TEXT NOT NULL,
    signature TEXT,
    key_id    TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def db_path() -> Path:
    return Path(os.environ.get("ANPR_DB_PATH") or DEFAULT_DB_PATH)


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    """Open (and create if needed) the database, with foreign keys on."""
    path = Path(path) if path else db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10, isolation_level=None, check_same_thread=False)  # autocommit; explicit BEGIN where needed
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    return conn


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """BEGIN IMMEDIATE ... COMMIT, or ROLLBACK on any exception."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
