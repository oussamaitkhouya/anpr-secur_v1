"""The log-redaction filter strips secrets from messages, arguments and tracebacks."""

import logging

import pytest

from anpr.security.redaction import MASK, RedactingFilter, redact


@pytest.mark.parametrize("text, secret", [
    ('{"username": "cam", "password": "Hunter2-long"}', "Hunter2-long"),
    ("password=Hunter2-long&x=1", "Hunter2-long"),
    ("Authorization: Bearer eyJhbGciOi.payload.sig", "eyJhbGciOi.payload.sig"),
    ("cookie: access_token=abc.def.ghi; Path=/", "abc.def.ghi"),
    ("refresh_token=r3fr3sh-value", "r3fr3sh-value"),
    ("rtsp://admin:CamPass99@10.0.0.5:554/stream1", "CamPass99"),
    ("totp=123456", "123456"),
])
def test_patterns(text, secret):
    out = redact(text)
    assert secret not in out
    assert MASK in out


def test_known_secret_values_are_removed_anywhere():
    assert "s3cr3t-value-xyz" not in redact("weird place s3cr3t-value-xyz here", ("s3cr3t-value-xyz",))


def test_normal_text_is_untouched():
    text = 'GET /api/v1/cameras HTTP/1.1" 200'
    assert redact(text) == text


def test_filter_on_a_real_logger(caplog):
    logger = logging.getLogger("anpr.test_redaction")
    flt = RedactingFilter(("known-secret-123",))
    logger.addFilter(flt)
    try:
        with caplog.at_level(logging.INFO, logger="anpr.test_redaction"):
            logger.info("connecting to %s with %s", "rtsp://u:CamPass99@h/s", "known-secret-123")
            try:
                raise ValueError("password=InTraceback1")
            except ValueError:
                logger.exception("failed")
    finally:
        logger.removeFilter(flt)
    text = caplog.text
    assert "CamPass99" not in text and "known-secret-123" not in text and "InTraceback1" not in text


def test_uvicorn_access_lines_are_redacted_and_still_format():
    """uvicorn's AccessFormatter unpacks 5 args; the filter must keep them (redacted), not drop them."""
    from uvicorn.logging import AccessFormatter

    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                               ("127.0.0.1:5000", "GET", "/x?u=rtsp://admin:hunter2pass@10.0.0.5/s", "1.1", 200), None)
    assert RedactingFilter().filter(record)
    line = AccessFormatter(fmt="%(client_addr)s %(request_line)s %(status_code)s", use_colors=False).format(record)
    assert "hunter2pass" not in line and "GET" in line and "200" in line
