"""Request and response models (Pydantic v2).

Inputs are strict: unknown fields are refused (extra="forbid"), every string has a length cap,
numbers have ranges. JSON uses camelCase, like the dashboard. Credentials only appear in
CameraCredentialsIn, which is write-only: no response model has a credentials field.
"""

import ipaddress
import re
import uuid
from datetime import date, datetime
from typing import Annotated, Literal
from urllib.parse import parse_qsl

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from anpr.db.models import (
    ALERT_KINDS,
    ALERT_STATUSES,
    CAMERA_KINDS,
    CAMERA_PROTOCOLS,
    CAMERA_STATUSES,
    ROLES,
    WATCHLIST_REASONS,
)

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Justification = Annotated[str, StringConstraints(strip_whitespace=True, min_length=20, max_length=1000)]
Username = Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=32,
                                            pattern=r"^[a-z0-9._-]+$")]
Password = Annotated[str, StringConstraints(min_length=1, max_length=256)]
Sha256Hex = Annotated[str, StringConstraints(to_lower=True, pattern=r"^[0-9a-fA-F]{64}$")]

Role = Literal[ROLES]
CameraKind = Literal[CAMERA_KINDS]
CameraProtocol = Literal[CAMERA_PROTOCOLS]
CameraStatus = Literal[CAMERA_STATUSES]
AlertKind = Literal[ALERT_KINDS]
AlertStatus = Literal[ALERT_STATUSES]


_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
# Query keys that would carry a secret in a stream path (some cameras accept ?user=..&password=..).
_SECRET_KEYS = {"user", "username", "usr", "password", "pass", "passwd", "pwd", "token", "auth", "key", "secret"}


def _host(value: str | None) -> str | None:
    """A bare hostname or IP address: no scheme, no credentials, no port, no path."""
    if value is None:
        return None
    value = value.strip().lower()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        pass
    if "://" in value or "@" in value:
        raise ValueError("host is a hostname or IP only: no scheme and no credentials")
    if any(c in value for c in "/:?# 	"):
        raise ValueError("host is a hostname or IP only: put the port and stream path in their own fields")
    labels = value.rstrip(".").split(".")
    if len(value) > 253 or not all(_LABEL.match(label) for label in labels):
        raise ValueError("host is not a valid hostname or IP address")
    if labels[-1].isdigit():
        raise ValueError("host looks like an IP address but is not a valid one")
    return value.rstrip(".")


def _stream_path(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    if "://" in value or "@" in value:
        raise ValueError("stream_path is a path only: no scheme and no credentials (use PUT /credentials)")
    if not value.startswith("/"):
        raise ValueError("stream_path must start with '/'")
    if any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError("stream_path must not contain spaces or control characters")
    _, _, query = value.partition("?")
    if any(key.lower() in _SECRET_KEYS for key, _ in parse_qsl(query, keep_blank_values=True)):
        raise ValueError("stream_path must not carry credentials in its query string (use PUT /credentials)")
    return value


def _aware(value: datetime | None) -> datetime | None:
    if value is not None and value.tzinfo is None:
        raise ValueError("timestamp must include a timezone (use UTC, e.g. 2026-10-08T12:00:00Z)")
    return value


Host = Annotated[str, StringConstraints(max_length=255), AfterValidator(_host)]
StreamPath = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200), AfterValidator(_stream_path)]
Notes = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
AwareDatetime = Annotated[datetime, AfterValidator(_aware)]


class In(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


# ---- auth ----------------------------------------------------------------------------

class LoginIn(In):
    username: Annotated[str, StringConstraints(max_length=64)]
    password: Password


class LoginOut(Out):
    mfa_required: bool = True
    mfa_enrolled: bool


class MfaIn(In):
    code: Annotated[str, StringConstraints(strip_whitespace=True, max_length=10)]


class MfaSetupOut(Out):
    otpauth_uri: str
    secret: str


class MeOut(Out):
    id: uuid.UUID
    username: str
    role: str
    city_ids: list[uuid.UUID] | None


# ---- cities ---------------------------------------------------------------------------

class CityIn(In):
    name: Name
    region: Name


class CityPatch(In):
    name: Name | None = None
    region: Name | None = None


class CityOut(Out):
    id: uuid.UUID
    name: str
    region: str


# ---- users ----------------------------------------------------------------------------

class UserCreateIn(In):
    username: Username
    password: Password
    role: Role
    city_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)


class UserPatch(In):
    role: Role | None = None
    is_active: bool | None = None
    city_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)


class PasswordIn(In):
    password: Password


class UserOut(Out):
    id: uuid.UUID
    username: str
    role: str
    is_active: bool
    mfa_enrolled: bool
    locked: bool
    city_ids: list[uuid.UUID]
    created_at: datetime


