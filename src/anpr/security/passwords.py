"""Password hashing (Argon2id) and the password policy.

Plaintext passwords exist only for the duration of a request: they are never stored, logged,
returned or put in an exception message.
"""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

MIN_LENGTH = 12
MAX_LENGTH = 256
# A few passwords people actually pick; the length rule already excludes most of the rest.
_COMMON = {"password1234", "123456789012", "qwertyuiopas", "administrator", "changemenow!", "letmein12345"}

_hasher = PasswordHasher()  # Argon2id with the library's current recommended parameters
_dummy_hash: str | None = None


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def burn_time(password: str) -> None:
    """Verify against a throwaway hash so an unknown username takes as long as a wrong password."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = _hasher.hash("not-a-real-password-just-for-timing")
    verify_password(_dummy_hash, password)


def policy_problems(password: str, username: str = "") -> list[str]:
    """Reasons the password is not acceptable; empty if it is."""
    problems = []
    if len(password) < MIN_LENGTH:
        problems.append(f"Use at least {MIN_LENGTH} characters.")
    if len(password) > MAX_LENGTH:
        problems.append(f"Use at most {MAX_LENGTH} characters.")
    if username and username.lower() in password.lower():
        problems.append("The password must not contain the username.")
    if password and len(set(password)) < 4:
        problems.append("Use more than 3 different characters.")
    if password.lower() in _COMMON:
        problems.append("This password is too common.")
    return problems
