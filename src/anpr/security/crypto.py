"""Field encryption with AES-256-GCM (camera credentials, TOTP secrets).

Stored blob = 12-byte random nonce || ciphertext+tag, plus the key_id in its own column.

The associated data (authenticated but not encrypted) is "<purpose>|<row id>|<key_id>". So a
ciphertext copied into another row, another column or labelled with another key fails to decrypt:
an attacker with write access to the table cannot swap one camera's credentials into another.
"""

import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from anpr.security.keys import KeyProvider

NONCE_BYTES = 12


class DecryptionError(Exception):
    """Wrong key, wrong row, or tampered data. Deliberately says nothing more."""


def _aad(purpose: str, row_id: str, key_id: str) -> bytes:
    return f"{purpose}|{row_id}|{key_id}".encode()


def encrypt(keys: KeyProvider, plaintext: bytes, *, purpose: str, row_id: str) -> tuple[bytes, str]:
    """Encrypt with the active key. Returns (blob, key_id); store both."""
    key_id = keys.active_key_id()
    nonce = os.urandom(NONCE_BYTES)  # random 96-bit nonce: safe for far more messages than we will write
    ct = AESGCM(keys.data_key(key_id)).encrypt(nonce, plaintext, _aad(purpose, row_id, key_id))
    return nonce + ct, key_id


def decrypt(keys: KeyProvider, blob: bytes, key_id: str, *, purpose: str, row_id: str) -> bytes:
    if len(blob) <= NONCE_BYTES:
        raise DecryptionError("ciphertext too short")
    try:
        return AESGCM(keys.data_key(key_id)).decrypt(blob[:NONCE_BYTES], blob[NONCE_BYTES:],
                                                    _aad(purpose, row_id, key_id))
    except InvalidTag:
        raise DecryptionError("decryption failed") from None


def reencrypt(keys: KeyProvider, blob: bytes, key_id: str, *, purpose: str, row_id: str) -> tuple[bytes, str]:
    """Key rotation: decrypt with the old key, encrypt with the active one. No-op if already current."""
    if key_id == keys.active_key_id():
        return blob, key_id
    return encrypt(keys, decrypt(keys, blob, key_id, purpose=purpose, row_id=row_id), purpose=purpose, row_id=row_id)
