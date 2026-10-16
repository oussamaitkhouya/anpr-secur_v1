"""Security Center and system settings: posture computed live from the database, the audit log
and the running configuration. Nothing here is a static claim: each check is a query.

    GET /security/overview   admins, auditors (security.read)
    GET /system/settings     admins (system.read): limits and key ids, never key material
"""

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select

from anpr.api import schemas
from anpr.api.deps import Db, rate_limit, require
from anpr.db.models import AuditEntry, Camera, User
from anpr.security import audit_chain
from anpr.security.keys import parse_data_keys
from anpr.security.rbac import Actor
from anpr.utils.settings import PLACEHOLDER_MARKERS

router = APIRouter(tags=["security"], dependencies=[Depends(rate_limit("security", "camera_rate_per_minute"))])
SecurityRead = Annotated[Actor, Depends(require("security.read"))]
SystemRead = Annotated[Actor, Depends(require("system.read"))]

FAILURE_ACTIONS = ("auth.login.failure", "auth.mfa.failure", "auth.login.blocked", "auth.lockout", "auth.refresh.reuse")


def _check(id_: str, title: str, ok: bool, detail: str, *, warn: bool = False, count: int | None = None, area: str) -> schemas.SecurityCheckOut:
    return schemas.SecurityCheckOut(id=id_, title=title, status="ok" if ok else ("warn" if warn else "fail"), detail=detail, count=count, area=area)


