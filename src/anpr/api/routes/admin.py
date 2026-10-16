"""Administration: cities, cameras (with write-only credentials) and user accounts. Admin roles only;
admin and super admin accounts are managed only by a super admin.

Every change is written to the audit chain in the same transaction as the change itself.
Camera credentials are accepted here and nowhere else, encrypted immediately with AES-GCM,
and never returned: responses only say credentials_set: true/false. Audit entries name the
action and the camera, never a credential value.
"""

import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import PlainTextResponse
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from anpr.api import schemas
from anpr.api.deps import Db, audit, rate_limit, require
from anpr.api.routes.cameras import camera_out
from anpr.api.services import camera_import
from anpr.db.models import AuditEntry, Camera, CameraStatusEvent, City, User, UserCity
from anpr.security import crypto, netprobe
from anpr.security.passwords import hash_password, policy_problems
from anpr.security.rbac import PRIVILEGED_ROLES, Actor
from anpr.security.tokens import revoke_user

router = APIRouter(prefix="/admin", tags=["admin"])
CREDENTIALS_PURPOSE = "camera-credentials"

CitiesWrite = Annotated[Actor, Depends(require("cities.write"))]
CamerasWrite = Annotated[Actor, Depends(require("cameras.write"))]
CredentialsWrite = Annotated[Actor, Depends(require("cameras.credentials.write"))]
UsersRead = Annotated[Actor, Depends(require("users.read"))]
UsersWrite = Annotated[Actor, Depends(require("users.write"))]
AuditRead = Annotated[Actor, Depends(require("audit.read"))]
# Camera locations and network details are sensitive: every registry route is rate limited per IP.
CAMERA_RATE = [Depends(rate_limit("cameras", "camera_rate_per_minute"))]
PROBE_RATE = [Depends(rate_limit("camera-probe", "probe_rate_per_minute"))]


def _commit(db, conflict: str) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, conflict) from None


# ---- cities ---------------------------------------------------------------------------

@router.post("/cities", response_model=schemas.CityOut, status_code=201, dependencies=CAMERA_RATE)
def create_city(body: schemas.CityIn, request: Request, actor: CitiesWrite, db: Db):
    city = City(name=body.name, region=body.region)
    db.add(city)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A city with this name already exists.") from None
    audit(request, db, actor, "city.create", "city", city.id)
    _commit(db, "A city with this name already exists.")
    return city


@router.patch("/cities/{city_id}", response_model=schemas.CityOut, dependencies=CAMERA_RATE)
def update_city(city_id: uuid.UUID, body: schemas.CityPatch, request: Request, actor: CitiesWrite, db: Db):
    city = db.get(City, city_id) or _not_found("City")
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    for field, value in changes.items():
        setattr(city, field, value)
    audit(request, db, actor, "city.update", "city", city.id, justification=", ".join(sorted(changes)) or None)
    _commit(db, "A city with this name already exists.")
    return city


@router.delete("/cities/{city_id}", status_code=204, dependencies=CAMERA_RATE)
def delete_city(city_id: uuid.UUID, request: Request, actor: CitiesWrite, db: Db):
    city = db.get(City, city_id) or _not_found("City")
    cameras = db.scalar(select(func.count()).select_from(Camera).where(Camera.city_id == city_id))
    if cameras:
        raise HTTPException(409, f"The city still has {cameras} camera(s); move or delete them first.")
    db.delete(city)
    audit(request, db, actor, "city.delete", "city", city_id)
    _commit(db, "The city still has analysts assigned; change their cities first.")


# ---- cameras --------------------------------------------------------------------------

def _status_event(db, camera: Camera, reason: str) -> None:
    db.add(CameraStatusEvent(camera_id=camera.id, status=camera.status, reason=reason[:120]))


@router.post("/cameras", response_model=schemas.CameraOut, status_code=201, dependencies=CAMERA_RATE)
def create_camera(body: schemas.CameraIn, request: Request, actor: CamerasWrite, db: Db):
    if db.get(City, body.city_id) is None:
        raise HTTPException(422, "Unknown city.")
    camera = Camera(**body.model_dump())
    db.add(camera)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "This city already has a camera with this name.") from None
    _status_event(db, camera, "created")
    audit(request, db, actor, "camera.create", "camera", camera.id)
    _commit(db, "This city already has a camera with this name.")
    return camera_out(camera)


