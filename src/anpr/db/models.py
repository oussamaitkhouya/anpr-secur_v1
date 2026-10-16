"""SQLAlchemy models for the production backend (PostgreSQL).

Conventions: UUID primary keys, every timestamp is timestamptz in UTC, enums are short strings
with CHECK constraints (easy to read in psql and to migrate), and every relation is a real
foreign key. The schema itself is created by Alembic (src/anpr/db/migrations), not create_all.
"""

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

ROLES = ("super_admin", "admin", "analyst", "auditor")
CAMERA_KINDS = ("fixed_cctv", "ptz", "anpr_camera", "radar")
CAMERA_PROTOCOLS = ("rtsps", "rtsp", "onvif", "file", "webhook", "mqtt")
CAMERA_STATUSES = ("online", "offline", "degraded", "maintenance", "unknown")
WATCHLIST_REASONS = ("stolen", "wanted", "other")
SOURCE_KINDS = ("video", "radar")
ALERT_KINDS = ("full_match", "plate_only_mismatch_vehicle", "fuzzy_match")
ALERT_STATUSES = ("pending", "approved", "rejected", "escalated")


def utcnow() -> datetime:
    return datetime.now(UTC)


def one_of(column: str, values: tuple[str, ...]) -> CheckConstraint:
    allowed = ", ".join(f"'{v}'" for v in values)
    return CheckConstraint(f"{column} IN ({allowed})", name=f"{column}_allowed")


def pk() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, default=uuid.uuid4)


def created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Base(DeclarativeBase):
    pass


class City(Base):
    __tablename__ = "cities"
    id: Mapped[uuid.UUID] = pk()
    name: Mapped[str] = mapped_column(String(80), unique=True)
    region: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = created()


class User(Base):
    __tablename__ = "users"
    __table_args__ = (one_of("role", ROLES),)
    id: Mapped[uuid.UUID] = pk()
    username: Mapped[str] = mapped_column(String(32), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16))
    # TOTP secret, AES-GCM encrypted (see anpr.security.crypto). NULL until the user sets up MFA.
    totp_secret_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    totp_key_id: Mapped[str | None] = mapped_column(String(32))
    totp_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    totp_last_step: Mapped[int | None] = mapped_column(BigInteger)  # blocks reuse of the same code
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()


class UserCity(Base):
    """The cities an analyst may see. Admins and auditors are not city-scoped."""
    __tablename__ = "user_cities"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    city_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cities.id", ondelete="RESTRICT"), primary_key=True)


class RefreshToken(Base):
    """Only the SHA-256 of each refresh token is stored. A token is single-use: refreshing marks it
    used and issues the next one in the same family. A used token presented again means it was
    stolen, so the whole family is revoked."""
    __tablename__ = "refresh_tokens"
    id: Mapped[uuid.UUID] = pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    family_id: Mapped[uuid.UUID] = mapped_column(index=True)
    token_sha256: Mapped[str] = mapped_column(String(64), unique=True)
    issued_at: Mapped[datetime] = created()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Camera(Base):
    __tablename__ = "cameras"
    __table_args__ = (
        one_of("kind", CAMERA_KINDS),
        one_of("protocol", CAMERA_PROTOCOLS),
        one_of("status", CAMERA_STATUSES),
        CheckConstraint("latitude BETWEEN -90 AND 90", name="latitude_range"),
        CheckConstraint("longitude BETWEEN -180 AND 180", name="longitude_range"),
        CheckConstraint("view_direction_deg IS NULL OR view_direction_deg BETWEEN 0 AND 359", name="view_direction_range"),
        CheckConstraint("port IS NULL OR port BETWEEN 1 AND 65535", name="port_range"),
        CheckConstraint("vlan IS NULL OR vlan BETWEEN 1 AND 4094", name="vlan_range"),
        CheckConstraint("(credentials_encrypted IS NULL) = (credentials_key_id IS NULL)", name="credentials_key_pair"),
        UniqueConstraint("city_id", "name"),
        Index("ix_cameras_city_status", "city_id", "status"),
    )
    id: Mapped[uuid.UUID] = pk()
    city_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cities.id", ondelete="RESTRICT"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(16))
    district: Mapped[str | None] = mapped_column(String(80))
    street_address: Mapped[str | None] = mapped_column(String(200))
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    view_direction_deg: Mapped[int | None] = mapped_column(Integer)
    lane: Mapped[str | None] = mapped_column(String(20))
    installed_on: Mapped[date | None] = mapped_column(Date)
    owner: Mapped[str | None] = mapped_column(String(80))
    # Hostname or IP only. The stream URL is assembled at runtime by the camera worker from
    # protocol + host + port + stream_path + decrypted credentials; it is never stored.
    host: Mapped[str | None] = mapped_column(String(253))
    port: Mapped[int | None] = mapped_column(Integer)
    protocol: Mapped[str] = mapped_column(String(10))
    stream_path: Mapped[str | None] = mapped_column(String(200))
    vlan: Mapped[int | None] = mapped_column(Integer)
    firmware_version: Mapped[str | None] = mapped_column(String(40))
    # Write-only: AES-GCM ciphertext of the JSON {"username", "password"}. Never returned by the API.
    credentials_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    credentials_key_id: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(12), default="unknown", index=True)
    last_frame_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tls_not_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = created()


