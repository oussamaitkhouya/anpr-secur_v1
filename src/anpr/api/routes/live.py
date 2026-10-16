"""Live monitoring from the browser: the Live Camera page sends webcam frames, the API finds and
reads plates, and every read goes through the same ingest as the camera worker, so a stolen
plate on a watchlist becomes a pending alert in Live Alerts at once.

    POST /cameras/{camera_id}/frames   one JPEG (multipart "file"), admins and analysts

Controls:
- Only cameras registered as a LOCAL source (protocol "file") accept frames, and only in the
  caller's cities (404 otherwise). Nobody can inject frames for a networked street camera.
- Rate limited per IP (LIVE_FRAME_RATE_PER_MINUTE) and size limited (MAX_BODY_BYTES); the image is
  decoded with a size cap before it reaches the model.
- A plate is reported at most once per camera per 10 s; the frame that produced a report is kept
  in the evidence store (EVIDENCE_DIR, 30-day retention) and only its SHA-256 goes into the
  database. Frames with no reportable plate are discarded, never stored.
- Plates in the response follow the alerts rule: full for reviewers, masked for other roles.
"""

import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from sqlalchemy import select

from anpr.api import schemas
from anpr.api.deps import Db, rate_limit, require
from anpr.api.services.ingest import ReadIn, candidates, record_read
from anpr.db import scoping
from anpr.db.models import Camera, WatchlistEntry, WatchlistList
from anpr.pipeline.live import FrameError, decode_jpeg
from anpr.pipeline.matcher import canonical_or_none
from anpr.security import rbac
from anpr.security.masking import mask_fixed, mask_plate
from anpr.security.rbac import Actor
from anpr.worker.core import Debouncer, EvidenceStore, usable_text

router = APIRouter(tags=["live"])
LiveUser = Annotated[Actor, Depends(require("cameras.live"))]
MIN_BOX_CONFIDENCE = 0.5


def frame_box(box: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """The detector's [x, y, w, h] clamped inside the frame, rounded for storage."""
    x, y = min(max(box[0], 0.0), 1.0), min(max(box[1], 0.0), 1.0)
    w, h = min(max(box[2], 0.0), 1.0 - x), min(max(box[3], 0.0), 1.0 - y)
    return (round(x, 5), round(y, 5), round(w, 5), round(h, 5))


def _debouncer(request: Request, camera_id: uuid.UUID) -> Debouncer:
    store = request.app.state.__dict__.setdefault("live_debounce", {})
    return store.setdefault(camera_id, Debouncer())


@router.post("/cameras/{camera_id}/frames", response_model=schemas.LiveFrameOut,
             dependencies=[Depends(rate_limit("live-frames", "live_frame_rate_per_minute"))],
             summary="Analyse one webcam frame: boxes, reads, and alerts for watchlist matches")
async def analyse_frame(camera_id: uuid.UUID, request: Request, actor: LiveUser, db: Db, file: Annotated[UploadFile, File()]):
    camera = db.scalars(scoping.cameras(select(Camera).where(Camera.id == camera_id), actor)).one_or_none()
    if camera is None:
        raise HTTPException(404, "Camera not found.")
    if camera.protocol != "file":
        raise HTTPException(409, "Only local sources (protocol File, e.g. this PC's webcam) accept frames from the browser.")
    data = await file.read(request.app.state.settings.max_body_bytes + 1)
    try:
        frame = decode_jpeg(data)
    except FrameError as e:
        raise HTTPException(422, str(e)) from None

    detector = request.app.state.detector
    started = time.perf_counter()
    try:
        found = detector.detect(frame)
    except FileNotFoundError:
        raise HTTPException(503, "The plate detection model is not available on the server (check ANPR_DETECTOR_WEIGHTS).") from None
    elapsed = round((time.perf_counter() - started) * 1000, 1)

    now = datetime.now(UTC)
    full = rbac.allowed(actor.role, "alerts.review")
    debounce = _debouncer(request, camera.id)
    evidence_sha = None
    pool = None
    boxes, alerts = [], []
    for f in found:
        text = usable_text(f.plate)
        reported = False
        if text and f.box_confidence >= MIN_BOX_CONFIDENCE and debounce.should_send(text):
            if evidence_sha is None:
                store = EvidenceStore(Path(request.app.state.settings.evidence_dir))
                evidence_sha = store.save(data, now)
            pool = pool if pool is not None else candidates(db, now)
            letters = [c for c in text if c not in "|- "]
            confs = tuple(p for _, p in f.chars) if len(f.chars) == len(letters) else ()
            result = record_read(db, request, actor, camera, ReadIn(
                plate_raw=text, plate_confidence=max(0.0, min(1.0, f.confidence)), observed_at=now,
                char_confidences=confs, evidence_sha256=evidence_sha, plate_box=frame_box(f.box)), now, cached_candidates=pool)
            reported = True
            for a in result.alerts:
                entry, list_name = db.execute(select(WatchlistEntry, WatchlistList.name).join(WatchlistList)
                                              .where(WatchlistEntry.id == a.entry_id)).one()
                alerts.append(schemas.LiveAlertOut(id=a.id, kind=a.kind, reason=entry.reason, list_name=list_name,
                                                   plate=entry.plate_canonical if full else mask_fixed(entry.plate_canonical)))
        canonical = canonical_or_none(text) if text else None
        shown = None
        if text:
            shown = (canonical or text) if full else (mask_fixed(canonical) if canonical else mask_plate(None, text))
        x, y, w, h = f.box
        boxes.append(schemas.LiveBoxOut(x=x, y=y, w=w, h=h, box_confidence=f.box_confidence, plate=shown, plate_masked=not full,
                                        plate_valid=canonical is not None, confidence=round(f.confidence, 4), reported=reported))
    db.commit()
    return schemas.LiveFrameOut(width=int(frame.shape[1]), height=int(frame.shape[0]), inference_ms=elapsed,
                                reads_plates=detector.reads_plates, boxes=boxes, alerts=alerts)