@router.patch("/cameras/{camera_id}", response_model=schemas.CameraOut, dependencies=CAMERA_RATE)
def update_camera(camera_id: uuid.UUID, body: schemas.CameraPatch, request: Request, actor: CamerasWrite, db: Db):
    camera = db.get(Camera, camera_id) or _not_found("Camera")
    changes = body.model_dump(exclude_unset=True)
    for field in ("name", "kind", "latitude", "longitude", "protocol", "status"):  # NOT NULL columns
        if field in changes and changes[field] is None:
            raise HTTPException(422, f"{field} cannot be empty.")
    old_status = camera.status
    for field, value in changes.items():
        setattr(camera, field, value)
    camera.updated_at = datetime.now(UTC)
    if camera.status != old_status:
        _status_event(db, camera, "maintenance mode" if camera.status == "maintenance" else "set by admin")
    # Field names only: values (addresses, hosts) stay out of the audit log.
    audit(request, db, actor, "camera.update", "camera", camera.id, justification=", ".join(sorted(changes)) or None)
    _commit(db, "This city already has a camera with this name.")
    request.app.state.streams.stop(camera.id)  # a live view reconnects with the new address
    return camera_out(camera)


@router.delete("/cameras/{camera_id}", status_code=204, dependencies=CAMERA_RATE)
def delete_camera(camera_id: uuid.UUID, request: Request, actor: CamerasWrite, db: Db):
    camera = db.get(Camera, camera_id) or _not_found("Camera")
    db.delete(camera)
    audit(request, db, actor, "camera.delete", "camera", camera_id)
    _commit(db, "The camera has detections; set its status to maintenance instead of deleting it.")
    request.app.state.streams.stop(camera_id)


@router.put("/cameras/{camera_id}/credentials", status_code=204, dependencies=CAMERA_RATE,
            summary="Replace the camera's credentials (write-only)")
def replace_credentials(camera_id: uuid.UUID, body: schemas.CameraCredentialsIn, request: Request,
                        actor: CredentialsWrite, db: Db):
    camera = db.get(Camera, camera_id) or _not_found("Camera")
    plaintext = json.dumps({"username": body.username, "password": body.password}).encode()
    camera.credentials_encrypted, camera.credentials_key_id = crypto.encrypt(
        request.app.state.keys, plaintext, purpose=CREDENTIALS_PURPOSE, row_id=str(camera.id))
    camera.updated_at = datetime.now(UTC)
    audit(request, db, actor, "camera.credentials.replace", "camera", camera.id)
    db.commit()
    request.app.state.streams.stop(camera.id)  # reconnect with the new credentials


@router.delete("/cameras/{camera_id}/credentials", status_code=204, dependencies=CAMERA_RATE)
def clear_credentials(camera_id: uuid.UUID, request: Request, actor: CredentialsWrite, db: Db):
    camera = db.get(Camera, camera_id) or _not_found("Camera")
    camera.credentials_encrypted = camera.credentials_key_id = None
    camera.updated_at = datetime.now(UTC)
    audit(request, db, actor, "camera.credentials.clear", "camera", camera.id)
    db.commit()
    request.app.state.streams.stop(camera.id)


def _probe(request: Request, protocol: str, host: str | None, port: int | None) -> netprobe.ProbeResult:
    settings = request.app.state.settings
    try:
        return netprobe.probe(protocol, host or "", port, timeout=settings.probe_timeout_seconds,
                              allowed_networks=netprobe.parse_networks(settings.allowed_camera_networks))
    except netprobe.ProbeRefused as e:
        raise HTTPException(422, str(e)) from None


def _probe_out(result: netprobe.ProbeResult) -> schemas.ConnectionTestOut:
    return schemas.ConnectionTestOut(
        reachable=result.reachable, verdict=result.verdict, latency_ms=result.latency_ms,
        steps=[schemas.ProbeStepOut(name=s.name, ok=s.ok, ms=s.ms, detail=s.detail) for s in result.steps],
        tls_not_after=result.tls_not_after, tested_at=datetime.now(UTC))


def _probe_summary(result: netprobe.ProbeResult) -> str:
    latency = f" {result.latency_ms:g} ms" if result.latency_ms is not None else ""
    return f"{'reachable' if result.reachable else 'unreachable'}{latency}; stream not verified"


@router.post("/cameras/test-connection", response_model=schemas.ConnectionTestOut, dependencies=PROBE_RATE,
             summary="Test an unsaved camera: DNS, TCP, TLS. Does not verify the stream")