# ---- cameras --------------------------------------------------------------------------

class CameraIn(In):
    city_id: uuid.UUID
    name: Name
    kind: CameraKind
    district: Name | None = None
    street_address: ShortText | None = None
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    view_direction_deg: int | None = Field(default=None, ge=0, le=359)
    lane: Annotated[str, StringConstraints(max_length=20)] | None = None
    installed_on: date | None = None
    owner: Name | None = None
    host: Host | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    protocol: CameraProtocol
    stream_path: StreamPath | None = None
    vlan: int | None = Field(default=None, ge=1, le=4094)
    firmware_version: Annotated[str, StringConstraints(max_length=40)] | None = None
    status: CameraStatus = "unknown"
    notes: Notes | None = None


class CameraPatch(In):
    """Every field optional; city_id cannot change (create a new camera instead)."""
    name: Name | None = None
    kind: CameraKind | None = None
    district: Name | None = None
    street_address: ShortText | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    view_direction_deg: int | None = Field(default=None, ge=0, le=359)
    lane: Annotated[str, StringConstraints(max_length=20)] | None = None
    installed_on: date | None = None
    owner: Name | None = None
    host: Host | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    protocol: CameraProtocol | None = None
    stream_path: StreamPath | None = None
    vlan: int | None = Field(default=None, ge=1, le=4094)
    firmware_version: Annotated[str, StringConstraints(max_length=40)] | None = None
    status: CameraStatus | None = None
    notes: Notes | None = None


class CameraCredentialsIn(In):
    """Write-only. Sent in a PUT body over TLS, encrypted at rest, never returned or logged."""
    username: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=256)]


class CameraOut(Out):
    id: uuid.UUID
    city_id: uuid.UUID
    name: str
    kind: str
    district: str | None
    street_address: str | None
    latitude: float
    longitude: float
    view_direction_deg: int | None
    lane: str | None
    installed_on: date | None
    owner: str | None
    host: str | None
    port: int | None
    protocol: str
    stream_path: str | None
    vlan: int | None
    firmware_version: str | None
    credentials_set: bool
    status: str
    last_frame_at: datetime | None
    tls_not_after: datetime | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class CameraMapOut(Out):
    id: uuid.UUID
    name: str
    kind: str
    district: str | None
    latitude: float
    longitude: float
    view_direction_deg: int | None
    status: str
    last_frame_at: datetime | None
    city_id: uuid.UUID
    city_name: str


class ConnectionTestIn(In):
    """Test a camera that is not saved yet (the Review step of the add-camera wizard)."""
    protocol: CameraProtocol
    host: Host
    port: int | None = Field(default=None, ge=1, le=65535)


class ProbeStepOut(Out):
    name: Literal["dns", "tcp", "tls"]
    ok: bool
    ms: float | None
    detail: str


class ConnectionTestOut(Out):
    """reachable means a TCP connection (and TLS handshake for rtsps) succeeded. It never means
    the stream decodes: `verdict` says "Network reachable, stream not verified"."""
    reachable: bool
    verdict: str
    latency_ms: float | None
    steps: list[ProbeStepOut]
    tls_not_after: datetime | None
    tested_at: datetime


class StatusEventOut(Out):
    status: str
    reason: str
    at: datetime


class CameraAuditOut(Out):
    seq: int
    ts: datetime
    actor_role: str
    action: str
    justification: str | None


class CameraImportAccepted(Out):
    line: int
    name: str
    city_id: uuid.UUID
    kind: str
    protocol: str


class CameraImportRejected(Out):
    line: int
    name: str
    reasons: list[str]


class CameraImportOut(Out):
    mode: Literal["preview", "confirm"]
    file_name: str
    sha256: str
    rows_total: int
    rows_accepted: int
    rows_rejected: int
    accepted: list[CameraImportAccepted]
    rejected: list[CameraImportRejected]


# ---- watchlists -----------------------------------------------------------------------

class WatchlistListIn(In):
    name: Name
    source: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class WatchlistListOut(Out):
    id: uuid.UUID
    name: str
    source: str
    created_at: datetime
    active_entries: int = 0


class RejectedRow(Out):
    line: int
    plate: str
    reasons: list[str]


class AcceptedRow(Out):
    line: int
    plate_canonical: str
    reason: str
    color: str | None
    make: str | None
    model: str | None
    vehicle_type: str | None
    case_ref: str | None
    source: str | None
    expires_at: datetime | None


class ImportResultOut(Out):
    mode: Literal["preview", "confirm"]
    file_name: str
    sha256: str
    rows_total: int
    rows_accepted: int
    rows_rejected: int
    accepted: list[AcceptedRow]
    rejected: list[RejectedRow]
    import_id: uuid.UUID | None = None
    version: int | None = None


