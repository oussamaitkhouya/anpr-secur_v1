"""AES-GCM field encryption, key rotation, key parsing and settings checks."""

import base64
import os

import pytest

from anpr.security import crypto
from anpr.security.keys import (
    EnvKeyProvider,
    KeyConfigError,
    VaultKeyProvider,
    generate_env_values,
    parse_data_keys,
)
from anpr.utils.settings import SettingsError, load_settings


def b64key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


@pytest.fixture
def signing_key() -> str:
    return generate_env_values()["AUDIT_SIGNING_KEY"]


def provider(keys: str, active: str, signing: str) -> EnvKeyProvider:
    return EnvKeyProvider(keys, active, signing)


def test_round_trip(signing_key):
    keys = provider(f"k1:{b64key()}", "k1", signing_key)
    blob, key_id = crypto.encrypt(keys, b'{"username":"cam","password":"s3cret"}', purpose="camera", row_id="r1")
    assert key_id == "k1"
    assert b"s3cret" not in blob
    assert crypto.decrypt(keys, blob, key_id, purpose="camera", row_id="r1") == b'{"username":"cam","password":"s3cret"}'


def test_same_plaintext_gives_different_ciphertext(signing_key):
    keys = provider(f"k1:{b64key()}", "k1", signing_key)
    a, _ = crypto.encrypt(keys, b"x", purpose="camera", row_id="r1")
    b, _ = crypto.encrypt(keys, b"x", purpose="camera", row_id="r1")
    assert a != b  # random nonce


@pytest.mark.parametrize("change", ["row", "purpose", "tamper"])
def test_ciphertext_is_bound_to_its_row_and_purpose(signing_key, change):
    keys = provider(f"k1:{b64key()}", "k1", signing_key)
    blob, key_id = crypto.encrypt(keys, b"secret", purpose="camera", row_id="r1")
    purpose, row_id = "camera", "r1"
    if change == "row":
        row_id = "r2"
    elif change == "purpose":
        purpose = "totp"
    else:
        blob = blob[:-1] + bytes([blob[-1] ^ 1])
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt(keys, blob, key_id, purpose=purpose, row_id=row_id)


def test_key_rotation(signing_key):
    k1, k2 = b64key(), b64key()
    old = provider(f"k1:{k1}", "k1", signing_key)
    blob, key_id = crypto.encrypt(old, b"secret", purpose="camera", row_id="r1")

    rotated = provider(f"k1:{k1},k2:{k2}", "k2", signing_key)  # k2 active, k1 kept for old data
    assert crypto.decrypt(rotated, blob, key_id, purpose="camera", row_id="r1") == b"secret"
    new_blob, new_id = crypto.reencrypt(rotated, blob, key_id, purpose="camera", row_id="r1")
    assert new_id == "k2"

    only_new = provider(f"k2:{k2}", "k2", signing_key)  # k1 retired after re-encryption
    assert crypto.decrypt(only_new, new_blob, new_id, purpose="camera", row_id="r1") == b"secret"
    with pytest.raises(KeyConfigError):
        crypto.decrypt(only_new, blob, key_id, purpose="camera", row_id="r1")


def test_reencrypt_is_noop_for_active_key(signing_key):
    keys = provider(f"k1:{b64key()}", "k1", signing_key)
    blob, key_id = crypto.encrypt(keys, b"s", purpose="p", row_id="r")
    assert crypto.reencrypt(keys, blob, key_id, purpose="p", row_id="r") == (blob, key_id)


@pytest.mark.parametrize("spec", ["", "k1", "k1:notbase64!!", "k1:" + base64.b64encode(b"short").decode()])
def test_bad_data_keys_are_rejected_without_echoing_them(spec):
    with pytest.raises(KeyConfigError) as e:
        parse_data_keys(spec)
    assert "notbase64" not in str(e.value)


def test_active_key_must_exist(signing_key):
    with pytest.raises(KeyConfigError):
        provider(f"k1:{b64key()}", "k9", signing_key)


def test_vault_provider_is_an_honest_stub():
    with pytest.raises(NotImplementedError):
        VaultKeyProvider()


def env(**over) -> dict:
    values = generate_env_values()
    base = {
        "APP_ENV": "development",
        "DATABASE_URL": "postgresql+psycopg://u:p@localhost/db",
        "JWT_SECRET": values["JWT_SECRET"],
        "APP_DATA_KEYS": values["APP_DATA_KEYS"],
        "APP_ACTIVE_KEY_ID": "k1",
        "AUDIT_SIGNING_KEY": values["AUDIT_SIGNING_KEY"],
        "DETECTION_TOKEN_SHA256": values["DETECTION_TOKEN_SHA256"],
    }
    return {**base, **over}


def test_settings_load_and_hide_secrets_from_repr():
    s = load_settings(env())
    assert s.app_env == "development"
    assert s.jwt_secret not in repr(s)


@pytest.mark.parametrize("over", [
    {"APP_ENV": "staging"},
    {"JWT_SECRET": "short"},
    {"DATABASE_URL": ""},
    {"DETECTION_TOKEN_SHA256": "abc"},
])
def test_bad_settings_fail_fast(over):
    with pytest.raises(SettingsError):
        load_settings(env(**over))


def test_production_refuses_placeholders():
    with pytest.raises(SettingsError):
        load_settings(env(APP_ENV="production", JWT_SECRET="change-me-at-least-32-characters-long"))
    with pytest.raises(SettingsError):
        load_settings(env(APP_ENV="production", CORS_ORIGINS="*"))
    assert load_settings(env(APP_ENV="production", CORS_ORIGINS="https://anpr.example.ma")).is_production
