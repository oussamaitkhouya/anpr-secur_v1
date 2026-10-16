"""Detection ingest: the camera worker (or a radar) reports one plate read; the API stores it,
matches it against active watchlists and opens a pending alert for each match.

Who may call it: only the detection service, with `Authorization: Bearer <token>`. The server
holds just the token's SHA-256 (DETECTION_TOKEN_SHA256) and compares in constant time
(anpr.api.deps.detection_service). Users' cookies do not work here, and the token does not work
on any user route. Rate limited per IP (DETECTION_RATE_PER_MINUTE).

What happens to one read: anpr.api.services.ingest.record_read (stored, matched against active
watchlists, a PENDING alert per match, repeats suppressed, audited, camera marked online), in
one transaction. The live camera page uses the same function, so both paths follow one rule set.
"""

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request

from anpr.api import schemas
from anpr.api.deps import Db, detection_service, rate_limit
from anpr.api.services.ingest import ReadIn, record_read
from anpr.db.models import Camera
from anpr.security.rbac import Actor

router = APIRouter(tags=["detections"])
Service = Annotated[Actor, Depends(detection_service)]

# A read whose capture time is this far in the future is a clock problem, not a detection.
MAX_CLOCK_SKEW = timedelta(minutes=5)


@router.post("/detections", response_model=schemas.DetectionOut, status_code=201,
             dependencies=[Depends(rate_limit("detections", "detection_rate_per_minute"))],
             summary="Report one plate read (detection service only)")
def ingest(body: schemas.DetectionIn, request: Request, actor: Service, db: Db):
    now = datetime.now(UTC)
    if body.observed_at > now + MAX_CLOCK_SKEW:
        raise HTTPException(422, "observed_at is in the future; check the camera worker's clock.")
    camera = db.get(Camera, body.camera_id)
    if camera is None:
        raise HTTPException(404, "Camera not found.")
    result = record_read(db, request, actor, camera, ReadIn(
        plate_raw=body.plate_raw, plate_confidence=body.plate_confidence, observed_at=body.observed_at,
        source_kind=body.source_kind, char_confidences=tuple(body.char_confidences), observed_color=body.observed_color,
        observed_make=body.observed_make, observed_model=body.observed_model, evidence_sha256=body.evidence_sha256,
        evidence_uri=body.evidence_uri, speed_kmh=body.speed_kmh,
        plate_box=tuple(body.plate_box) if body.plate_box else None), now)
    db.commit()
    return schemas.DetectionOut(id=result.detection.id, plate_valid=result.detection.plate_canonical is not None,
                                alerts_created=len(result.alerts))