class WatchlistImportOut(Out):
    id: uuid.UUID
    list_id: uuid.UUID
    file_name: str
    sha256: str
    rows_total: int
    rows_accepted: int
    rows_rejected: int
    rejected_report: list
    imported_by: uuid.UUID
    imported_at: datetime
    version: int


WatchlistReason = Literal[WATCHLIST_REASONS]
Cell = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class WatchlistEntryIn(In):
    """The plate is validated and stored in canonical form by the route."""
    plate: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=30)]
    reason: WatchlistReason
    color: Annotated[str, StringConstraints(strip_whitespace=True, max_length=30)] | None = None
    make: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    model: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)] | None = None
    vehicle_type: Annotated[str, StringConstraints(strip_whitespace=True, max_length=30)] | None = None
    case_ref: Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)] | None = None
    source: Cell | None = None
    expires_at: AwareDatetime | None = None


class WatchlistEntryOut(Out):
    id: uuid.UUID
    list_id: uuid.UUID
    import_id: uuid.UUID | None
    plate_canonical: str
    reason: str
    color: str | None
    make: str | None
    model: str | None
    vehicle_type: str | None
    case_ref: str | None
    source: str | None
    added_at: datetime
    expires_at: datetime | None
    removed_at: datetime | None
    status: Literal["active", "expired", "removed"] = "active"


class EntryRemoveIn(In):
    justification: Justification


class EntryExpireIn(In):
    expires_at: AwareDatetime
    justification: Justification


# ---- alerts and overview -----------------------------------------------------------------

ReviewAction = Literal["approve", "reject", "escalate"]


class CharOut(Out):
    char: str
    confidence: float


class AlertEntryOut(Out):
    id: uuid.UUID
    list_id: uuid.UUID
    list_name: str
    plate: str
    reason: str
    case_ref: str | None
    source: str | None
    color: str | None
    make: str | None
    model: str | None
    added_at: datetime
    expires_at: datetime | None


class AlertDecisionOut(Out):
    action: ReviewAction
    justification: str
    reviewer: str
    decided_at: datetime


class AlertOut(Out):
    """One watchlist match. `plate` is the OCR read in full for reviewers (they must compare it
    with the image) and masked for everyone else (`plate_masked` says which)."""
    id: uuid.UUID
    detection_id: uuid.UUID
    plate: str
    plate_masked: bool
    plate_confidence: float
    chars: list[CharOut]
    camera_id: uuid.UUID
    camera_name: str
    camera_address: str | None = None
    camera_latitude: float | None = None
    camera_longitude: float | None = None
    camera_view_deg: int | None = None
    city_id: uuid.UUID
    city_name: str
    observed_at: datetime
    received_at: datetime
    kind: str
    match_score: float
    observed_color: str | None
    observed_make: str | None
    observed_model: str | None
    evidence_sha256: str | None
    plate_box: list[float] | None = None
    speed_kmh: float | None = None
    watchlist_entry: AlertEntryOut
    status: str
    created_at: datetime
    decision: AlertDecisionOut | None


class ReviewIn(In):
    action: ReviewAction
    justification: Justification


class DetectionPurgeIn(In):
    justification: Justification
    # Pending alerts are kept unless asked: a person must decide every watchlist match.
    include_pending: bool = False


class DetectionPurgeOut(Out):
    detections: int
    alerts: int
    evidence_files: int
    kept_pending: int


class AuditExportIn(In):
    rows: int = Field(ge=0, le=1_000_000)
    filters: Annotated[str, StringConstraints(max_length=500)] = ""


class IntegrityOut(Out):
    ok: bool
    entries: int
    first_bad_seq: int | None
    reason: str | None


class OverviewOut(Out):
    """Counts from real detections and alerts, city-scoped. Times are UTC days and hours."""
    plates_today: int
    watchlist_hits_today: int
    pending_alerts: int
    avg_latency_ms: float | None
    active_cameras: int
    total_cameras: int
    integrity: IntegrityOut | None            # only for roles with audit.verify
    daily: list[dict]                         # 14 days: {day, reads, hits, latencyMs, camerasReporting}
    hourly: list[dict]                        # 24 hours: {hour, reads, hits}


# ---- detections -----------------------------------------------------------------------

def _box_inside_frame(box: list[float]) -> list[float]:
    x, y, w, h = box
    if w <= 0 or h <= 0 or x + w > 1.0001 or y + h > 1.0001:
        raise ValueError("plate box must lie inside the frame")
    return box


