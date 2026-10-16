"""Where the keys come from. Code asks a KeyProvider for keys and never reads key material itself.

    EnvKeyProvider     development: keys from environment variables
    VaultKeyProvider   production stub: what a HashiCorp Vault / cloud KMS version would do

Data keys have a key_id so they can be rotated: new ciphertext uses the active key, every stored
ciphertext keeps the key_id it was written with, and old keys stay available for decryption
until re-encryption (anpr.security.crypto.reencrypt) has moved everything to the new key.

    python -m anpr.security.keys     prints fresh random values for .env
"""

import base64
import hashlib
import secrets
from typing import Protocol

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

DATA_KEY_BYTES = 32  # AES-256


class KeyConfigError(Exception):
    """A key is missing or malformed. The message never contains key material."""


class KeyProvider(Protocol):
    def active_key_id(self) -> str: ...
    def data_key(self, key_id: str) -> bytes: ...
    def audit_signing_key(self) -> Ed25519PrivateKey: ...


def parse_data_keys(spec: str) -> dict[str, bytes]:
    """Parse "k1:<base64>,k2:<base64>" into {key_id: 32 bytes}."""
    keys: dict[str, bytes] = {}
    for part in (p.strip() for p in spec.split(",") if p.strip()):
        key_id, sep, b64 = part.partition(":")
        if not sep or not key_id:
            raise KeyConfigError("APP_DATA_KEYS entries must look like key_id:base64")
        try:
            raw = base64.b64decode(b64, validate=True)
        except ValueError:
            raise KeyConfigError(f"data key {key_id!r} is not valid base64") from None
        if len(raw) != DATA_KEY_BYTES:
            raise KeyConfigError(f"data key {key_id!r} must be {DATA_KEY_BYTES} bytes")
        keys[key_id] = raw
    if not keys:
        raise KeyConfigError("APP_DATA_KEYS is empty")
    return keys


def load_signing_key(b64: str) -> Ed25519PrivateKey:
    try:
        raw = base64.b64decode(b64, validate=True)
        return Ed25519PrivateKey.from_private_bytes(raw)
    except ValueError:
        raise KeyConfigError("AUDIT_SIGNING_KEY must be base64 of a raw 32-byte Ed25519 key") from None


class EnvKeyProvider:
    def __init__(self, data_keys: str, active_key_id: str, audit_signing_key: str):
        self._keys = parse_data_keys(data_keys)
        if active_key_id not in self._keys:
            raise KeyConfigError(f"APP_ACTIVE_KEY_ID {active_key_id!r} is not in APP_DATA_KEYS")
        self._active = active_key_id
        self._signing = load_signing_key(audit_signing_key)

    def active_key_id(self) -> str:
        return self._active

    def data_key(self, key_id: str) -> bytes:
        try:
            return self._keys[key_id]
        except KeyError:
            raise KeyConfigError(f"unknown data key id {key_id!r}") from None

    def audit_signing_key(self) -> Ed25519PrivateKey:
        return self._signing


class VaultKeyProvider:
    """Production stub, not implemented yet. The intended design:

    - Data keys: envelope encryption. Vault Transit (or AWS KMS / Azure Key Vault) holds the key
      encryption key, which never leaves it. The app stores wrapped data keys and asks Vault to
      unwrap them at startup, keeping them only in memory. Rotation = new key version in Vault.
    - Audit signing: Vault Transit `sign` with an ed25519 key, so the private key is never in the
      app process. audit_signing_key() would then become a sign(bytes) call.
    - The app authenticates to Vault with a short-lived identity (Kubernetes service account or
      AppRole), never with a static token in the environment.
    """

    def __init__(self, *_args, **_kwargs):
        raise NotImplementedError("VaultKeyProvider is a documented stub; use EnvKeyProvider for now")

    def active_key_id(self) -> str:
        raise NotImplementedError

    def data_key(self, key_id: str) -> bytes:
        raise NotImplementedError

    def audit_signing_key(self) -> Ed25519PrivateKey:
        raise NotImplementedError


def public_key_b64(public_key: Ed25519PublicKey) -> str:
    return base64.b64encode(public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()


def generate_env_values() -> dict[str, str]:
    """Fresh random secrets for a .env file."""
    signing = Ed25519PrivateKey.generate().private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    detection_token = secrets.token_urlsafe(32)
    return {
        "POSTGRES_OWNER_PASSWORD": secrets.token_urlsafe(24),
        "APP_DB_PASSWORD": secrets.token_urlsafe(24),
        "JWT_SECRET": secrets.token_urlsafe(48),
        "APP_DATA_KEYS": "k1:" + base64.b64encode(secrets.token_bytes(DATA_KEY_BYTES)).decode(),
        "APP_ACTIVE_KEY_ID": "k1",
        "AUDIT_SIGNING_KEY": base64.b64encode(signing).decode(),
        "DETECTION_TOKEN": detection_token,  # give this to the detection service; do NOT put it in .env
        "DETECTION_TOKEN_SHA256": hashlib.sha256(detection_token.encode()).hexdigest(),
    }


if __name__ == "__main__":
    for name, value in generate_env_values().items():
        print(f"{name}={value}")
