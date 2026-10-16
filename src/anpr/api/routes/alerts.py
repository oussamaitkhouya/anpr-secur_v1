"""Watchlist alerts and the operations overview, on PostgreSQL.

City scoping happens in the SQL (anpr.db.scoping): an analyst never loads another city's alerts,
and another city's alert id answers 404. A human decides every match: POST /alerts/{id}/review
needs a written justification, refuses a second decision (409), and writes the decision and
its signed audit entry in one transaction. The alert row is locked while deciding, so two
reviewers cannot both decide it.

Plates: reviewers (alerts.review) see the OCR read in full because they must compare it with
the image; every other role gets it masked.

Evidence: GET /alerts/{id}/evidence returns the camera frame that raised the alert, for the human
check. Only reviewers (alerts.review) and evidence readers (evidence.read) get it, only inside
their cities. The file is hashed again and must equal the SHA-256 recorded with the detection,
so a swapped or edited image is refused (409) instead of shown. Every view is audited.
"""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func, literal_column, select

from anpr.api import schemas
from anpr.api.deps import Db, audit, rate_limit, require
from anpr.db import scoping
from anpr.db.models import (
    Alert,
    Camera,
    City,
    DetectionEvent,
    User,
    WatchlistEntry,
    WatchlistList,
)
from anpr.security import audit_chain, rbac
from anpr.security.masking import mask_fixed
from anpr.security.rbac import Actor

router = APIRouter(tags=["alerts"], dependencies=[Depends(rate_limit("operations", "camera_rate_per_minute"))])
AlertsRead = Annotated[Actor, Depends(require("alerts.read"))]
AlertsReview = Annotated[Actor, Depends(require("alerts.review"))]
OverviewRead = Annotated[Actor, Depends(require("overview.read"))]

DECISION = {"approve": "approved", "reject": "rejected", "escalate": "escalated"}
ACTION_OF = {v: k for k, v in DECISION.items()}


def _alert_query(actor: Actor):
    stmt = (select(Alert, DetectionEvent, Camera, City, WatchlistEntry, WatchlistList, User.username)
            .select_from(Alert)
            .join(DetectionEvent, DetectionEvent.id == Alert.detection_id)
            .join(Camera, Camera.id == DetectionEvent.camera_id)
            .join(City, City.id == Camera.city_id)
            .join(WatchlistEntry, WatchlistEntry.id == Alert.entry_id)
            .join(WatchlistList, WatchlistList.id == WatchlistEntry.list_id)
            .outerjoin(User, User.id == Alert.reviewed_by))
    return scoping.by_city(stmt, Camera.city_id, actor)  # WHERE camera.city_id IN (caller's cities)


def _chars(plate: str, confidences: list) -> list[schemas.CharOut]:
    letters = [c for c in plate if c != "|"]
    if len(confidences) != len(letters):
        return []
    return [schemas.CharOut(char=c, confidence=float(p)) for c, p in zip(letters, confidences, strict=True)]


def _alert_out(row, actor: Actor) -> schemas.AlertOut:
    alert, det, cam, city, entry, wl, reviewer = row
    full = rbac.allowed(actor.role, "alerts.review")
    plate = det.plate_canonical or det.plate_raw
    shown = plate if full else mask_fixed(plate)
    decision = None
    if alert.status != "pending" and alert.reviewed_at is not None:
        decision = schemas.AlertDecisionOut(action=ACTION_OF[alert.status], justification=alert.justification or "",
                                            reviewer=reviewer or "unknown", decided_at=alert.reviewed_at)
    return schemas.AlertOut(
        id=alert.id, detection_id=det.id, plate=shown, plate_masked=not full, plate_confidence=det.plate_confidence,
        chars=_chars(plate, det.char_confidences or []) if full else [],
        camera_id=cam.id, camera_name=cam.name, city_id=city.id, city_name=city.name,
        camera_address=cam.street_address, camera_latitude=cam.latitude, camera_longitude=cam.longitude,
        camera_view_deg=cam.view_direction_deg,
        observed_at=det.observed_at, received_at=det.received_at, kind=alert.kind, match_score=alert.score,
        observed_color=det.observed_color, observed_make=det.observed_make, observed_model=det.observed_model,
        evidence_sha256=det.evidence_sha256, plate_box=det.plate_box, speed_kmh=det.speed_kmh, status=alert.status, created_at=alert.created_at, decision=decision,
        watchlist_entry=schemas.AlertEntryOut(
            id=entry.id, list_id=wl.id, list_name=wl.name,
            plate=entry.plate_canonical if full else mask_fixed(entry.plate_canonical), reason=entry.reason,
            case_ref=entry.case_ref, source=entry.source, color=entry.color, make=entry.make, model=entry.model,
            added_at=entry.added_at, expires_at=entry.expires_at),
    )


