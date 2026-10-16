"""Live video of network cameras, relayed by the API (see anpr.api.services.stream_relay).

    GET /cameras/{camera_id}/stream.mjpg   MJPEG video for an <img>, admins and analysts
    GET /cameras/{camera_id}/stream        the feed's state: connecting | live | error | idle

Controls:
- Permission cameras.live and city scoping, like the webcam frames: 404 for a camera outside the
  caller's cities. Every opened stream is written to the signed audit chain (who watched what).
- A viewer's stream ends after the access-token lifetime; the dashboard reconnects with a fresh
  cookie, so a disabled account or a revoked session loses the video within minutes.
- Opening streams is rate limited per IP.
"""

import asyncio
import time
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from anpr.api import schemas
from anpr.api.deps import Db, audit, rate_limit, require
from anpr.api.services.stream_relay import (
    STREAMABLE,
    StreamHub,
    StreamRefused,
    build_target,
)
from anpr.db import scoping
from anpr.db.models import Camera
from anpr.security import netprobe
from anpr.security.crypto import DecryptionError
from anpr.security.rbac import Actor

router = APIRouter(tags=["live"])
LiveUser = Annotated[Actor, Depends(require("cameras.live"))]
BOUNDARY = "frame"
MAX_VIEW_SECONDS = 3600  # upper bound on one viewer connection, whatever the token lifetime


def hub(request: Request) -> StreamHub:
    return request.app.state.streams


def _camera(db, actor: Actor, camera_id: uuid.UUID) -> Camera:
    camera = db.scalars(scoping.cameras(select(Camera).where(Camera.id == camera_id), actor)).one_or_none()
    if camera is None:
        raise HTTPException(404, "Camera not found.")
    if camera.protocol not in STREAMABLE:
        raise HTTPException(409, "Only RTSP and RTSPS cameras have a video stream.")
    return camera


@router.get("/cameras/{camera_id}/stream", response_model=schemas.StreamStatusOut,
            summary="State of the camera's live video relay")
def stream_status(camera_id: uuid.UUID, request: Request, actor: LiveUser, db: Db):
    _camera(db, actor, camera_id)
    feed = hub(request).get(camera_id)
    if feed is None:
        return schemas.StreamStatusOut(state="idle")
    return schemas.StreamStatusOut(state=feed.state, message=feed.message, width=feed.size[0] if feed.size else None,
                                   height=feed.size[1] if feed.size else None, fps=feed.fps, viewers=feed.viewers,
                                   reads=feed.reads, last_read_at=feed.last_read_at)


@router.get("/cameras/{camera_id}/stream.mjpg", summary="Live MJPEG video of a network camera",
            dependencies=[Depends(rate_limit("stream-open", "probe_rate_per_minute"))],
            response_class=StreamingResponse)
def open_stream(camera_id: uuid.UUID, request: Request, actor: LiveUser, db: Db):
    camera = _camera(db, actor, camera_id)
    settings = request.app.state.settings

    def target():
        return build_target(camera, request.app.state.keys,
                            allowed_networks=netprobe.parse_networks(settings.allowed_camera_networks))
    try:
        feed = hub(request).feed(request.app, camera, target)
    except StreamRefused as e:
        raise HTTPException(422, str(e)) from None
    except (DecryptionError, KeyError, ValueError):
        raise HTTPException(422, "The camera's stored credentials cannot be used. Replace them.") from None
    try:
        audit(request, db, actor, "camera.stream.view", "camera", camera.id)
        db.commit()
    except Exception:
        feed.detach()  # no stream without its audit entry
        raise

    deadline = time.monotonic() + min(settings.access_token_minutes * 60, MAX_VIEW_SECONDS)

    async def frames():
        seq = 0
        try:
            while time.monotonic() < deadline and not feed.closed:
                if await request.is_disconnected():
                    break
                if feed.seq != seq and feed.jpeg is not None:
                    seq, jpeg = feed.seq, feed.jpeg
                    yield (f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpeg)}\r\n\r\n").encode() + jpeg + b"\r\n"
                await asyncio.sleep(0.03)
        finally:
            feed.detach()

    return StreamingResponse(frames(), media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY}",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
