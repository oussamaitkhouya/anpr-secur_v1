"""Strict input validation for the camera registry (no database needed)."""

import uuid

import pytest
from pydantic import ValidationError

from anpr.api.schemas import (
    CameraCredentialsIn,
    CameraIn,
    CameraOut,
    CameraPatch,
    ConnectionTestIn,
)

CITY = uuid.uuid4()


def camera(**over):
    base = {"cityId": str(CITY), "name": "Agdal gate 1", "kind": "anpr_camera", "latitude": 34.0, "longitude": -6.85,
            "protocol": "rtsps", "host": "10.20.0.11", "port": 322, "streamPath": "/stream1"}
    base.update(over)
    return CameraIn.model_validate(base)


def test_valid_camera():
    c = camera(viewDirectionDeg=0, vlan=4094, host="CAM-01.Rabat.local.")
    assert c.host == "cam-01.rabat.local" and c.status == "unknown"


@pytest.mark.parametrize("field, value", [
    ("latitude", 90.0001), ("latitude", -90.5), ("longitude", 180.01), ("longitude", -181),
    ("port", 0), ("port", 65536), ("viewDirectionDeg", 360), ("viewDirectionDeg", -1),
    ("vlan", 0), ("vlan", 4095), ("protocol", "http"), ("kind", "drone"), ("status", "broken"),
])
def test_out_of_range_or_unknown_values(field, value):
    with pytest.raises(ValidationError):
        camera(**{field: value})


@pytest.mark.parametrize("host", [
    "rtsp://10.0.0.5", "admin:secret@10.0.0.5", "user@cam.local", "10.0.0.5:554", "cam.local/stream",
    "cam local", "-cam.local", "cam-.local", "a" * 64 + ".local", "999.1.1.1", "10.0.0.256", "", "cam..local",
])
def test_host_rejects_schemes_credentials_ports_paths_and_bad_names(host):
    with pytest.raises(ValidationError):
        camera(host=host)


@pytest.mark.parametrize("host, expected", [
    ("192.168.1.64", "192.168.1.64"), ("2001:db8::1", "2001:db8::1"), ("[2001:DB8::1]", "2001:db8::1"),
    ("camera-01", "camera-01"),
])
def test_host_accepts_ips_and_hostnames(host, expected):
    assert camera(host=host).host == expected


@pytest.mark.parametrize("path", [
    "rtsp://cam/stream", "/user:pw@stream", "stream1", "/live?user=admin", "/live?password=x",
    "/live?a=1&pwd=x", "/live?token=abc", "/live stream", "/live\x00",
])
def test_stream_path_never_carries_credentials_or_a_scheme(path):
    with pytest.raises(ValidationError):
        camera(streamPath=path)


def test_stream_path_may_have_harmless_query():
    assert camera(streamPath="/cam/realmonitor?channel=1&subtype=0").stream_path == "/cam/realmonitor?channel=1&subtype=0"


def test_unknown_fields_are_refused_including_credentials_on_the_camera_body():
    with pytest.raises(ValidationError):
        camera(password="secret")
    with pytest.raises(ValidationError):
        camera(credentialsEncrypted="x")


def test_tls_expiry_is_not_client_settable():
    """tls_not_after is captured by test-connection, never typed in."""
    with pytest.raises(ValidationError):
        camera(tlsNotAfter="2030-01-01T00:00:00Z")


def test_patch_validates_the_same_way():
    with pytest.raises(ValidationError):
        CameraPatch.model_validate({"host": "rtsp://x"})
    assert CameraPatch.model_validate({"status": "maintenance"}).status == "maintenance"


def test_notes_are_capped():
    with pytest.raises(ValidationError):
        camera(notes="x" * 2001)


def test_credentials_body_limits():
    with pytest.raises(ValidationError):
        CameraCredentialsIn.model_validate({"username": "", "password": "x"})
    with pytest.raises(ValidationError):
        CameraCredentialsIn.model_validate({"username": "a", "password": "x" * 257})


def test_draft_connection_test_validates_host():
    with pytest.raises(ValidationError):
        ConnectionTestIn.model_validate({"protocol": "rtsp", "host": "admin:x@10.0.0.5"})


def test_no_response_model_has_a_credentials_field():
    fields = set(CameraOut.model_fields)
    assert "credentials_set" in fields
    assert not {f for f in fields if f != "credentials_set" and ("credential" in f or "password" in f)}