def test_draft_connection(body: schemas.ConnectionTestIn, request: Request, actor: CamerasWrite, db: Db):
    result = _probe(request, body.protocol, body.host, body.port)
    audit(request, db, actor, "camera.test_connection", "camera_draft", None, justification=_probe_summary(result))
    db.commit()
    return _probe_out(result)


@router.post("/cameras/{camera_id}/test-connection", response_model=schemas.ConnectionTestOut,
             dependencies=PROBE_RATE, summary="DNS, TCP and TLS checks. Does not verify the stream")
def test_connection(camera_id: uuid.UUID, request: Request, actor: CamerasWrite, db: Db):
    camera = db.get(Camera, camera_id) or _not_found("Camera")
    result = _probe(request, camera.protocol, camera.host, camera.port)
    if result.tls_not_after is not None:
        camera.tls_not_after = result.tls_not_after
    audit(request, db, actor, "camera.test_connection", "camera", camera.id, justification=_probe_summary(result))
    db.commit()
    return _probe_out(result)


@router.get("/cameras/import/template", response_class=PlainTextResponse, dependencies=CAMERA_RATE)
def import_template(actor: CamerasWrite):
    return PlainTextResponse(camera_import.TEMPLATE, media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="cameras_template.csv"'})


@router.post("/cameras/import", response_model=schemas.CameraImportOut, dependencies=CAMERA_RATE,
             summary="Bulk import from CSV: mode=preview writes nothing, mode=confirm inserts accepted rows")
async def import_cameras(request: Request, actor: CamerasWrite, db: Db, file: Annotated[UploadFile, File()],
                         mode: Annotated[Literal["preview", "confirm"], Query()] = "preview"):
    settings = request.app.state.settings
    data = await file.read(settings.max_csv_bytes + 1)
    try:
        parsed = camera_import.parse(db, file.filename or "upload.csv", data,
                                     max_bytes=settings.max_csv_bytes, max_rows=settings.max_csv_rows)
    except camera_import.CsvImportError as e:
        raise HTTPException(e.status, str(e)) from None
    if mode == "confirm":
        if not parsed.accepted:
            raise HTTPException(422, "No valid rows to import.")
        for camera in camera_import.write(db, parsed):
            _status_event(db, camera, "imported")
        audit(request, db, actor, "camera.import", "camera_import", None,
              justification=f"sha256={parsed.sha256} accepted={len(parsed.accepted)} rejected={len(parsed.rejected)}")
        _commit(db, "A camera in the file was created by someone else meanwhile; preview again.")
    return schemas.CameraImportOut(
        mode=mode, file_name=parsed.file_name, sha256=parsed.sha256, rows_total=parsed.rows_total,
        rows_accepted=len(parsed.accepted), rows_rejected=len(parsed.rejected),
        accepted=[schemas.CameraImportAccepted(line=r["line"], name=r["camera"].name, city_id=r["camera"].city_id,
                                               kind=r["camera"].kind, protocol=r["camera"].protocol)
                  for r in parsed.accepted],
        rejected=[schemas.CameraImportRejected(**r) for r in parsed.rejected])


@router.get("/cameras/{camera_id}/audit", response_model=list[schemas.CameraAuditOut], dependencies=CAMERA_RATE,
            summary="Recent audit entries for one camera")
def camera_audit(camera_id: uuid.UUID, actor: AuditRead, db: Db, limit: Annotated[int, Query(ge=1, le=100)] = 20):
    return db.scalars(select(AuditEntry).where(AuditEntry.target_type == "camera",
                                               AuditEntry.target_id == str(camera_id))
                      .order_by(AuditEntry.seq.desc()).limit(limit)).all()


# ---- users ----------------------------------------------------------------------------

def _user_out(db, user: User) -> schemas.UserOut:
    city_ids = list(db.scalars(select(UserCity.city_id).where(UserCity.user_id == user.id)))
    return schemas.UserOut(
        id=user.id, username=user.username, role=user.role, is_active=user.is_active,
        mfa_enrolled=user.totp_confirmed_at is not None,
        locked=user.locked_until is not None and user.locked_until > datetime.now(UTC),
        city_ids=city_ids, created_at=user.created_at,
    )


def _check_password(password: str, username: str) -> None:
    problems = policy_problems(password, username)
    if problems:
        raise HTTPException(422, " ".join(problems))


def _check_manages(actor: Actor, *roles: str) -> None:
    """Only a super admin creates, changes or resets admin and super admin accounts."""
    if actor.role != "super_admin" and PRIVILEGED_ROLES.intersection(roles):
        raise HTTPException(403, "Only a super admin manages admin accounts.")


def _set_cities(db, user: User, city_ids: list[uuid.UUID]) -> None:
    if city_ids and user.role != "analyst":
        raise HTTPException(422, "Only analysts are limited to cities; admins and auditors see all cities.")
    unique = set(city_ids)
    found = set(db.scalars(select(City.id).where(City.id.in_(unique)))) if unique else set()
    if found != unique:
        raise HTTPException(422, "Unknown city.")
    db.execute(delete(UserCity).where(UserCity.user_id == user.id))
    db.add_all(UserCity(user_id=user.id, city_id=c) for c in unique)


@router.get("/users", response_model=list[schemas.UserOut])
def list_users(actor: UsersRead, db: Db):
    return [_user_out(db, u) for u in db.scalars(select(User).order_by(User.username))]


@router.post("/users", response_model=schemas.UserOut, status_code=201)
def create_user(body: schemas.UserCreateIn, request: Request, actor: UsersWrite, db: Db):
    _check_manages(actor, body.role)
    _check_password(body.password, body.username)
    user = User(username=body.username, password_hash=hash_password(body.password), role=body.role,
                is_active=True, failed_attempts=0)
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "That username is taken.") from None
    _set_cities(db, user, body.city_ids)
    audit(request, db, actor, "user.create", "user", user.id, justification=f"role={user.role}")
    db.commit()
    return _user_out(db, user)