@router.get("/security/overview", response_model=schemas.SecurityOverviewOut, summary="Live security posture")
def overview(request: Request, actor: SecurityRead, db: Db):
    now = datetime.now(UTC)
    s = request.app.state.settings
    checks: list[schemas.SecurityCheckOut] = []

    cams = db.scalars(select(Camera)).all()
    networked = [c for c in cams if c.protocol not in ("webhook", "file")]
    clear = [c for c in cams if c.protocol == "rtsp"]
    no_creds = [c for c in networked if c.credentials_encrypted is None]
    expired = [c for c in cams if c.tls_not_after and c.tls_not_after <= now]
    expiring = [c for c in cams if c.tls_not_after and now < c.tls_not_after <= now + timedelta(days=30)]
    offline = [c for c in cams if c.status == "offline"]
    checks += [
        _check("cam-transport", "Encrypted camera transport", not clear, f"{len(clear)} camera(s) stream over plain RTSP (video and login in clear text)." if clear else "No camera uses plain RTSP.", warn=True, count=len(clear), area="Cameras"),
        _check("cam-credentials", "Camera credentials stored", not no_creds, f"{len(no_creds)} networked camera(s) have no credentials." if no_creds else "Every networked camera has encrypted credentials.", warn=True, count=len(no_creds), area="Cameras"),
        _check("cam-tls-expired", "No expired camera certificates", not expired, f"{len(expired)} RTSPS certificate(s) expired." if expired else "No expired certificate recorded.", count=len(expired), area="Cameras"),
        _check("cam-tls-soon", "Certificates valid 30+ days", not expiring, f"{len(expiring)} certificate(s) expire within 30 days." if expiring else "No certificate expires within 30 days.", warn=True, count=len(expiring), area="Cameras"),
        _check("cam-offline", "Cameras online", not offline, f"{len(offline)} camera(s) offline." if offline else "No camera reported offline.", warn=True, count=len(offline), area="Cameras"),
    ]

    users = db.scalars(select(User)).all()
    active = [u for u in users if u.is_active]
    no_mfa = [u for u in active if u.totp_confirmed_at is None]
    locked = [u for u in active if u.locked_until and u.locked_until > now]
    admins = [u for u in active if u.role in ("super_admin", "admin")]
    checks += [
        _check("acct-mfa", "MFA enrolled", not no_mfa, f"{len(no_mfa)} active account(s) have not set up MFA yet (they must at next sign-in)." if no_mfa else "Every active account uses MFA.", warn=True, count=len(no_mfa), area="Accounts"),
        _check("acct-locked", "No locked accounts", not locked, f"{len(locked)} account(s) locked after failed sign-ins." if locked else "No account is locked.", warn=True, count=len(locked), area="Accounts"),
        _check("acct-admins", "At least two admins", len(admins) >= 2, f"{len(admins)} active admin(s). One admin is a single point of failure." if len(admins) < 2 else f"{len(admins)} active admins.", warn=True, count=len(admins), area="Accounts"),
    ]

    day_ago = now - timedelta(hours=24)
    failures = dict(db.execute(select(AuditEntry.action, func.count()).where(AuditEntry.action.in_(FAILURE_ACTIONS), AuditEntry.ts >= day_ago)
                               .group_by(AuditEntry.action)).all())
    failed_logins = failures.get("auth.login.failure", 0) + failures.get("auth.mfa.failure", 0)
    reuse = failures.get("auth.refresh.reuse", 0)
    checks += [
        _check("auth-failures", "Sign-in failures (24 h)", failed_logins < 20, f"{failed_logins} failed password or MFA attempt(s) in the last 24 hours.", warn=True, count=failed_logins, area="Sign-in"),
        _check("auth-reuse", "No stolen refresh tokens", reuse == 0, f"{reuse} refresh-token reuse event(s): a token was used twice, its session family was revoked." if reuse else "No refresh-token reuse detected.", count=reuse, area="Sign-in"),
    ]

    chain = audit_chain.verify(db, request.app.state.keys.audit_signing_key().public_key())
    checks.append(_check("audit-chain", "Audit log intact", chain.ok, f"{chain.entries} entries verified (hash links + Ed25519 signatures)." if chain.ok else f"Broken at entry #{chain.first_bad_seq}: {chain.reason}.", count=chain.entries, area="Integrity"))

    key_ids = list(parse_data_keys(s.data_keys))
    placeholder = any(m in v.lower() for v in (s.jwt_secret, s.audit_signing_key) for m in PLACEHOLDER_MARKERS)
    checks += [
        _check("cfg-env", "Production mode", s.is_production, f"APP_ENV={s.app_env}. Production refuses placeholder secrets and hides /docs." , warn=True, area="Configuration"),
        _check("cfg-secrets", "No placeholder secrets", not placeholder, "A secret still holds a value from .env.example." if placeholder else "Secrets are not placeholders.", area="Configuration"),
        _check("cfg-cors", "CORS limited to known origins", "*" not in s.cors_origins and bool(s.cors_origins), f"Allowed origins: {', '.join(s.cors_origins) or 'none'}.", area="Configuration"),
        _check("cfg-keys", "Data key rotation ready", len(key_ids) >= 1, f"Active data key {s.active_data_key_id}; {len(key_ids)} key id(s) loaded. Keys live in the environment (Vault/KMS not wired yet).", warn=True, area="Configuration"),
    ]

    events = db.scalars(select(AuditEntry).where(AuditEntry.action.in_(FAILURE_ACTIONS)).order_by(AuditEntry.seq.desc()).limit(20)).all()
    return schemas.SecurityOverviewOut(checked_at=now, checks=checks, recent_events=events)


@router.get("/system/settings", response_model=schemas.SystemSettingsOut, summary="Running limits and key ids (no key material)")
def system_settings(request: Request, actor: SystemRead):
    s = request.app.state.settings
    return schemas.SystemSettingsOut(
        app_env=s.app_env, cors_origins=list(s.cors_origins), access_token_minutes=s.access_token_minutes,
        refresh_token_days=s.refresh_token_days, max_failed_logins=s.max_failed_logins, lockout_minutes=s.lockout_minutes,
        auth_rate_per_minute=s.auth_rate_per_minute, camera_rate_per_minute=s.camera_rate_per_minute,
        probe_rate_per_minute=s.probe_rate_per_minute, detection_rate_per_minute=s.detection_rate_per_minute,
        max_csv_bytes=s.max_csv_bytes, max_csv_rows=s.max_csv_rows, allowed_camera_networks=list(s.allowed_camera_networks),
        data_key_ids=list(parse_data_keys(s.data_keys)), active_data_key_id=s.active_data_key_id,
        trust_proxy_headers=s.trust_proxy_headers,
    )
