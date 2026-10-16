"""One plate read -> stored detection -> watchlist matches -> pending alerts. Shared by the camera
worker endpoint (POST /detections) and the live camera page (POST /cameras/{id}/frames), so both
paths apply exactly the same rules:

1. A camera in maintenance records reads but never raises alerts (often test plates).
2. The read is stored with its canonical plate (NULL when it is not a valid Moroccan plate).
3. anpr.pipeline.matcher proposes matches; every match becomes a PENDING alert a person decides.
4. Repeats are suppressed: no new alert for the same entry from the same camera while one is
   still pending from the last DEDUP_WINDOW.
5. Each new alert is written to the signed audit chain (plate masked).
6. The camera's last_frame_at advances; an offline/degraded/unknown camera becomes online.

The caller commits.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.deps import audit
from anpr.db.models import (
    Alert,
    Camera,
    CameraStatusEvent,
    DetectionEvent,
    WatchlistEntry,
)
from anpr.pipeline import matcher
from anpr.security.masking import mask_fixed
from anpr.security.rbac import Actor

DEDUP_WINDOW = timedelta(seconds=60)


@dataclass(frozen=True)
class ReadIn:
    plate_raw: str
    plate_confidence: float
    observed_at: datetime
    source_kind: str = "video"
    char_confidences: tuple[float, ...] = ()
    observed_color: str | None = None
    observed_make: str | None = None
    observed_model: str | None = None
    evidence_sha256: str | None = None
    evidence_uri: str | None = None
    plate_box: tuple[float, float, float, float] | None = None
    speed_kmh: float | None = None


@dataclass
class Ingested:
    detection: DetectionEvent
    alerts: list[Alert] = field(default_factory=list)


def candidates(db: Session, now: datetime) -> list[matcher.Candidate]:
    rows = db.scalars(select(WatchlistEntry).where(
        WatchlistEntry.removed_at.is_(None),
        (WatchlistEntry.expires_at.is_(None)) | (WatchlistEntry.expires_at > now)))
    return [matcher.Candidate(entry_id=str(e.id), plate_canonical=e.plate_canonical, color=e.color, make=e.make,
                              model=e.model, expires_at=e.expires_at, removed_at=e.removed_at) for e in rows]


def record_read(db: Session, request: Request, actor: Actor, camera: Camera, read: ReadIn, now: datetime,
                cached_candidates: list[matcher.Candidate] | None = None) -> Ingested:
    detection = DetectionEvent(
        camera_id=camera.id, observed_at=read.observed_at, received_at=now, source_kind=read.source_kind,
        plate_raw=read.plate_raw, plate_canonical=matcher.canonical_or_none(read.plate_raw),
        char_confidences=list(read.char_confidences), plate_confidence=read.plate_confidence,
        observed_color=read.observed_color, observed_make=read.observed_make, observed_model=read.observed_model,
        evidence_sha256=read.evidence_sha256, evidence_uri=read.evidence_uri, speed_kmh=read.speed_kmh,
        plate_box=list(read.plate_box) if read.plate_box else None,
    )
    db.add(detection)
    db.flush()
    out = Ingested(detection)

    if camera.status != "maintenance":
        plate_read = matcher.PlateRead(plate_raw=read.plate_raw, plate_confidence=read.plate_confidence,
                                       char_confidences=read.char_confidences, color=read.observed_color,
                                       make=read.observed_make, model=read.observed_model)
        pool = cached_candidates if cached_candidates is not None else candidates(db, now)
        for m in matcher.match(plate_read, pool, now=now):
            entry_id = uuid.UUID(m.entry_id)
            recent = db.scalar(
                select(Alert.id).join(DetectionEvent, DetectionEvent.id == Alert.detection_id)
                .where(Alert.entry_id == entry_id, Alert.status == "pending", DetectionEvent.camera_id == camera.id,
                       Alert.created_at >= now - DEDUP_WINDOW).limit(1))
            if recent is not None:
                continue
            alert = Alert(detection_id=detection.id, entry_id=entry_id, kind=m.kind, score=m.score)
            db.add(alert)
            db.flush()
            entry_plate = db.scalar(select(WatchlistEntry.plate_canonical).where(WatchlistEntry.id == entry_id))
            audit(request, db, actor, "alert.create", "alert", alert.id,
                  justification=f"{m.kind} score={m.score:.2f} camera={camera.id} entry={mask_fixed(entry_plate or '')}")
            out.alerts.append(alert)

    if camera.last_frame_at is None or read.observed_at > camera.last_frame_at:
        camera.last_frame_at = read.observed_at
    if camera.status in ("offline", "degraded", "unknown"):
        camera.status = "online"
        db.add(CameraStatusEvent(camera_id=camera.id, status="online", reason="reads arriving"))
    return out