@router.patch("/users/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: uuid.UUID, body: schemas.UserPatch, request: Request, actor: UsersWrite, db: Db):
    user = db.get(User, user_id) or _not_found("User")
    changes = body.model_dump(exclude_unset=True)
    _check_manages(actor, user.role, changes.get("role") or user.role)
    if str(user.id) == actor.id and (changes.get("role", user.role) != user.role or changes.get("is_active") is False):
        raise HTTPException(409, "You cannot demote or deactivate your own account.")
    if changes.get("role") is not None:
        user.role = changes["role"]
        if user.role != "analyst":
            db.execute(delete(UserCity).where(UserCity.user_id == user.id))
    if changes.get("is_active") is not None:
        user.is_active = changes["is_active"]
        if not user.is_active:
            revoke_user(db, user.id)
    if changes.get("city_ids") is not None:
        _set_cities(db, user, changes["city_ids"])
    user.updated_at = datetime.now(UTC)
    audit(request, db, actor, "user.update", "user", user.id,
          justification=", ".join(f"{k}={v}" for k, v in sorted(changes.items()) if k != "city_ids") or None)
    db.commit()
    return _user_out(db, user)


@router.put("/users/{user_id}/password", status_code=204)
def reset_password(user_id: uuid.UUID, body: schemas.PasswordIn, request: Request, actor: UsersWrite, db: Db):
    user = db.get(User, user_id) or _not_found("User")
    _check_manages(actor, user.role)
    _check_password(body.password, user.username)
    user.password_hash = hash_password(body.password)
    user.updated_at = datetime.now(UTC)
    revoke_user(db, user.id)
    audit(request, db, actor, "user.password.reset", "user", user.id)
    db.commit()


@router.post("/users/{user_id}/unlock", status_code=204)
def unlock_user(user_id: uuid.UUID, request: Request, actor: UsersWrite, db: Db):
    user = db.get(User, user_id) or _not_found("User")
    _check_manages(actor, user.role)
    user.locked_until, user.failed_attempts = None, 0
    audit(request, db, actor, "user.unlock", "user", user.id)
    db.commit()


@router.post("/users/{user_id}/reset-mfa", status_code=204, summary="Force the user to set up MFA again")
def reset_mfa(user_id: uuid.UUID, request: Request, actor: UsersWrite, db: Db):
    user = db.get(User, user_id) or _not_found("User")
    _check_manages(actor, user.role)
    user.totp_secret_encrypted = user.totp_key_id = user.totp_confirmed_at = user.totp_last_step = None
    revoke_user(db, user.id)
    audit(request, db, actor, "user.mfa.reset", "user", user.id)
    db.commit()


def _not_found(what: str):
    raise HTTPException(404, f"{what} not found.")
