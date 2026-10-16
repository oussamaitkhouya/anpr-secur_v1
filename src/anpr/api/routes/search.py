"""Plate search and reveal, plus the recent-reads feed and the evidence list.

Search returns MASKED plates only, city-scoped in SQL. Seeing a full plate is a separate,
deliberate act: POST /plates/{id}/reveal with a written justification, allowed to analysts
(plates.reveal), recorded in the signed audit log. Searches are audited too (masked query and
result count), because "who looked for which plate" is exactly what oversight needs.

Evidence: the camera worker keeps the frame and sends its SHA-256. An auditor can upload the
frame file here; the server compares hashes and records the verification in the audit log.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select

from anpr.api import schemas
from anpr.api.deps import Db, audit, rate_limit, require
from anpr.db import scoping
from anpr.db.models import Alert, Camera, City, DetectionEvent
from anpr.pipeline.validator import normalize
from anpr.security.masking import mask_fixed, mask_plate
from anpr.security.rbac import Actor

router = APIRouter(tags=["plates"], dependencies=[Depends(rate_limit("search", "camera_rate_per_minute"))])
Search = Annotated[Actor, Depends(require("plates.search"))]
Reveal = Annotated[Actor, Depends(require("plates.reveal"))]
CamerasRead = Annotated[Actor, Depends(require("cameras.read"))]
EvidenceRead = Annotated[Actor, Depends(require("evidence.read"))]

MIN_QUERY = 3


def _masked(det: DetectionEvent) -> str:
    return mask_fixed(det.plate_canonical) if det.plate_canonical else mask_plate(None, det.plate_raw)


def _read_query(actor: Actor):
    stmt = (select(DetectionEvent, Camera.name, City.id, City.name)
            .select_from(DetectionEvent)
            .join(Camera, Camera.id == DetectionEvent.camera_id)
            .join(City, City.id == Camera.city_id))
    return scoping.by_city(stmt, Camera.city_id, actor)


def _alert_counts(db, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    return dict(db.execute(select(Alert.detection_id, func.count()).where(Alert.detection_id.in_(ids)).group_by(Alert.detection_id)).all())


def _read_out(row, alerts: dict) -> schemas.ReadOut:
    det, cam_name, city_id, city_name = row
    return schemas.ReadOut(
        detection_id=det.id, plate_masked=_masked(det), plate_valid=det.plate_canonical is not None,
        plate_confidence=det.plate_confidence, observed_at=det.observed_at, received_at=det.received_at, source_kind=det.source_kind,
        camera_id=det.camera_id, camera_name=cam_name, city_id=city_id, city_name=city_name, observed_color=det.observed_color,
        observed_make=det.observed_make, observed_model=det.observed_model, evidence_sha256=det.evidence_sha256,
        alerts=alerts.get(det.id, 0))


@router.get("/plates/search", response_model=list[schemas.ReadOut], summary="Find reads by plate fragment (results are masked)")
def search(request: Request, actor: Search, db: Db,
           q: Annotated[str, Query(min_length=1, max_length=30)],
           since: datetime | None = None, until: datetime | None = None, camera_id: uuid.UUID | None = None,
           limit: Annotated[int, Query(ge=1, le=500)] = 100):
    needle = normalize(q).replace("|", "")
    if len(needle) < MIN_QUERY:
        raise HTTPException(422, f"Type at least {MIN_QUERY} plate characters.")
    plain = func.replace(func.coalesce(DetectionEvent.plate_canonical, DetectionEvent.plate_raw), "|", "")
    stmt = _read_query(actor).where(or_(plain.contains(needle, autoescape=True)))
    if since:
        stmt = stmt.where(DetectionEvent.observed_at >= since)
    if until:
        stmt = stmt.where(DetectionEvent.observed_at <= until)
    if camera_id:
        stmt = stmt.where(DetectionEvent.camera_id == camera_id)
    rows = db.execute(stmt.order_by(DetectionEvent.observed_at.desc()).limit(limit)).all()
    shown = needle[-2:].rjust(len(needle), "•")
    audit(request, db, actor, "plates.search", "plates", None, justification=f"query={shown} results={len(rows)}")
    db.commit()
    alerts = _alert_counts(db, [r[0].id for r in rows])
    return [_read_out(r, alerts) for r in rows]


@router.post("/plates/{detection_id}/reveal", response_model=schemas.RevealOut,
             summary="Show one read's full plate, with a justification (audited)")
def reveal(detection_id: uuid.UUID, body: schemas.RevealIn, request: Request, actor: Reveal, db: Db):
    row = db.execute(_read_query(actor).where(DetectionEvent.id == detection_id)).first()
    if row is None:
        raise HTTPException(404, "Read not found.")
    det = row[0]
    audit(request, db, actor, "plates.reveal", "detection", det.id, justification=body.justification)
    db.commit()
    return schemas.RevealOut(detection_id=det.id, plate_canonical=det.plate_canonical, plate_raw=det.plate_raw)


@router.get("/detections/recent", response_model=list[schemas.ReadOut], summary="Latest reads, masked (live camera feed)")
def recent_reads(actor: CamerasRead, db: Db, camera_id: uuid.UUID | None = None,
                 limit: Annotated[int, Query(ge=1, le=200)] = 50):
    stmt = _read_query(actor)
    if camera_id:
        stmt = stmt.where(DetectionEvent.camera_id == camera_id)
    rows = db.execute(stmt.order_by(DetectionEvent.received_at.desc()).limit(limit)).all()
    alerts = _alert_counts(db, [r[0].id for r in rows])
    return [_read_out(r, alerts) for r in rows]


@router.get("/evidence", response_model=list[schemas.ReadOut], summary="Reads that carry an evidence frame hash")
def list_evidence(actor: EvidenceRead, db: Db, camera_id: uuid.UUID | None = None,
                  limit: Annotated[int, Query(ge=1, le=500)] = 200):
    stmt = _read_query(actor).where(DetectionEvent.evidence_sha256.is_not(None))
    if camera_id:
        stmt = stmt.where(DetectionEvent.camera_id == camera_id)
    rows = db.execute(stmt.order_by(DetectionEvent.observed_at.desc()).limit(limit)).all()
    alerts = _alert_counts(db, [r[0].id for r in rows])
    return [_read_out(r, alerts) for r in rows]


@router.post("/evidence/{detection_id}/verify", response_model=schemas.EvidenceCheckOut,
             summary="Compare a frame's SHA-256 with the one recorded at capture (audited)")
def verify_evidence(detection_id: uuid.UUID, body: schemas.EvidenceCheckIn, request: Request, actor: EvidenceRead, db: Db):
    row = db.execute(_read_query(actor).where(DetectionEvent.id == detection_id)).first()
    if row is None or row[0].evidence_sha256 is None:
        raise HTTPException(404, "No evidence recorded for this read.")
    match = row[0].evidence_sha256 == body.sha256
    audit(request, db, actor, "evidence.verify", "detection", detection_id, justification="match" if match else "MISMATCH")
    db.commit()
    return schemas.EvidenceCheckOut(detection_id=detection_id, recorded_sha256=row[0].evidence_sha256, match=match)
