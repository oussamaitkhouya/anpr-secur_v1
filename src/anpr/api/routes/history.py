"""Clearing the detection history: admin and super admin only, with a written justification.

What goes: plate reads (detection_events), the alerts raised from them, and their evidence frames
on disk. What stays:
- the audit log. It is append-only (a database trigger blocks UPDATE/DELETE), and the purge itself
  is recorded there with who did it, why and how much was removed;
- alerts still waiting for a decision, and their reads, unless include_pending is set. A person
  confirms every watchlist match, so wiping undecided alerts must be an explicit choice;
- watchlists, cameras and users.

Files are deleted only after the database commit, so a failed transaction never leaves rows
pointing at frames that are gone. A frame still referenced by a kept read is not deleted.
"""

import logging
import re
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import delete, func, select

from anpr.api import schemas
from anpr.api.deps import Db, audit, require
from anpr.api.routes.alerts import evidence_path
from anpr.db.models import Alert, DetectionEvent
from anpr.security.rbac import Actor

log = logging.getLogger(__name__)
router = APIRouter(prefix="/admin", tags=["admin"])
Purge = Annotated[Actor, Depends(require("detections.purge"))]
SHA256 = re.compile(r"[0-9a-f]{64}")


@router.post("/detections/purge", response_model=schemas.DetectionPurgeOut,
             summary="Delete plate reads, their alerts and evidence frames (pending alerts kept by default)")
def purge_detections(body: schemas.DetectionPurgeIn, request: Request, actor: Purge, db: Db):
    pending_reads = select(Alert.detection_id).where(Alert.status == "pending")
    kept_pending = db.scalar(select(func.count()).select_from(Alert).where(Alert.status == "pending")) or 0
    targets = select(DetectionEvent.id)
    if not body.include_pending:
        targets = targets.where(DetectionEvent.id.not_in(pending_reads))
    else:
        kept_pending = 0

    frames = db.execute(
        select(DetectionEvent.evidence_sha256, DetectionEvent.observed_at)
        .where(DetectionEvent.id.in_(targets), DetectionEvent.evidence_sha256.is_not(None))
    ).all()
    alerts = db.execute(delete(Alert).where(Alert.detection_id.in_(targets))).rowcount
    reads = db.execute(delete(DetectionEvent).where(DetectionEvent.id.in_(targets))).rowcount
    summary = f"removed {reads} plate reads and {alerts} alerts" + (
        "; pending alerts included" if body.include_pending else f"; {kept_pending} pending alerts kept")
    audit(request, db, actor, "detections.purge", "detections", None, justification=f"{body.justification} [{summary}]")
    db.commit()

    still_used = set(db.scalars(select(DetectionEvent.evidence_sha256).where(DetectionEvent.evidence_sha256.is_not(None))))
    root = Path(request.app.state.settings.evidence_dir)
    files = 0
    for sha, observed_at in frames:
        if sha in still_used or not SHA256.fullmatch(sha):  # the hash names the file: never trust it blindly
            continue
        try:
            evidence_path(root, sha, observed_at).unlink()
            files += 1
        except FileNotFoundError:
            pass  # already pruned by retention
        except OSError:
            log.warning("evidence frame %s could not be deleted", sha[:12])
    return schemas.DetectionPurgeOut(detections=reads, alerts=alerts, evidence_files=files, kept_pending=kept_pending)
