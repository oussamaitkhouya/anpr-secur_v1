"""Units that need no database: masking, TOTP, rate limiter, JWT handling, RBAC map."""

import time
from datetime import UTC, datetime, timedelta

import jwt
import pyotp
import pytest

from anpr.security import mfa, rbac
from anpr.security.masking import mask_plate
from anpr.security.ratelimit import RateLimiter
from anpr.security.tokens import ISSUER, TokenError, create_jwt, decode_jwt

SECRET = "x" * 48


@pytest.mark.parametrize("canonical, raw, expected", [
    ("12345|ب|6", "", "***45|ب|6"),
    ("123|ب|6", "", "*23|ب|6"),
    ("7|ب|16", "", "*|ب|16"),
    (None, "AB1234", "****34"),
    (None, "A", "*"),
])
def test_mask_plate(canonical, raw, expected):
    assert mask_plate(canonical, raw) == expected


def test_totp_accepts_current_code_once():
    secret = mfa.new_secret()
    now = time.time()
    code = pyotp.TOTP(secret).at(now)
    step = mfa.verify(secret, code, None, now)
    assert step is not None
    assert mfa.verify(secret, code, step, now) is None  # replay refused


def test_totp_allows_one_step_of_drift_only():
    secret = mfa.new_secret()
    now = time.time()
    totp = pyotp.TOTP(secret)
    assert mfa.verify(secret, totp.at(now - 30), None, now) is not None
    assert mfa.verify(secret, totp.at(now - 90), None, now) is None


@pytest.mark.parametrize("code", ["", "12345", "1234567", "abcdef", "000000"])
def test_totp_rejects_malformed_or_wrong(code):
    secret = mfa.new_secret()
    if code == "000000" and pyotp.TOTP(secret).now() == "000000":
        pytest.skip("1 in a million")
    assert mfa.verify(secret, code, None) is None


def test_provisioning_uri():
    assert mfa.provisioning_uri("JBSWY3DPEHPK3PXP", "alice").startswith("otpauth://totp/ANPR%20Secure:alice")


def test_rate_limiter_window():
    clock = [1000.0]
    limiter = RateLimiter(60, clock=lambda: clock[0])
    assert all(limiter.hit("login", "1.2.3.4", 3) is None for _ in range(3))
    wait = limiter.hit("login", "1.2.3.4", 3)
    assert wait is not None and 1 <= wait <= 60
    assert limiter.hit("login", "5.6.7.8", 3) is None  # other IPs unaffected
    assert limiter.hit("mfa", "1.2.3.4", 3) is None    # other buckets unaffected
    clock[0] += 60
    assert limiter.hit("login", "1.2.3.4", 3) is None   # next window


def test_jwt_round_trip_and_type_check():
    token = create_jwt(SECRET, "user-1", "access", 15)
    assert decode_jwt(SECRET, token, "access") == "user-1"
    with pytest.raises(TokenError):
        decode_jwt(SECRET, token, "mfa")  # an access token is not an MFA token, and vice versa


@pytest.mark.parametrize("make_token", [
    lambda: create_jwt("y" * 48, "u", "access", 15),                                    # wrong key
    lambda: jwt.encode({"sub": "u", "typ": "access", "iss": ISSUER, "iat": datetime.now(UTC),
                        "exp": datetime.now(UTC) - timedelta(seconds=1)}, SECRET, algorithm="HS256"),  # expired
    lambda: jwt.encode({"sub": "u", "typ": "access", "iss": ISSUER, "iat": datetime.now(UTC),
                        "exp": datetime.now(UTC) + timedelta(minutes=5)}, None, algorithm="none"),    # alg none
    lambda: jwt.encode({"sub": "u", "typ": "access"}, SECRET, algorithm="HS256"),          # missing claims
    lambda: "not-a-jwt",
])
def test_bad_jwts_are_rejected(make_token):
    with pytest.raises(TokenError):
        decode_jwt(SECRET, make_token(), "access")


def test_rbac_map_is_closed_and_separates_duties():
    assert set(rbac.PERMISSIONS) == {"super_admin", "admin", "analyst", "auditor"}
    assert not rbac.allowed("admin", "alerts.review")
    assert not rbac.allowed("admin", "plates.reveal")
    assert not rbac.allowed("auditor", "plates.reveal")
    assert not rbac.allowed("analyst", "audit.read")
    assert not rbac.allowed("nobody", "cities.read")
    assert rbac.allowed("analyst", "alerts.review")
