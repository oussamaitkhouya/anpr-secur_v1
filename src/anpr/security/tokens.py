"""Access tokens (JWT), the MFA-pending token, and rotating refresh tokens.

    access token   JWT HS256, 15 min, typ="access". Only holds the user id: role, active flag and
                   cities are re-read from the database on every request.
    mfa token      JWT HS256, 5 min, typ="mfa". Proves the password step passed; it is useless
                   without a valid TOTP code and cannot be used as an access token (typ check).
    refresh token  random 256-bit string. The database stores only its SHA-256. Single use: each
                   refresh marks it used and issues the next one in the same family. If a used
                   token comes back, someone copied it, so the whole family is revoked.

All three travel in httpOnly, Secure, SameSite=Strict cookies, never in URLs or response bodies.
"""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from anpr.db.models import RefreshToken

ALGORITHM = "HS256"
ISSUER = "anpr-secure"


class TokenError(Exception):
    """Invalid, expired, wrong type, or reused. Callers turn it into a generic 401."""


class RefreshReuseError(TokenError):
    """A refresh token that was already used came back: likely stolen. Its family is revoked."""


def _now() -> datetime:
    return datetime.now(UTC)


def create_jwt(secret: str, user_id: str, typ: str, minutes: int) -> str:
    now = _now()
    claims = {"sub": user_id, "typ": typ, "iss": ISSUER, "iat": now, "exp": now + timedelta(minutes=minutes),
              "jti": uuid.uuid4().hex}
    return jwt.encode(claims, secret, algorithm=ALGORITHM)


def decode_jwt(secret: str, token: str, typ: str) -> str:
    """Return the user id. The algorithm is pinned, so a token signed with "none" or RS256 is refused."""
    try:
        claims = jwt.decode(token, secret, algorithms=[ALGORITHM], issuer=ISSUER,
                            options={"require": ["sub", "typ", "exp", "iat", "iss"]})
    except jwt.PyJWTError:
        raise TokenError("invalid token") from None
    if claims["typ"] != typ:
        raise TokenError("wrong token type")
    return claims["sub"]


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def issue_refresh(session: Session, user_id: uuid.UUID, days: int, family_id: uuid.UUID | None = None) -> str:
    raw = secrets.token_urlsafe(32)
    session.add(RefreshToken(user_id=user_id, family_id=family_id or uuid.uuid4(), token_sha256=sha256_hex(raw),
                             expires_at=_now() + timedelta(days=days)))
    session.flush()
    return raw


def rotate_refresh(session: Session, raw: str, days: int) -> tuple[uuid.UUID, str]:
    """Consume a refresh token and return (user_id, next token). Raises TokenError.

    The row is locked (FOR UPDATE) so two concurrent refreshes with the same token cannot both win.
    """
    row = session.execute(
        select(RefreshToken).where(RefreshToken.token_sha256 == sha256_hex(raw)).with_for_update()
    ).scalar_one_or_none()
    if row is None:
        raise TokenError("unknown refresh token")
    if row.used_at is not None or row.revoked_at is not None:
        revoke_family(session, row.family_id)  # reuse: assume theft, log everyone in this family out
        raise RefreshReuseError(str(row.user_id))
    if row.expires_at <= _now():
        raise TokenError("refresh token expired")
    row.used_at = _now()
    return row.user_id, issue_refresh(session, row.user_id, days, row.family_id)


def revoke_family(session: Session, family_id: uuid.UUID) -> None:
    session.execute(update(RefreshToken).where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
                    .values(revoked_at=_now()))


def revoke_user(session: Session, user_id: uuid.UUID) -> None:
    """Log a user out everywhere (deactivation, password reset)."""
    session.execute(update(RefreshToken).where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
                    .values(revoked_at=_now()))


def family_of(session: Session, raw: str) -> uuid.UUID | None:
    return session.execute(select(RefreshToken.family_id).where(RefreshToken.token_sha256 == sha256_hex(raw))).scalar()
