"""Watchlists on PostgreSQL: lists, entries, CSV imports, removal and expiry.

Rules:
- Plates are stored in canonical form (number|letter|region, anpr.pipeline.validator). A plate
  that is not a valid Moroccan plate is refused, so a manual entry always matches what the
  cameras report.
- A plate is on a list at most once while active (partial unique index); removed entries stay
  for history, never deleted.
- Every change (create list, add, import, remove, expire) writes a signed audit entry in the
  same transaction. Audit text carries masked plates only.
- Full plates go to roles that manage watchlists (watchlists.write: admins). Analysts and
  auditors may read lists for oversight, with every plate masked.
- Rate limited per IP like the other registry routes.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from anpr.api import schemas
from anpr.api.deps import Db, audit, rate_limit, require
from anpr.api.services import watchlist_import
from anpr.db.models import WatchlistEntry, WatchlistImport, WatchlistList
from anpr.pipeline.matcher import canonical_or_none
from anpr.security import rbac
from anpr.security.masking import mask_fixed
from anpr.security.rbac import Actor

router = APIRouter(prefix="/watchlists", tags=["watchlists"],
                   dependencies=[Depends(rate_limit("watchlists", "camera_rate_per_minute"))])
ListsWrite = Annotated[Actor, Depends(require("watchlists.write"))]
ListsRead = Annotated[Actor, Depends(require("watchlists.read"))]


def _full(actor: Actor) -> bool:
    return rbac.allowed(actor.role, "watchlists.write")


def _entry_out(entry: WatchlistEntry, actor: Actor, now: datetime) -> schemas.WatchlistEntryOut:
    out = schemas.WatchlistEntryOut.model_validate(entry)
    if not _full(actor):
        out.plate_canonical = mask_fixed(entry.plate_canonical)
    out.status = "removed" if entry.removed_at else "expired" if entry.expires_at and entry.expires_at <= now else "active"
    return out


def _list_or_404(db, list_id: uuid.UUID) -> WatchlistList:
    wl = db.get(WatchlistList, list_id)
    if wl is None:
        raise HTTPException(404, "Watchlist not found.")
    return wl


def _active_counts(db) -> dict[uuid.UUID, int]:
    now = datetime.now(UTC)
    rows = db.execute(select(WatchlistEntry.list_id, func.count()).where(
        WatchlistEntry.removed_at.is_(None),
        WatchlistEntry.expires_at.is_(None) | (WatchlistEntry.expires_at > now)).group_by(WatchlistEntry.list_id))
    return dict(rows.all())


def _list_out(wl: WatchlistList, counts: dict) -> schemas.WatchlistListOut:
    out = schemas.WatchlistListOut.model_validate(wl)
    out.active_entries = counts.get(wl.id, 0)
    return out


@router.get("", response_model=list[schemas.WatchlistListOut], summary="All watchlists with their active entry counts")
def list_watchlists(actor: ListsRead, db: Db):
    counts = _active_counts(db)
    return [_list_out(wl, counts) for wl in db.scalars(select(WatchlistList).order_by(WatchlistList.name))]


@router.post("", response_model=schemas.WatchlistListOut, status_code=201)
def create_watchlist(body: schemas.WatchlistListIn, request: Request, actor: ListsWrite, db: Db):
    wl = WatchlistList(name=body.name, source=body.source, created_by=uuid.UUID(actor.id))
    db.add(wl)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A watchlist with this name already exists.") from None
    audit(request, db, actor, "watchlist.create", "watchlist", wl.id)
    db.commit()
    return _list_out(wl, {})


@router.get("/{list_id}/entries", response_model=list[schemas.WatchlistEntryOut])
def list_entries(list_id: uuid.UUID, actor: ListsRead, db: Db,
                 status: Annotated[Literal["active", "all"], Query()] = "all",
                 limit: Annotated[int, Query(ge=1, le=10_000)] = 5000):
    _list_or_404(db, list_id)
    now = datetime.now(UTC)
    stmt = select(WatchlistEntry).where(WatchlistEntry.list_id == list_id)
    if status == "active":
        stmt = stmt.where(WatchlistEntry.removed_at.is_(None), WatchlistEntry.expires_at.is_(None) | (WatchlistEntry.expires_at > now))
    entries = db.scalars(stmt.order_by(WatchlistEntry.added_at.desc()).limit(limit))
    return [_entry_out(e, actor, now) for e in entries]


@router.post("/{list_id}/entries", response_model=schemas.WatchlistEntryOut, status_code=201)
def add_entry(list_id: uuid.UUID, body: schemas.WatchlistEntryIn, request: Request, actor: ListsWrite, db: Db):
    _list_or_404(db, list_id)
    now = datetime.now(UTC)
    plate = canonical_or_none(body.plate)
    if plate is None:
        raise HTTPException(422, "Not a valid Moroccan plate (number | letter | region).")
    if body.expires_at is not None and body.expires_at <= now:
        raise HTTPException(422, "The expiry date is in the past.")
    entry = WatchlistEntry(list_id=list_id, plate_canonical=plate, reason=body.reason, color=body.color, make=body.make,
                           model=body.model, vehicle_type=body.vehicle_type, case_ref=body.case_ref, source=body.source,
                           expires_at=body.expires_at)
    db.add(entry)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This plate is already active on this watchlist.") from None
    audit(request, db, actor, "watchlist.entry.add", "watchlist_entry", entry.id,
          justification=f"{mask_fixed(plate)} ({body.reason})")
    db.commit()
    return _entry_out(entry, actor, now)


def _entry_or_404(db, list_id: uuid.UUID, entry_id: uuid.UUID) -> WatchlistEntry:
    entry = db.scalars(select(WatchlistEntry).where(WatchlistEntry.id == entry_id, WatchlistEntry.list_id == list_id)
                       .with_for_update()).first()
    if entry is None:
        raise HTTPException(404, "Entry not found.")
    return entry


@router.post("/{list_id}/entries/{entry_id}/remove", response_model=schemas.WatchlistEntryOut,
             summary="Take a plate off the list (kept for history), with a justification")
def remove_entry(list_id: uuid.UUID, entry_id: uuid.UUID, body: schemas.EntryRemoveIn, request: Request, actor: ListsWrite, db: Db):
    entry = _entry_or_404(db, list_id, entry_id)
    if entry.removed_at is not None:
        raise HTTPException(409, "This entry is already removed.")
    entry.removed_at = datetime.now(UTC)
    entry.removed_by = uuid.UUID(actor.id)
    audit(request, db, actor, "watchlist.entry.remove", "watchlist_entry", entry.id,
          justification=f"{mask_fixed(entry.plate_canonical)}: {body.justification}")
    db.commit()
    return _entry_out(entry, actor, datetime.now(UTC))


@router.post("/{list_id}/entries/{entry_id}/expire", response_model=schemas.WatchlistEntryOut,
             summary="Set when an entry stops raising alerts, with a justification")
def expire_entry(list_id: uuid.UUID, entry_id: uuid.UUID, body: schemas.EntryExpireIn, request: Request, actor: ListsWrite, db: Db):
    entry = _entry_or_404(db, list_id, entry_id)
    if entry.removed_at is not None:
        raise HTTPException(409, "This entry is removed; it cannot expire.")
    entry.expires_at = body.expires_at
    audit(request, db, actor, "watchlist.entry.expire", "watchlist_entry", entry.id,
          justification=f"{mask_fixed(entry.plate_canonical)} until {body.expires_at.isoformat()}: {body.justification}")
    db.commit()
    return _entry_out(entry, actor, datetime.now(UTC))


@router.get("/{list_id}/import/template", summary="CSV header and one example row")
def import_template(list_id: uuid.UUID, actor: ListsWrite):
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(watchlist_import.TEMPLATE + "12345|أ|6,stolen,white,Dacia,Logan,car,CASE-2026-001,DGSN,2027-01-31\n",
                             media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="watchlist_template.csv"'})


@router.post("/{list_id}/import", response_model=schemas.ImportResultOut,
             summary="CSV import: mode=preview writes nothing, mode=confirm adds the accepted rows")
async def import_csv(list_id: uuid.UUID, request: Request, actor: ListsWrite, db: Db, file: Annotated[UploadFile, File()],
                     mode: Annotated[Literal["preview", "confirm"], Query()] = "preview"):
    _list_or_404(db, list_id)
    settings = request.app.state.settings
    data = await file.read(settings.max_csv_bytes + 1)
    try:
        parsed = watchlist_import.parse(db, list_id, file.filename or "upload.csv", data,
                                        max_bytes=settings.max_csv_bytes, max_rows=settings.max_csv_rows)
    except watchlist_import.CsvImportError as e:
        raise HTTPException(e.status, str(e)) from None
    record = None
    if mode == "confirm":
        if watchlist_import.previous_import_with_same_file(db, list_id, parsed.sha256):
            raise HTTPException(409, "This exact file was already imported into this list.")
        if not parsed.accepted:
            raise HTTPException(422, "No valid rows to import.")
        record = watchlist_import.write(db, list_id, parsed, uuid.UUID(actor.id))
        audit(request, db, actor, "watchlist.import", "watchlist", list_id,
              justification=f"sha256={parsed.sha256} accepted={len(parsed.accepted)} rejected={len(parsed.rejected)} version={record.version}")
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "A plate in the file was added meanwhile; preview again.") from None
    return schemas.ImportResultOut(
        mode=mode, file_name=parsed.file_name, sha256=parsed.sha256, rows_total=parsed.rows_total,
        rows_accepted=len(parsed.accepted), rows_rejected=len(parsed.rejected),
        accepted=[schemas.AcceptedRow(**row) for row in parsed.accepted], rejected=parsed.rejected,
        import_id=record.id if record else None, version=record.version if record else None)


@router.get("/{list_id}/imports", response_model=list[schemas.WatchlistImportOut], summary="Import history of a list")
def list_imports(list_id: uuid.UUID, actor: ListsWrite, db: Db):
    _list_or_404(db, list_id)
    return db.scalars(select(WatchlistImport).where(WatchlistImport.list_id == list_id).order_by(WatchlistImport.version.desc())).all()