# [x, y, w, h] of the plate in the evidence frame, as fractions of its width and height.
PlateBox = Annotated[list[Annotated[float, Field(ge=0, le=1)]], Field(min_length=4, max_length=4),
                     AfterValidator(_box_inside_frame)]


class DetectionIn(In):
    """The unified event from a camera (video) or a radar."""
    camera_id: uuid.UUID
    observed_at: AwareDatetime
    source_kind: Literal["video", "radar"]
    plate_raw: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    char_confidences: list[Annotated[float, Field(ge=0, le=1)]] = Field(default_factory=list, max_length=20)
    plate_confidence: float = Field(ge=0, le=1)
    observed_color: Annotated[str, StringConstraints(max_length=30)] | None = None
    observed_make: Annotated[str, StringConstraints(max_length=40)] | None = None
    observed_model: Annotated[str, StringConstraints(max_length=40)] | None = None
    evidence_sha256: Sha256Hex | None = None
    evidence_uri: Annotated[str, StringConstraints(max_length=300, pattern=r"^(https|s3)://\S+$")] | None = None
    plate_box: PlateBox | None = None
    speed_kmh: float | None = Field(default=None, ge=0, le=400)


class DetectionOut(Out):
    id: uuid.UUID
    plate_valid: bool
    alerts_created: int


# ---- plates ---------------------------------------------------------------------------

class ReadOut(Out):
    """One plate read, always masked. The full plate needs POST /plates/{id}/reveal."""
    detection_id: uuid.UUID
    plate_masked: str
    plate_valid: bool
    plate_confidence: float
    observed_at: datetime
    received_at: datetime
    source_kind: str
    camera_id: uuid.UUID
    camera_name: str
    city_id: uuid.UUID
    city_name: str
    observed_color: str | None
    observed_make: str | None
    observed_model: str | None
    evidence_sha256: str | None
    alerts: int


class EvidenceCheckIn(In):
    sha256: Sha256Hex


class EvidenceCheckOut(Out):
    detection_id: uuid.UUID
    recorded_sha256: str
    match: bool


class RevealIn(In):
    justification: Justification


class RevealOut(Out):
    detection_id: uuid.UUID
    plate_canonical: str | None
    plate_raw: str


# ---- audit ----------------------------------------------------------------------------

class AuditOut(Out):
    seq: int
    ts: datetime
    actor_id: str
    actor_role: str
    action: str
    target_type: str
    target_id: str | None
    justification: str | None
    ip: str
    prev_hash: str
    hash: str
    signature: str


class AuditVerifyOut(Out):
    ok: bool
    entries: int
    first_bad_seq: int | None
    reason: str | None


class PublicKeyOut(Out):
    algorithm: str = "Ed25519"
    public_key: str


# ---- security center, settings, models ------------------------------------------------

class SecurityCheckOut(Out):
    id: str
    title: str
    status: Literal["ok", "warn", "fail"]
    detail: str
    count: int | None = None
    area: str


class SecurityOverviewOut(Out):
    checked_at: datetime
    checks: list[SecurityCheckOut]
    recent_events: list[AuditOut]


class SystemSettingsOut(Out):
    app_env: str
    cors_origins: list[str]
    access_token_minutes: int
    refresh_token_days: int
    max_failed_logins: int
    lockout_minutes: int
    auth_rate_per_minute: int
    camera_rate_per_minute: int
    probe_rate_per_minute: int
    detection_rate_per_minute: int
    max_csv_bytes: int
    max_csv_rows: int
    allowed_camera_networks: list[str]
    data_key_ids: list[str]
    active_data_key_id: str
    trust_proxy_headers: bool


class PasswordChangeIn(In):
    current_password: Password
    new_password: Password


# ---- live monitoring ----------------------------------------------------------------------

class LiveBoxOut(Out):
    x: float                       # fractions of the frame (0..1)
    y: float
    w: float
    h: float
    box_confidence: float
    plate: str | None              # full for reviewers, masked otherwise; None if unread
    plate_masked: bool
    plate_valid: bool
    confidence: float
    reported: bool                 # sent to ingest (not suppressed as a repeat)


class LiveAlertOut(Out):
    id: uuid.UUID
    kind: str
    reason: str
    list_name: str
    plate: str


class LiveFrameOut(Out):
    width: int
    height: int
    inference_ms: float
    reads_plates: bool
    boxes: list[LiveBoxOut]
    alerts: list[LiveAlertOut]



class StreamStatusOut(Out):
    state: Literal["idle", "connecting", "live", "error"]
    message: str | None = None
    width: int | None = None
    height: int | None = None
    fps: float = 0.0
    viewers: int = 0
    reads: int = 0
    last_read_at: datetime | None = None
