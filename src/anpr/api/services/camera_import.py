"""Camera registry CSV import: validate every row, then preview or write.

    city,name,kind,district,street_address,latitude,longitude,view_direction_deg,lane,installed_on,
    owner,protocol,host,port,stream_path,vlan,firmware_version,notes

- UTF-8, exactly these columns (any order). Size and row count are capped (MAX_CSV_BYTES/ROWS).
- `city` is the name of an existing city. Each row goes through the same Pydantic model as the
  API (schemas.CameraIn), so a CSV row can never be laxer than a form submission.
- There are no credential columns, on purpose: credentials are set one camera at a time through
  the write-only endpoint. A file with a username/password-like column is refused as a whole.
- Duplicates (same city + name) inside the file or already in the registry are rejected.
- Text cells starting with = + - @ are rejected (CSV injection), except the numeric columns,
  where a minus sign is a legitimate negative coordinate.
- preview  returns accepted and rejected rows and writes nothing
- confirm  inserts the accepted cameras; the caller writes one audit entry carrying the file's
           SHA-256 and the counts, in the same transaction.
"""

import csv
import hashlib
import io
from dataclasses import dataclass, field

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api import schemas
from anpr.db.models import Camera, City

COLUMNS = ("city", "name", "kind", "district", "street_address", "latitude", "longitude", "view_direction_deg",
           "lane", "installed_on", "owner", "protocol", "host", "port", "stream_path", "vlan",
           "firmware_version", "notes")
NUMERIC = {"latitude", "longitude", "view_direction_deg", "port", "vlan"}
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
SECRET_HINTS = ("user", "pass", "pwd", "secret", "token", "credential")
TEMPLATE = (",".join(COLUMNS) + "\n"
            + "Rabat,Agdal gate 1,anpr_camera,Agdal,Avenue de France,34.0007,-6.8498,90,2,2026-01-15,"
              "City of Rabat,rtsps,10.20.0.11,322,/stream1,120,4.2.1,North-bound lane\n")


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
    accepted: list[dict] = field(default_factory=list)   # {"line", "camera": CameraIn}
    rejected: list[dict] = field(default_factory=list)   # {"line", "name", "reasons"}


def _reasons(err: ValidationError) -> list[str]:
    out = []
    for e in err.errors():
        loc = ".".join(str(p) for p in e.get("loc", ())) or "row"
        out.append(f"{loc}: {e.get('msg', 'invalid')}".replace("Value error, ", ""))
    return out


def parse(db: Session, file_name: str, data: bytes, *, max_bytes: int, max_rows: int) -> ParsedImport:
    if len(data) > max_bytes:
        raise CsvImportError(f"File too large (limit {max_bytes} bytes).", 413)
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise CsvImportError("The file must be UTF-8 encoded CSV.") from None

    reader = csv.DictReader(io.StringIO(text, newline=""))
    header = tuple((h or "").strip().lower() for h in (reader.fieldnames or ()))
    if any(hint in h for h in header for hint in SECRET_HINTS):
        raise CsvImportError("Credentials cannot be imported by CSV. Remove the column and set them per "
                             "camera with 'Replace credentials'.")
    if sorted(header) != sorted(COLUMNS):
        raise CsvImportError(f"Columns must be exactly: {','.join(COLUMNS)}")
    reader.fieldnames = list(header)

    result = ParsedImport(file_name=(file_name or "upload.csv")[:200], sha256=hashlib.sha256(data).hexdigest())
    cities = {name.lower(): cid for cid, name in db.execute(select(City.id, City.name))}
    existing = {(cid, name.lower()) for cid, name in db.execute(select(Camera.city_id, Camera.name))}
    seen: dict[tuple, int] = {}
    try:
        for row in reader:
            if not any((v or "").strip() for v in row.values() if isinstance(v, str)):
                continue  # blank line
            result.rows_total += 1
            if result.rows_total > max_rows:
                raise CsvImportError(f"Too many rows (limit {max_rows}).", 413)
            line = reader.line_num
            name = (row.get("name") or "").strip()[:80]
            if None in row:
                result.rejected.append({"line": line, "name": name, "reasons": ["row has more cells than the header"]})
                continue

            reasons: list[str] = []
            cells = {k: (row.get(k) or "").strip() for k in COLUMNS}
            for k, v in cells.items():
                if k not in NUMERIC and v.startswith(FORMULA_PREFIXES):
                    reasons.append(f"{k}: must not start with = + - @")
                if any(ord(c) < 32 for c in v):
                    reasons.append(f"{k}: control characters are not allowed")
            city_id = cities.get(cells["city"].lower())
            if city_id is None:
                reasons.append("city: no city with this name; add it first")

            camera = None
            if not reasons:
                payload = {k: v for k, v in cells.items() if k != "city" and v != ""}
                try:
                    camera = schemas.CameraIn(city_id=city_id, **payload)
                except ValidationError as e:
                    reasons = _reasons(e)
            if camera is not None:
                key = (city_id, camera.name.lower())
                if key in seen:
                    reasons = [f"duplicate of line {seen[key]} in this file"]
                elif key in existing:
                    reasons = ["a camera with this name already exists in this city"]
                else:
                    seen[key] = line
            if reasons:
                result.rejected.append({"line": line, "name": name, "reasons": reasons})
            else:
                result.accepted.append({"line": line, "camera": camera})
    except csv.Error:
        raise CsvImportError("The file is not valid CSV.") from None
    return result


def write(db: Session, parsed: ParsedImport) -> list[Camera]:
    """Insert the accepted cameras (caller audits and commits)."""
    cameras = [Camera(**row["camera"].model_dump()) for row in parsed.accepted]
    db.add_all(cameras)
    db.flush()
    return cameras
