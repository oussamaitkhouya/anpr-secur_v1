"""Camera registry, read side. City-scoped: analysts only get cameras in their own cities.

Camera locations are sensitive (they reveal where the city is watched), so even the map
endpoint goes through the same permission and city scoping as the full records.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from anpr.api import schemas
from anpr.api.deps import Db, rate_limit, require
from anpr.db import scoping
from anpr.db.models import Camera, CameraStatusEvent, City
from anpr.security.rbac import Actor

# Locations are sensitive: every read is rate limited per IP, like the admin routes.
router = APIRouter(tags=["cameras"], dependencies=[Depends(rate_limit("cameras", "camera_rate_per_minute"))])
CamerasRead = Annotated[Actor, Depends(require("cameras.read"))]
CitiesRead = Annotated[Actor, Depends(require("cities.read"))]

_OUT_FIELDS = [name for name in schemas.CameraOut.model_fields if name != "credentials_set"]


def camera_out(camera: Camera) -> schemas.CameraOut:
    """Copy the public fields only. credentials_* never leave this function."""
    return schemas.CameraOut(**{f: getattr(camera, f) for f in _OUT_FIELDS},
                             credentials_set=camera.credentials_encrypted is not None)


@router.get("/cities", response_model=list[schemas.CityOut], summary="Cities the caller may see")
def list_cities(actor: CitiesRead, db: Db):
    return db.scalars(scoping.cities(select(City), actor).order_by(City.name)).all()


@router.get("/cameras/map", response_model=list[schemas.CameraMapOut], summary="Camera positions for the map")
def camera_map(actor: CamerasRead, db: Db):
    stmt = select(Camera.id, Camera.name, Camera.kind, Camera.district, Camera.latitude, Camera.longitude,
                  Camera.view_direction_deg, Camera.status, Camera.last_frame_at, Camera.city_id,
                  City.name.label("city_name")).join(City, City.id == Camera.city_id)
    rows = db.execute(scoping.cameras(stmt, actor).order_by(City.name, Camera.name)).all()
    return [schemas.CameraMapOut.model_validate(r._mapping) for r in rows]


@router.get("/cameras", response_model=list[schemas.CameraOut])
def list_cameras(actor: CamerasRead, db: Db, city_id: uuid.UUID | None = None,
                 status: schemas.CameraStatus | None = None,
                 limit: Annotated[int, Query(ge=1, le=500)] = 200, offset: Annotated[int, Query(ge=0)] = 0):
    stmt = scoping.cameras(select(Camera), actor)
    if city_id is not None:
        stmt = stmt.where(Camera.city_id == city_id)
    if status is not None:
        stmt = stmt.where(Camera.status == status)
    return [camera_out(c) for c in db.scalars(stmt.order_by(Camera.name).limit(limit).offset(offset))]


@router.get("/cameras/{camera_id}", response_model=schemas.CameraOut)
def get_camera(camera_id: uuid.UUID, actor: CamerasRead, db: Db):
    camera = db.scalars(scoping.cameras(select(Camera).where(Camera.id == camera_id), actor)).one_or_none()
    if camera is None:
        raise HTTPException(404, "Camera not found.")
    return camera_out(camera)


@router.get("/cameras/{camera_id}/status-events", response_model=list[schemas.StatusEventOut],
            summary="Status history of one camera, newest first")
def status_events(camera_id: uuid.UUID, actor: CamerasRead, db: Db, limit: Annotated[int, Query(ge=1, le=200)] = 50):
    # The camera lookup is city-scoped, so an analyst cannot read another city's history.
    visible = db.scalar(scoping.cameras(select(Camera.id).where(Camera.id == camera_id), actor))
    if visible is None:
        raise HTTPException(404, "Camera not found.")
    return db.scalars(select(CameraStatusEvent).where(CameraStatusEvent.camera_id == camera_id)
                      .order_by(CameraStatusEvent.at.desc()).limit(limit)).all()
