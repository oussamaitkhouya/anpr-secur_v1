"""TOTP second factor (RFC 6238: 30-second steps, 6 digits, SHA-1, as authenticator apps expect).

A code is accepted for the current step and one step either side (clock drift), and only if
its step is newer than the last accepted one, so a code seen over someone's shoulder cannot be
replayed in the same minute. Codes are compared in constant time.
"""

import hmac
import time

import pyotp

ISSUER = "ANPR Secure"
STEP_SECONDS = 30
DRIFT_STEPS = 1


def new_secret() -> str:
    return pyotp.random_base32()  # 160 bits


def provisioning_uri(secret: str, username: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=ISSUER)


def verify(secret: str, code: str, last_step: int | None, now: float | None = None) -> int | None:
    """Return the matched step (store it as last_step), or None if the code is wrong or replayed."""
    if not (code.isdigit() and len(code) == 6):
        return None
    totp = pyotp.TOTP(secret)
    current = int((time.time() if now is None else now) // STEP_SECONDS)
    matched = None
    for step in range(current - DRIFT_STEPS, current + DRIFT_STEPS + 1):
        # no early exit: every candidate is computed and compared, whatever matches
        if hmac.compare_digest(totp.generate_otp(step), code) and matched is None:
            matched = step
    if matched is None or (last_step is not None and matched <= last_step):
        return None
    return matched
