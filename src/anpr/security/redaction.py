"""Logging filter that removes secrets from log records before any handler writes them.

Two layers:
1. Patterns: password/secret/token fields, Authorization headers, auth cookies, and
   credentials embedded in URLs such as rtsp://user:pass@host.
2. Known values: the app registers its own secrets at startup (JWT secret, data keys, ...),
   so they are removed even if they show up somewhere no pattern expects.

The first line of defence is still not logging secrets at all; this filter is the safety net.
"""

import logging
import re

MASK = "[REDACTED]"

_PATTERNS = [
    # key=value and "key": "value" for sensitive key names
    re.compile(r"""(?i)(["']?(?:password|passwd|pwd|secret|token|api[_-]?key|totp|otp|credentials?)["']?\s*[:=]\s*)(["']?)[^"',\s&}]+\2"""),
    # Authorization: Bearer <token> / Basic <b64>
    re.compile(r"(?i)(authorization\s*[:=]\s*)(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"),
    # auth cookies
    re.compile(r"(?i)((?:access_token|refresh_token|mfa_pending)=)[^;\s]+"),
    # scheme://user:password@host
    re.compile(r"(?i)([a-z][a-z0-9+.-]*://[^/\s:@]+:)[^@\s/]+(@)"),
]


def redact(text: str, known_secrets: tuple[str, ...] = ()) -> str:
    for secret in known_secrets:
        if secret and len(secret) >= 8:  # short strings would redact normal words
            text = text.replace(secret, MASK)
    text = _PATTERNS[0].sub(lambda m: f"{m[1]}{m[2]}{MASK}{m[2]}", text)
    text = _PATTERNS[1].sub(lambda m: f"{m[1]}{m[2]} {MASK}", text)
    text = _PATTERNS[2].sub(lambda m: f"{m[1]}{MASK}", text)
    text = _PATTERNS[3].sub(lambda m: f"{m[1]}{MASK}{m[2]}", text)
    return text


class RedactingFilter(logging.Filter):
    def __init__(self, known_secrets: tuple[str, ...] = ()):
        super().__init__()
        self.known_secrets = tuple(known_secrets)

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name == "uvicorn.access" and isinstance(record.args, tuple):
            # uvicorn's access formatter unpacks exactly these 5 args (client, method, path,
            # version, status), so redact each one in place instead of flattening the message.
            record.args = tuple(redact(a, self.known_secrets) if isinstance(a, str) else a for a in record.args)
        else:
            record.msg = redact(record.getMessage(), self.known_secrets)
            record.args = None
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = redact(record.exc_text, self.known_secrets)
        return True


def install(known_secrets: tuple[str, ...] = (), logger_names: tuple[str, ...] = ("", "uvicorn", "uvicorn.access", "uvicorn.error", "anpr")) -> RedactingFilter:
    """Attach the filter to the given loggers and to every handler they already have."""
    flt = RedactingFilter(known_secrets)
    for name in logger_names:
        logger = logging.getLogger(name)
        if flt not in logger.filters:
            logger.addFilter(flt)
        for handler in logger.handlers:
            handler.addFilter(flt)
    return flt