class CameraStatusEvent(Base):
    """One row per status change (admin edit, maintenance toggle, connection test), for the
    status history in the camera detail drawer. Deleted with the camera."""
    __tablename__ = "camera_status_events"
    __table_args__ = (one_of("status", CAMERA_STATUSES),)
    id: Mapped[uuid.UUID] = pk()
    camera_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cameras.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(12))
    reason: Mapped[str] = mapped_column(String(120))
    at: Mapped[datetime] = created()


class WatchlistList(Base):
    __tablename__ = "watchlist_lists"
    id: Mapped[uuid.UUID] = pk()
    name: Mapped[str] = mapped_column(String(80), unique=True)
    source: Mapped[str] = mapped_column(String(120))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = created()


class WatchlistImport(Base):
    __tablename__ = "watchlist_imports"
    __table_args__ = (UniqueConstraint("list_id", "version"),)
    id: Mapped[uuid.UUID] = pk()
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("watchlist_lists.id", ondelete="RESTRICT"), index=True)
    file_name: Mapped[str] = mapped_column(String(200))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    rows_total: Mapped[int] = mapped_column(Integer)
    rows_accepted: Mapped[int] = mapped_column(Integer)
    rows_rejected: Mapped[int] = mapped_column(Integer)
    rejected_report: Mapped[list] = mapped_column(JSONB, default=list)
    imported_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    imported_at: Mapped[datetime] = created()
    version: Mapped[int] = mapped_column(Integer)


class WatchlistEntry(Base):
    __tablename__ = "watchlist_entries"
    __table_args__ = (
        one_of("reason", WATCHLIST_REASONS),
        # A plate is on a list at most once while active; removed rows stay for history.
        Index("uq_active_plate_per_list", "list_id", "plate_canonical", unique=True,
              postgresql_where=text("removed_at IS NULL")),
    )
    id: Mapped[uuid.UUID] = pk()
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("watchlist_lists.id", ondelete="RESTRICT"), index=True)
    import_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("watchlist_imports.id", ondelete="RESTRICT"))
    plate_canonical: Mapped[str] = mapped_column(String(20), index=True)
    reason: Mapped[str] = mapped_column(String(10))
    color: Mapped[str | None] = mapped_column(String(30))
    make: Mapped[str | None] = mapped_column(String(40))
    model: Mapped[str | None] = mapped_column(String(40))
    vehicle_type: Mapped[str | None] = mapped_column(String(30))
    case_ref: Mapped[str | None] = mapped_column(String(60))
    source: Mapped[str | None] = mapped_column(String(120))
    added_at: Mapped[datetime] = created()
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))


class DetectionEvent(Base):
    __tablename__ = "detection_events"
    __table_args__ = (
        one_of("source_kind", SOURCE_KINDS),
        CheckConstraint("plate_confidence BETWEEN 0 AND 1", name="plate_confidence_range"),
        CheckConstraint("speed_kmh IS NULL OR speed_kmh BETWEEN 0 AND 400", name="speed_range"),
    )
    id: Mapped[uuid.UUID] = pk()
    camera_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("cameras.id", ondelete="RESTRICT"), index=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    received_at: Mapped[datetime] = created()
    source_kind: Mapped[str] = mapped_column(String(8))
    plate_raw: Mapped[str] = mapped_column(String(40))
    plate_canonical: Mapped[str | None] = mapped_column(String(20), index=True)  # NULL if the read is not a valid plate
    char_confidences: Mapped[list] = mapped_column(JSONB, default=list)
    plate_confidence: Mapped[float] = mapped_column(Float)
    observed_color: Mapped[str | None] = mapped_column(String(30))
    observed_make: Mapped[str | None] = mapped_column(String(40))
    observed_model: Mapped[str | None] = mapped_column(String(40))
    evidence_sha256: Mapped[str | None] = mapped_column(String(64))
    evidence_uri: Mapped[str | None] = mapped_column(String(300))
    plate_box: Mapped[list | None] = mapped_column(JSONB)  # [x, y, w, h] fractions of the evidence frame
    speed_kmh: Mapped[float | None] = mapped_column(Float)


class Alert(Base):
    __tablename__ = "alerts"
    __table_args__ = (
        one_of("kind", ALERT_KINDS),
        one_of("status", ALERT_STATUSES),
        UniqueConstraint("detection_id", "entry_id"),
    )
    id: Mapped[uuid.UUID] = pk()
    detection_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("detection_events.id", ondelete="RESTRICT"), index=True)
    entry_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("watchlist_entries.id", ondelete="RESTRICT"))
    kind: Mapped[str] = mapped_column(String(30))
    score: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(10), default="pending", index=True)
    created_at: Mapped[datetime] = created()
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    justification: Mapped[str | None] = mapped_column(Text)


class AuditEntry(Base):
    """Append-only. UPDATE, DELETE and TRUNCATE are blocked by a trigger, and the app's DB role has
    only SELECT and INSERT on this table (see the 0001 migration)."""
    __tablename__ = "audit_entries"
    id: Mapped[uuid.UUID] = pk()
    seq: Mapped[int] = mapped_column(BigInteger, unique=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    actor_id: Mapped[str] = mapped_column(String(64))       # user id, "service:detections" or "anonymous"
    actor_role: Mapped[str] = mapped_column(String(16))
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[str | None] = mapped_column(String(64))
    justification: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str] = mapped_column(String(45))
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))
    signature: Mapped[str] = mapped_column(String(100))     # base64 Ed25519 signature of `hash`
