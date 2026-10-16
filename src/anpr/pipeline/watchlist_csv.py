"""Watchlist CSV validation, server side. Same rules as dashboard/src/lib/csvImport.ts: the browser
runs its copy for the preview, and this one decides, because a client's validation proves nothing.

    plate,reason,caseRef,source,expiresAt

A bad row is rejected with its reasons and never blocks the good ones. A problem with the whole
file (size, header, row count) rejects everything.
"""

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from anpr.pipeline.matcher import canonical_or_none

COLUMNS = ("plate", "reason", "caseRef", "source", "expiresAt")
MAX_ROWS = 5000
MAX_BYTES = 1_000_000
REASONS = ("stolen", "wanted", "other")
CASE_REF = re.compile(r"^[A-Za-z0-9._\-/]{1,40}$")
EXPIRY = re.compile(r"^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$")
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


@dataclass
class Row:
    line: int
    problems: list[str] = field(default_factory=list)
    entry: dict | None = None  # plate, reason, caseRef, source, expiresAt (ISO or None)


@dataclass
class Validation:
    fatal: str | None
    rows: list[Row] = field(default_factory=list)

    @property
    def accepted(self) -> int:
        return sum(1 for r in self.rows if r.entry)

    @property
    def rejected(self) -> int:
        return len(self.rows) - self.accepted


def parse_expiry(value: str) -> datetime | None:
    if not EXPIRY.match(value):
        return None
    try:
        if len(value) == 10:  # a bare date expires at the end of that day, UTC
            return datetime.fromisoformat(f"{value}T23:59:59+00:00")
        t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def validate(text: str, now: datetime, active_plates: set[str]) -> Validation:
    if len(text.encode()) > MAX_BYTES:
        return Validation(f"The file is larger than {MAX_BYTES // 1_000_000} MB.")
    try:
        table = [r for r in csv.reader(io.StringIO(text.lstrip("﻿")), strict=True) if r and r != [""]]
    except csv.Error:
        return Validation("The file is not valid CSV.")
    if not table:
        return Validation("The file is empty.")
    if [h.strip() for h in table[0]] != list(COLUMNS):
        return Validation(f"The first line must be exactly: {','.join(COLUMNS)}")
    body = table[1:]
    if not body:
        return Validation("The file has a header but no rows.")
    if len(body) > MAX_ROWS:
        return Validation(f"At most {MAX_ROWS} rows per import; this file has {len(body)}.")

    first_line: dict[str, int] = {}
    rows = []
    for i, cells in enumerate(body):
        row = Row(line=i + 2)
        rows.append(row)
        if len(cells) != len(COLUMNS):
            row.problems.append(f"Expected {len(COLUMNS)} columns, found {len(cells)}.")
            continue
        plate_raw, reason_raw, case_ref, source, expires_raw = (c.strip() for c in cells)
        if any(c.strip().startswith(FORMULA_PREFIXES) for c in cells):
            row.problems.append("A cell starts with = + - or @ (spreadsheet formula); refused.")
        plate = canonical_or_none(plate_raw)
        if not plate:
            row.problems.append("Plate is not number|letter|region with a known letter and region.")
        reason = reason_raw.lower()
        if reason not in REASONS:
            row.problems.append("Reason must be stolen, wanted or other.")
        if not CASE_REF.match(case_ref):
            row.problems.append("caseRef is required: letters, digits and . _ - / only, at most 40 characters.")
        if not source or len(source) > 60:
            row.problems.append("source is required (at most 60 characters).")
        expires_at = None
        if expires_raw:
            t = parse_expiry(expires_raw)
            if t is None:
                row.problems.append("expiresAt is not a date (use YYYY-MM-DD).")
            elif t <= now:
                row.problems.append(f"Already expired ({expires_raw}).")
            else:
                expires_at = t.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        if plate:
            if plate in first_line:
                row.problems.append(f"Duplicate of line {first_line[plate]}.")
            else:
                first_line[plate] = row.line
            if plate in active_plates:
                row.problems.append("Already active on a watchlist.")
        if not row.problems:
            row.entry = {"plate": plate, "reason": reason, "caseRef": case_ref, "source": source, "expiresAt": expires_at}
    return Validation(None, rows)
