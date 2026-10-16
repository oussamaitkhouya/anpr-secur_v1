"""Stolen-vehicle watchlist CSV import: validate every row, then preview or write.

    plate,reason,color,make,model,vehicle_type,case_ref,source,expires_at

- The file must be UTF-8 with exactly these columns (any order). Size and row count are capped.
- Each row is checked on its own; a bad row is rejected with reasons and never blocks the good ones.
- Plates are normalised to the canonical form; invalid plates are rejected.
- Duplicates inside the file, plates already active on the list, and expiry dates in the past
  are rejected.
- Text cells that start with = + - @ are rejected: they could run as formulas if someone later
  opens an export in a spreadsheet (CSV injection).
- preview  returns accepted and rejected rows and writes nothing
- confirm  writes the import record (file SHA-256, counts, rejected report, version) and the
           accepted entries, plus an audit entry, in one transaction. The same file (by SHA-256)
           cannot be imported twice into the same list.
"""

import csv
import hashlib
import io
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from anpr.db.models import WATCHLIST_REASONS, WatchlistEntry, WatchlistImport
from anpr.pipeline.matcher import canonical_or_none

COLUMNS = ("plate", "reason", "color", "make", "model", "vehicle_type", "case_ref", "source", "expires_at")
MAX_LENGTHS = {"color": 30, "make": 40, "model": 40, "vehicle_type": 30, "case_ref": 60, "source": 120}
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
TEMPLATE = ",".join(COLUMNS) + "\n"


class CsvImportError(Exception):
    """The file as a whole is unusable (encoding, header, size). Message is safe to show."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


@dataclass
class ParsedImport:
    file_name: str
    sha256: str
    rows_total: int = 0
    accepted: list[dict] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)


def _parse_expiry(value: str, now: datetime) -> datetime:
    """ISO date (end of that day, UTC) or ISO datetime with timezone."""
    try:
        if len(value) == 10:
            result = datetime.combine(date.fromisoformat(value), time(23, 59, 59), tzinfo=UTC)
        else:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("not an ISO date (YYYY-MM-DD)") from None
    if result.tzinfo is None:
        raise ValueError("needs a timezone, e.g. 2027-01-31T00:00:00Z")
    if result <= now:
        raise ValueError("is in the past")
    return result.astimezone(UTC)


def _check_row(row: dict, now: datetime) -> tuple[dict | None, list[str]]:
    reasons: list[str] = []
    clean: dict = {}
    for name in COLUMNS:
        value = (row.get(name) or "").strip()
        if value.startswith(FORMULA_PREFIXES) and name not in ("plate", "expires_at"):
            reasons.append(f"{name}: must not start with = + - @")
        if any(ord(c) < 32 for c in value):
            reasons.append(f"{name}: control characters are not allowed")
        clean[name] = value or None

    plate_canonical = canonical_or_none(clean["plate"] or "")
    if plate_canonical is None:
        reasons.append("plate: not a valid Moroccan plate (number|letter|region)")
    if clean["reason"] not in WATCHLIST_REASONS:
        reasons.append(f"reason: must be one of {', '.join(WATCHLIST_REASONS)}")
    for name, limit in MAX_LENGTHS.items():
        if clean[name] and len(clean[name]) > limit:
            reasons.append(f"{name}: longer than {limit} characters")
    expires_at = None
    if clean["expires_at"]:
        try:
            expires_at = _parse_expiry(clean["expires_at"], now)
        except ValueError as e:
            reasons.append(f"expires_at: {e}")
    if reasons:
        return None, reasons
    entry = {k: clean[k] for k in MAX_LENGTHS}
    entry.update(plate_canonical=plate_canonical, reason=clean["reason"], expires_at=expires_at)
    return entry, []


def parse(db: Session, list_id: uuid.UUID, file_name: str, data: bytes, max_bytes: int, max_rows: int,
          now: datetime | None = None) -> ParsedImport:
    now = now or datetime.now(UTC)
    if len(data) > max_bytes:
        raise CsvImportError(f"File too large (limit {max_bytes} bytes).", 413)
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise CsvImportError("The file must be UTF-8 encoded CSV.") from None

    reader = csv.DictReader(io.StringIO(text, newline=""))
    header = tuple((h or "").strip().lower() for h in (reader.fieldnames or ()))
    if sorted(header) != sorted(COLUMNS):
        raise CsvImportError(f"Columns must be exactly: {','.join(COLUMNS)}")
    reader.fieldnames = list(header)

    result = ParsedImport(file_name=file_name[:200], sha256=hashlib.sha256(data).hexdigest())
    already_active = set(db.scalars(select(WatchlistEntry.plate_canonical).where(
        WatchlistEntry.list_id == list_id, WatchlistEntry.removed_at.is_(None))))
    seen: dict[str, int] = {}
    try:
        for row in reader:
            if not any((v or "").strip() for v in row.values() if isinstance(v, str)):
                continue  # blank line
            result.rows_total += 1
            if result.rows_total > max_rows:
                raise CsvImportError(f"Too many rows (limit {max_rows}).", 413)
            line = reader.line_num
            if None in row:  # more cells than columns
                result.rejected.append({"line": line, "plate": (row.get("plate") or "")[:40],
                                        "reasons": ["row has more cells than the header"]})
                continue
            entry, reasons = _check_row(row, now)
            if entry is not None:
                plate = entry["plate_canonical"]
                if plate in seen:
                    reasons = [f"duplicate of line {seen[plate]} in this file"]
                elif plate in already_active:
                    reasons = ["already active on this list"]
            if reasons:
                result.rejected.append({"line": line, "plate": (row.get("plate") or "")[:40], "reasons": reasons})
                continue
            seen[entry["plate_canonical"]] = line
            result.accepted.append({"line": line, **entry})
    except csv.Error:
        raise CsvImportError("The file is not valid CSV.") from None
    return result


def previous_import_with_same_file(db: Session, list_id: uuid.UUID, sha256: str) -> WatchlistImport | None:
    return db.scalars(select(WatchlistImport).where(WatchlistImport.list_id == list_id,
                                                    WatchlistImport.sha256 == sha256)).first()


def write(db: Session, list_id: uuid.UUID, parsed: ParsedImport, imported_by: uuid.UUID) -> WatchlistImport:
    """Insert the import record and its entries (caller audits and commits)."""
    version = (db.scalar(select(func.max(WatchlistImport.version)).where(WatchlistImport.list_id == list_id)) or 0) + 1
    record = WatchlistImport(list_id=list_id, file_name=parsed.file_name, sha256=parsed.sha256,
                             rows_total=parsed.rows_total, rows_accepted=len(parsed.accepted),
                             rows_rejected=len(parsed.rejected), rejected_report=parsed.rejected,
                             imported_by=imported_by, version=version)
    db.add(record)
    db.flush()
    db.add_all(WatchlistEntry(list_id=list_id, import_id=record.id,
                              **{k: v for k, v in row.items() if k != "line"}) for row in parsed.accepted)
    db.flush()
    return record
