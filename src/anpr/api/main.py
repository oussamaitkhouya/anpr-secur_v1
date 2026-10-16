"""Production API: FastAPI + PostgreSQL. Endpoints are versioned under /api/v1.

Run (repo root, environment loaded from .env, database migrated):
    python -m uvicorn anpr.api.main:create_app --factory --port 8000

What this module adds around the routes:
- request size limits (MAX_BODY_BYTES, MAX_CSV_BYTES for imports), checked before parsing
- security headers on every response
- CORS limited to CORS_ORIGINS, and an Origin check on state-changing requests (CSRF defence
  on top of SameSite=Strict cookies)
- error responses that never contain stack traces or echoed input values
- the log-redaction filter, loaded with the app's own secrets
"""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.exceptions import HTTPException as StarletteHTTPException

from anpr.api.routes import (
    admin,
    alerts,
    audit_log,
    auth,
    cameras,
    detections,
    history,
    live,
    models_info,
    search,
    security_center,
    stream,
    watchlists,
)
from anpr.api.services.stream_relay import StreamHub
from anpr.db.engine import make_engine, make_session_factory
from anpr.security import redaction
from anpr.security.keys import EnvKeyProvider, KeyProvider
from anpr.security.ratelimit import RateLimiter
from anpr.utils.settings import Settings, get_settings

log = logging.getLogger("anpr.api")

API_PREFIX = "/api/v1"
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}
API_CSP = "default-src 'none'; frame-ancestors 'none'"
# Swagger UI loads its scripts from a CDN, so /docs gets a CSP that allows exactly that.
DOCS_CSP = ("default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "style-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: https://fastapi.tiangolo.com; "
            "connect-src 'self'; frame-ancestors 'none'")


class BodySizeLimit:
    """Pure ASGI middleware: refuse bodies over the limit, whether or not Content-Length is honest."""

    def __init__(self, app, default_limit: int, import_limit: int):
        self.app, self.default_limit, self.import_limit = app, default_limit, import_limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = self.import_limit if scope["path"].endswith(("/imports", "/import")) else self.default_limit
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            return await self._reject(scope, receive, send)

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _TooLarge()
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _TooLarge:
            await self._reject(scope, receive, send)

    @staticmethod
    async def _reject(scope, receive, send):
        await JSONResponse({"detail": "Request body too large."}, status_code=413)(scope, receive, send)


class _TooLarge(Exception):
    pass


def _warm_up(detector) -> None:
    """Load the models in a background thread so the API starts at once and the first live frame
    does not wait ~10 s. A missing model only logs: the frames endpoint then answers 503."""
    import threading

    import numpy as np

    def run():
        try:
            for _ in range(2):  # full webcam size, twice: the first call at a size pays one-time setup
                detector.detect(np.zeros((720, 1280, 3), np.uint8))
            log.info("detection models loaded: %s", detector.version)
        except Exception:  # noqa: BLE001 - startup must not fail because of the model
            log.warning("detection models could not be loaded; live frames will answer 503")

    threading.Thread(target=run, name="model-warm-up", daemon=True).start()


def create_app(settings: Settings | None = None, keys: KeyProvider | None = None, detector=None) -> FastAPI:
    settings_from_env = settings is None
    settings = settings or get_settings()
    keys = keys or EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    redaction.install((settings.jwt_secret, settings.audit_signing_key,
                       *[k.partition(":")[2] for k in settings.data_keys.split(",")]))

    docs = not settings.is_production  # no interactive docs in production; the schema is in docs/api.md
    app = FastAPI(
        title="ANPR Secure API", version="1.0.0",
        description="Stolen-vehicle plate monitoring. Every alert is decided by a human.",
        docs_url="/docs" if docs else None, redoc_url=None, openapi_url="/openapi.json" if docs else None,
    )
    engine = make_engine(settings.database_url)
    app.state.settings = settings
    app.state.keys = keys
    app.state.engine = engine
    app.state.session_factory = make_session_factory(engine)
    app.state.limiter = RateLimiter()
    app.state.streams = StreamHub()  # network-camera video relays, one per camera being watched
    if detector is None:  # YOLO + CRNN (tests pass a fake)
        from anpr.pipeline.live import FrameDetector
        detector = FrameDetector()
        if settings_from_env:  # the real server (uvicorn --factory); tests build apps with explicit settings
            _warm_up(detector)
    app.state.detector = detector

    @app.middleware("http")
    async def origin_check_and_headers(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method in UNSAFE_METHODS and origin and origin not in settings.cors_origins:
            response = JSONResponse({"detail": "Origin not allowed."}, status_code=403)
        else:
            response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        response.headers["Content-Security-Policy"] = DOCS_CSP if request.url.path == "/docs" else API_CSP
        return response

    app.add_middleware(
        CORSMiddleware, allow_origins=list(settings.cors_origins), allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Content-Type"],
    )
    app.add_middleware(BodySizeLimit, default_limit=settings.max_body_bytes,
                       import_limit=settings.max_csv_bytes + 64_000)  # room for the multipart framing

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        # FastAPI's default echoes the submitted values ("input"), which may be a password.
        errors = [{"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")}
                  for e in exc.errors()]
        return JSONResponse({"detail": errors}, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "Internal server error."}, status_code=500)

    @app.get("/health", tags=["ops"], summary="Liveness: the process is up")
    def health():
        return {"status": "ok"}

    @app.get("/ready", tags=["ops"], summary="Readiness: the database answers")
    def ready():
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception:
            log.warning("readiness check: database unreachable")
            return JSONResponse({"status": "unavailable"}, status_code=503)
        return {"status": "ready"}

    for module in (auth, admin, cameras, alerts, detections, history, search, live, stream, audit_log, security_center, models_info, watchlists):
        app.include_router(module.router, prefix=API_PREFIX)
    return app
