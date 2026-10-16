"""Request dependencies: database session, who is calling, permission checks, rate limits, audit.

Every route under /api/v1 depends on exactly one of:
    require("<permission>")   a signed-in user whose role has that permission (rbac.PERMISSIONS)
    detection_service         the detection service, by its own token
    public                    deliberately open (login, refresh, public key)
tests/test_api_rbac.py fails if a route has none of them.
"""

import hashlib
import hmac
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.db.models import User, UserCity
from anpr.security import audit_chain, rbac
from anpr.security.rbac import Actor
from anpr.security.tokens import TokenError, decode_jwt
from anpr.utils.settings import Settings

ACCESS_COOKIE = "access_token"
REFRESH_COOKIE = "refresh_token"
MFA_COOKIE = "mfa_pending"
INVALID_CREDENTIALS = "Invalid credentials"


def get_db(request: Request) -> Iterator[Session]:
    session = request.app.state.session_factory()
    try:
        yield session
    finally:
        session.close()


Db = Annotated[Session, Depends(get_db)]


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def client_ip(request: Request) -> str:
    settings: Settings = request.app.state.settings
    if settings.trust_proxy_headers:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()[:45]
    return request.client.host if request.client else "unknown"


def rate_limit(bucket: str, setting: str):
    """Dependency: per-IP limit for `bucket`, the limit read from Settings.<setting>."""
    def check(request: Request) -> None:
        limit = getattr(request.app.state.settings, setting)
        wait = request.app.state.limiter.hit(bucket, client_ip(request), limit)
        if wait is not None:
            raise HTTPException(429, "Too many requests. Try again later.", headers={"Retry-After": str(wait)})
    return check


def load_actor(db: Session, user: User, ip: str) -> Actor:
    city_ids = None
    if user.role not in rbac.UNSCOPED_ROLES:
        city_ids = frozenset(db.scalars(select(UserCity.city_id).where(UserCity.user_id == user.id)))
    return Actor(id=str(user.id), role=user.role, ip=ip, username=user.username, city_ids=city_ids)


def current_actor(request: Request, db: Db) -> Actor:
    """The signed-in user, re-read from the database on every request."""
    token = request.cookies.get(ACCESS_COOKIE)
    if not token:
        raise HTTPException(401, "Sign in first.")
    try:
        user_id = uuid.UUID(decode_jwt(request.app.state.settings.jwt_secret, token, "access"))
    except (TokenError, ValueError):
        raise HTTPException(401, "Your session has expired. Sign in again.") from None
    user = db.get(User, user_id)
    now = datetime.now(UTC)
    if user is None or not user.is_active or (user.locked_until and user.locked_until > now):
        raise HTTPException(401, "Your session has expired. Sign in again.")
    return load_actor(db, user, client_ip(request))


def require(permission: str):
    """Dependency factory: the caller must have `permission`. Returns the Actor."""
    if permission not in rbac.ALL_PERMISSIONS:
        raise ValueError(f"unknown permission {permission!r}")  # typo in a route: fail at import time

    def dependency(actor: Annotated[Actor, Depends(current_actor)]) -> Actor:
        if not rbac.allowed(actor.role, permission):
            raise HTTPException(403, "Your role does not allow this.")
        return actor

    dependency.permission = permission  # read by the route-coverage test
    return dependency


def detection_service(request: Request) -> Actor:
    """The detection service sends `Authorization: Bearer <token>`. Only the token's SHA-256 is
    configured on the server, compared in constant time."""
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    expected = request.app.state.settings.detection_token_sha256
    presented = hashlib.sha256(token.strip().encode()).hexdigest()
    if scheme.lower() != "bearer" or not token or not hmac.compare_digest(presented, expected):
        raise HTTPException(401, INVALID_CREDENTIALS, headers={"WWW-Authenticate": "Bearer"})
    return Actor(id=rbac.SERVICE_DETECTIONS, role="service", ip=client_ip(request))


detection_service.service = True


def public() -> None:
    """Marks a route as deliberately unauthenticated."""


public.public = True


def audit(request: Request, db: Session, actor: Actor, action: str, target_type: str,
          target_id: str | uuid.UUID | None = None, justification: str | None = None) -> None:
    """Append to the signed audit chain inside the current transaction."""
    audit_chain.append(db, request.app.state.keys.audit_signing_key(), actor, action, target_type,
                       str(target_id) if target_id is not None else None, justification)


def anonymous(request: Request) -> Actor:
    return Actor(id="anonymous", role="anonymous", ip=client_ip(request))