@router.get("/alerts", response_model=list[schemas.AlertOut], summary="Watchlist matches in the caller's cities")
def list_alerts(actor: AlertsRead, db: Db, status: schemas.AlertStatus | None = None,
                limit: Annotated[int, Query(ge=1, le=500)] = 200):
    stmt = _alert_query(actor)
    if status is not None:
        stmt = stmt.where(Alert.status == status)
    rows = db.execute(stmt.order_by(Alert.status != "pending", DetectionEvent.observed_at.desc()).limit(limit)).all()
    return [_alert_out(r, actor) for r in rows]


@router.get("/alerts/{alert_id}", response_model=schemas.AlertOut)
def get_alert(alert_id: uuid.UUID, actor: AlertsRead, db: Db):
    row = db.execute(_alert_query(actor).where(Alert.id == alert_id)).first()
    if row is None:
        raise HTTPException(404, "Alert not found.")
    return _alert_out(row, actor)


@router.post("/alerts/{alert_id}/review", response_model=schemas.AlertOut,
             summary="A human decides a match: approve, reject or escalate, with a written justification")
def review_alert(alert_id: uuid.UUID, body: schemas.ReviewIn, request: Request, actor: AlertsReview, db: Db):
    # Scope check first (404 outside the caller's cities), then lock the row for the decision.
    if db.execute(_alert_query(actor).where(Alert.id == alert_id)).first() is None:
        raise HTTPException(404, "Alert not found.")
    alert = db.scalars(select(Alert).where(Alert.id == alert_id).with_for_update()).one()
    if alert.status != "pending":
        raise HTTPException(409, f"This alert was already {alert.status}.")
    alert.status = DECISION[body.action]
    alert.reviewed_by = uuid.UUID(actor.id)
    alert.reviewed_at = datetime.now(UTC)
    alert.justification = body.justification
    audit(request, db, actor, f"alert.{body.action}", "alert", alert.id, justification=body.justification)
    db.commit()
    return _alert_out(db.execute(_alert_query(actor).where(Alert.id == alert_id)).one(), actor)


def evidence_path(root: Path, sha256: str, observed_at: datetime) -> Path:
    """Where EvidenceStore put the frame: <root>/<UTC day of observed_at>/<sha256>.jpg."""
    return root / observed_at.astimezone(UTC).strftime("%Y-%m-%d") / f"{sha256}.jpg"


@router.get("/alerts/{alert_id}/evidence", response_class=Response,
            responses={200: {"content": {"image/jpeg": {}}}},
            summary="The camera frame that raised the alert, checked against its recorded SHA-256")
def alert_evidence(alert_id: uuid.UUID, request: Request, actor: AlertsRead, db: Db):
    if not (rbac.allowed(actor.role, "alerts.review") or rbac.allowed(actor.role, "evidence.read")):
        raise HTTPException(403, "Your role cannot view evidence images.")
    row = db.execute(_alert_query(actor).where(Alert.id == alert_id)).first()
    if row is None:
        raise HTTPException(404, "Alert not found.")
    det = row[1]
    sha = det.evidence_sha256
    if not sha or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        raise HTTPException(404, "No image was kept for this detection.")
    path = evidence_path(Path(request.app.state.settings.evidence_dir), sha, det.observed_at)
    try:
        data = path.read_bytes()
    except OSError:
        raise HTTPException(404, "The image is no longer in the evidence store (30-day retention).") from None
    if hashlib.sha256(data).hexdigest() != sha:
        audit(request, db, actor, "evidence.mismatch", "alert", alert_id)
        db.commit()
        raise HTTPException(409, "The stored image does not match the hash recorded at capture; it is not shown.")
    audit(request, db, actor, "evidence.view", "alert", alert_id)
    db.commit()
    return Response(data, media_type="image/jpeg",
                    headers={"Cache-Control": "no-store", "X-Evidence-SHA256": sha})


