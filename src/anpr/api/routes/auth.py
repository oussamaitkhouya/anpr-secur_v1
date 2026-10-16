"""Sign-in: password, then TOTP, then cookies.

    POST /auth/login       username + password  -> mfa_pending cookie (5 min)
    POST /auth/mfa/setup   first sign-in only: returns the otpauth:// URI to scan, once
    POST /auth/mfa         6-digit code          -> access_token (15 min) + refresh_token (7 days)
    POST /auth/refresh     rotates the refresh token, new access token
    POST /auth/logout      revokes the refresh token family, clears cookies
    GET  /auth/me

Failures all answer "Invalid credentials" with the same status and roughly the same time
(unknown users still cost one Argon2 verification), so the response does not reveal whether
the username exists, the account is locked, or the password was right. Password and MFA
failures both count toward the lockout (MAX_FAILED_LOGINS, then LOCKOUT_MINUTES).
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select

from anpr.api import schemas
from anpr.api.deps import (
    ACCESS_COOKIE,
    INVALID_CREDENTIALS,
    MFA_COOKIE,
    REFRESH_COOKIE,
    Db,
    anonymous,
    audit,
    current_actor,
    load_actor,
    public,
    rate_limit,
    require,
)
from anpr.db.models import User
from anpr.security import crypto, mfa
from anpr.security.passwords import (
    burn_time,
    hash_password,
    needs_rehash,
    verify_password,
)
from anpr.security.rbac import Actor
from anpr.security.tokens import (
    RefreshReuseError,
    TokenError,
    create_jwt,
    decode_jwt,
    family_of,
    issue_refresh,
    revoke_family,
    rotate_refresh,
)

router = APIRouter(prefix="/auth", tags=["auth"])
TOTP_PURPOSE = "totp-secret"
AUTH_PATH = "/api/v1/auth"


def _set_cookie(response: Response, name: str, value: str, max_age: int, path: str) -> None:
    response.set_cookie(name, value, max_age=max_age, path=path, httponly=True, secure=True, samesite="strict")


def _clear_cookies(response: Response) -> None:
    for name, path in ((ACCESS_COOKIE, "/api/v1"), (REFRESH_COOKIE, AUTH_PATH), (MFA_COOKIE, AUTH_PATH)):
        response.delete_cookie(name, path=path, httponly=True, secure=True, samesite="strict")


def _issue_session(request: Request, response: Response, db, user: User, family_id: uuid.UUID | None = None,
                   refresh: str | None = None) -> None:
    s = request.app.state.settings
    refresh = refresh or issue_refresh(db, user.id, s.refresh_token_days, family_id)
    _set_cookie(response, ACCESS_COOKIE, create_jwt(s.jwt_secret, str(user.id), "access", s.access_token_minutes),
                s.access_token_minutes * 60, "/api/v1")
    _set_cookie(response, REFRESH_COOKIE, refresh, s.refresh_token_days * 86400, AUTH_PATH)


def _fail(request: Request, db, user: User | None, action: str, target_id: str | None) -> HTTPException:
    """Count a failed attempt (and lock if over the limit), audit it, commit, return the generic 401."""
    s = request.app.state.settings
    actor = anonymous(request)
    if user is not None:
        actor = Actor(id=str(user.id), role=user.role, ip=actor.ip, username=user.username)
        user.failed_attempts += 1
        if user.failed_attempts >= s.max_failed_logins:
            user.locked_until = datetime.now(UTC) + timedelta(minutes=s.lockout_minutes)
            user.failed_attempts = 0
            audit(request, db, actor, "auth.lockout", "user", user.id)
    audit(request, db, actor, action, "user", target_id)
    db.commit()
    return HTTPException(401, INVALID_CREDENTIALS)


def _locked(user: User) -> bool:
    return user.locked_until is not None and user.locked_until > datetime.now(UTC)


def _mfa_user(request: Request, db) -> User:
    token = request.cookies.get(MFA_COOKIE)
    try:
        user_id = uuid.UUID(decode_jwt(request.app.state.settings.jwt_secret, token or "", "mfa"))
    except (TokenError, ValueError):
        raise HTTPException(401, INVALID_CREDENTIALS) from None
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, INVALID_CREDENTIALS)
    return user


@router.post("/login", response_model=schemas.LoginOut, summary="Step 1: username and password",
             dependencies=[Depends(public), Depends(rate_limit("login", "auth_rate_per_minute"))])
def login(body: schemas.LoginIn, request: Request, response: Response, db: Db):
    s = request.app.state.settings
    username = body.username.strip().lower()
    user = db.scalars(select(User).where(User.username == username)).one_or_none()
    if user is None:
        burn_time(body.password)
        raise _fail(request, db, None, "auth.login.failure", username[:64])
    # Verify even for inactive or locked accounts, so timing is the same in every case.
    ok = verify_password(user.password_hash, body.password)
    if not user.is_active or _locked(user):
        raise _fail(request, db, None if _locked(user) else user, "auth.login.blocked", str(user.id))
    if not ok:
        raise _fail(request, db, user, "auth.login.failure", str(user.id))

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    actor = Actor(id=str(user.id), role=user.role, ip=anonymous(request).ip, username=user.username)
    audit(request, db, actor, "auth.password.success", "user", user.id)
    db.commit()
    _set_cookie(response, MFA_COOKIE, create_jwt(s.jwt_secret, str(user.id), "mfa", s.mfa_pending_minutes),
                s.mfa_pending_minutes * 60, AUTH_PATH)
    return schemas.LoginOut(mfa_enrolled=user.totp_confirmed_at is not None)


@router.post("/mfa/setup", response_model=schemas.MfaSetupOut, summary="First sign-in: get the TOTP secret to scan",
             dependencies=[Depends(public), Depends(rate_limit("mfa", "auth_rate_per_minute"))])
def mfa_setup(request: Request, db: Db):
    user = _mfa_user(request, db)
    if user.totp_confirmed_at is not None:
        # Re-enrolment goes through an admin (POST /admin/users/{id}/reset-mfa), never through here.
        raise HTTPException(409, "MFA is already set up for this account.")
    secret = mfa.new_secret()
    user.totp_secret_encrypted, user.totp_key_id = crypto.encrypt(
        request.app.state.keys, secret.encode(), purpose=TOTP_PURPOSE, row_id=str(user.id))
    user.totp_last_step = None
    audit(request, db, Actor(id=str(user.id), role=user.role, ip=anonymous(request).ip), "auth.mfa.setup", "user", user.id)
    db.commit()
    return schemas.MfaSetupOut(otpauth_uri=mfa.provisioning_uri(secret, user.username), secret=secret)


@router.post("/mfa", response_model=schemas.MeOut, summary="Step 2: TOTP code; sets the session cookies",
             dependencies=[Depends(public), Depends(rate_limit("mfa", "auth_rate_per_minute"))])
def mfa_verify(body: schemas.MfaIn, request: Request, response: Response, db: Db):
    user = _mfa_user(request, db)
    if _locked(user) or user.totp_secret_encrypted is None:
        raise _fail(request, db, None, "auth.mfa.failure", str(user.id))
    secret = crypto.decrypt(request.app.state.keys, user.totp_secret_encrypted, user.totp_key_id,
                            purpose=TOTP_PURPOSE, row_id=str(user.id)).decode()
    step = mfa.verify(secret, body.code, user.totp_last_step)
    if step is None:
        raise _fail(request, db, user, "auth.mfa.failure", str(user.id))

    user.totp_last_step = step
    user.totp_confirmed_at = user.totp_confirmed_at or datetime.now(UTC)
    user.failed_attempts = 0
    user.locked_until = None
    actor = load_actor(db, user, anonymous(request).ip)
    _issue_session(request, response, db, user)
    audit(request, db, actor, "auth.login.success", "user", user.id)
    db.commit()
    response.delete_cookie(MFA_COOKIE, path=AUTH_PATH, httponly=True, secure=True, samesite="strict")
    return _me(actor)


@router.post("/refresh", status_code=204, summary="Rotate the refresh token and issue a new access token",
             dependencies=[Depends(public), Depends(rate_limit("refresh", "auth_rate_per_minute"))])
def refresh(request: Request, response: Response, db: Db):
    s = request.app.state.settings
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise HTTPException(401, "Sign in again.")
    try:
        user_id, new_raw = rotate_refresh(db, raw, s.refresh_token_days)
    except RefreshReuseError as e:
        audit(request, db, Actor(id=str(e), role="unknown", ip=anonymous(request).ip), "auth.refresh.reuse", "user", str(e))
        db.commit()  # keep the family revocation
        raise HTTPException(401, "Sign in again.") from None
    except TokenError:
        raise HTTPException(401, "Sign in again.") from None
    user = db.get(User, user_id)
    if user is None or not user.is_active or _locked(user):
        db.rollback()
        raise HTTPException(401, "Sign in again.")
    _issue_session(request, response, db, user, refresh=new_raw)
    db.commit()
    response.status_code = 204
    return response


@router.post("/logout", status_code=204, summary="End the session everywhere this refresh family is used",
             dependencies=[Depends(public)])
def logout(request: Request, response: Response, db: Db):
    raw = request.cookies.get(REFRESH_COOKIE)
    family = family_of(db, raw) if raw else None
    if family is not None:
        revoke_family(db, family)
        try:
            actor = current_actor(request, db)
            audit(request, db, actor, "auth.logout", "user", actor.id)
        except HTTPException:
            pass  # access token already expired: still revoke, just without an actor
        db.commit()
    _clear_cookies(response)
    response.status_code = 204
    return response


def _me(actor: Actor) -> schemas.MeOut:
    return schemas.MeOut(id=uuid.UUID(actor.id), username=actor.username, role=actor.role,
                         city_ids=sorted(actor.city_ids, key=str) if actor.city_ids is not None else None)


@router.get("/me", response_model=schemas.MeOut, summary="The signed-in user")
def me(actor: Annotated[Actor, Depends(require("self"))]):
    return _me(actor)


@router.post("/password", status_code=204, summary="Change your own password (signs you out everywhere)",
             dependencies=[Depends(rate_limit("password", "auth_rate_per_minute"))])
def change_password(body: schemas.PasswordChangeIn, request: Request, response: Response,
                    actor: Annotated[Actor, Depends(require("self"))], db: Db):
    """The current password is checked like a sign-in (a wrong one counts toward lockout). On
    success every session of the account ends, this one included: sign in again."""
    from anpr.security.passwords import policy_problems
    from anpr.security.tokens import revoke_user

    user = db.get(User, uuid.UUID(actor.id))
    if user is None or not verify_password(user.password_hash, body.current_password):
        raise _fail(request, db, user, "auth.password.change.failure", actor.id)
    problems = policy_problems(body.new_password, user.username)
    if problems:
        raise HTTPException(422, " ".join(problems))
    if verify_password(user.password_hash, body.new_password):
        raise HTTPException(422, "The new password must differ from the current one.")
    user.password_hash = hash_password(body.new_password)
    user.failed_attempts = 0
    user.updated_at = datetime.now(UTC)
    revoke_user(db, user.id)
    audit(request, db, actor, "auth.password.change", "user", user.id)
    db.commit()
    _clear_cookies(response)
    response.status_code = 204
    return response


@router.post("/sessions/revoke", status_code=204, summary="Sign out of every device")
def revoke_sessions(request: Request, response: Response, actor: Annotated[Actor, Depends(require("self"))], db: Db):
    from anpr.security.tokens import revoke_user

    revoke_user(db, uuid.UUID(actor.id))
    audit(request, db, actor, "auth.sessions.revoke", "user", actor.id)
    db.commit()
    _clear_cookies(response)
    response.status_code = 204
    return response