# ---- overview -------------------------------------------------------------------------------

def _trunc(unit: str, column):
    # The unit is inlined, not bound: a bound parameter in both SELECT and GROUP BY is two
    # different parameters to PostgreSQL, which then refuses the grouping. Units are constants.
    assert unit in ("day", "hour")
    return func.date_trunc(literal_column(f"'{unit}'"), column)


def _day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


@router.get("/overview", response_model=schemas.OverviewOut, summary="Today's reads, matches and camera health")
def overview(request: Request, actor: OverviewRead, db: Db):
    now = datetime.now(UTC)
    today = _day_start(now)
    since = today - timedelta(days=13)
    hour0 = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=23)

    def detections(*cols):
        return scoping.detections(select(*cols).select_from(DetectionEvent), actor)

    def alerts_since(start: datetime):
        return scoping.alerts(select(func.count()).select_from(Alert), actor).where(Alert.created_at >= start)

    latency_ms = func.avg(func.extract("epoch", DetectionEvent.received_at - DetectionEvent.observed_at)) * 1000
    day = _trunc("day", DetectionEvent.observed_at)
    hour = _trunc("hour", DetectionEvent.observed_at)
    alert_day = _trunc("day", Alert.created_at)
    alert_hour = _trunc("hour", Alert.created_at)

    reads_by_day = {r[0]: r for r in db.execute(
        detections(day, func.count(), latency_ms, func.count(func.distinct(DetectionEvent.camera_id)))
        .where(DetectionEvent.observed_at >= since).group_by(day))}
    hits_by_day = dict(db.execute(
        scoping.alerts(select(alert_day, func.count()).select_from(Alert), actor)
        .where(Alert.created_at >= since).group_by(alert_day)).all())
    reads_by_hour = dict(db.execute(detections(hour, func.count()).where(DetectionEvent.observed_at >= hour0).group_by(hour)).all())
    hits_by_hour = dict(db.execute(
        scoping.alerts(select(alert_hour, func.count()).select_from(Alert), actor)
        .where(Alert.created_at >= hour0).group_by(alert_hour)).all())

    def norm(d: dict) -> dict:  # date_trunc returns aware datetimes in the session time zone
        return {k.astimezone(UTC): v for k, v in d.items()}

    reads_by_day, hits_by_day = norm(reads_by_day), norm(hits_by_day)
    reads_by_hour, hits_by_hour = norm(reads_by_hour), norm(hits_by_hour)

    daily = []
    for i in range(14):
        d = since + timedelta(days=i)
        r = reads_by_day.get(d)
        daily.append({"day": d.isoformat(), "reads": r[1] if r else 0, "hits": hits_by_day.get(d, 0),
                      "latencyMs": round(float(r[2]), 1) if r and r[2] is not None else None,
                      "camerasReporting": r[3] if r else 0})
    hourly = [{"hour": (hour0 + timedelta(hours=i)).isoformat(), "reads": reads_by_hour.get(hour0 + timedelta(hours=i), 0),
               "hits": hits_by_hour.get(hour0 + timedelta(hours=i), 0)} for i in range(24)]

    cams = db.execute(scoping.cameras(select(Camera.status, func.count()).group_by(Camera.status), actor)).all()
    integrity = None
    if rbac.allowed(actor.role, "audit.verify"):
        result = audit_chain.verify(db, request.app.state.keys.audit_signing_key().public_key())
        integrity = schemas.IntegrityOut(ok=result.ok, entries=result.entries, first_bad_seq=result.first_bad_seq, reason=result.reason)

    today_row = reads_by_day.get(today)
    return schemas.OverviewOut(
        plates_today=today_row[1] if today_row else 0,
        watchlist_hits_today=db.scalar(alerts_since(today)) or 0,
        pending_alerts=db.scalar(scoping.alerts(select(func.count()).select_from(Alert), actor).where(Alert.status == "pending")) or 0,
        avg_latency_ms=round(float(today_row[2]), 1) if today_row and today_row[2] is not None else None,
        active_cameras=sum(n for s, n in cams if s == "online"),
        total_cameras=sum(n for _, n in cams),
        integrity=integrity, daily=daily, hourly=hourly,
    )
