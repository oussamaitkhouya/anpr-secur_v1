"""FastAPI service behind the dashboard, on the local SQLite DB: login, sessions and user
management here, and the operational data (cameras, watchlists, reads, alerts, evidence, live
camera frames) in anpr.api.operations.

Run (from the repo root, PowerShell):
    $env:PYTHONPATH = "src"
    python scripts/init_db.py --city rabat:Rabat --watchlist "Stolen vehicles"   # once
    python -m anpr.db.create_super_admin --username <you>                         # once
    python -m uvicorn anpr.api.app:create_app --factory --port 8000

Authentication is a Bearer token from POST /auth/login. CORS allows only the dashboard origin
(ANPR_CORS_ORIGINS, default http://localhost:5173).
"""

import json
import os
import sqlite3

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass
from collections.abc import Iterator
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from anpr.api import operations
from anpr.db import users
from anpr.db.database import connect
from anpr.pipeline.live import FrameDetector
from anpr.security import audit
from anpr.security.login import login as password_login
from anpr.security.sessions import resolve, revoke

ADMIN_ROLES = ("super_admin", "admin")


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class LoginIn(Model):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class UserCreateIn(Model):
    username: str = Field(max_length=32)
    name: str = Field(max_length=60)
    role: str
    password: str = Field(max_length=256)
    allowed_city_ids: list[str] = Field(default_factory=list, max_length=50)


class UserUpdateIn(Model):
    name: str | None = Field(default=None, max_length=60)
    role: str | None = None
    allowed_city_ids: list[str] | None = Field(default=None, max_length=50)
    active: bool | None = None


class PasswordIn(Model):
    password: str = Field(max_length=256)


def create_app(db_file: Path | str | None = None, detector: FrameDetector | None = None) -> FastAPI:
    app = FastAPI(title="ANPR Secure API", docs_url="/docs", redoc_url=None)
    origins = [o.strip() for o in os.environ.get("ANPR_CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"], allow_credentials=False,
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"  # nothing here should sit in a cache
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    connect(db_file).close()  # create the schema at startup

    def get_conn() -> Iterator[sqlite3.Connection]:
        conn = connect(db_file)
        try:
            yield conn
        finally:
            conn.close()

    def client_ip(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    def bearer(authorization: str | None) -> str:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Sign in first.")
        return authorization[7:].strip()

    Conn = Annotated[sqlite3.Connection, Depends(get_conn)]
    AuthHeader = Annotated[str | None, Header()]

    def current_actor(request: Request, conn: Conn, authorization: AuthHeader = None) -> users.Actor:
        row = resolve(conn, bearer(authorization))
        if row is None:
            raise HTTPException(401, "Your session has expired. Sign in again.")
        return users.Actor(id=row["id"], username=row["username"], role=row["role"], ip=client_ip(request),
                           allowed_city_ids=tuple(json.loads(row["allowed_city_ids"])))

    CurrentActor = Annotated[users.Actor, Depends(current_actor)]

    def admin_actor(actor: CurrentActor) -> users.Actor:
        if actor.role not in ADMIN_ROLES:
            raise HTTPException(403, "Your role cannot manage accounts.")
        return actor

    AdminActor = Annotated[users.Actor, Depends(admin_actor)]

    def run(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except users.UserError as e:
            raise HTTPException(e.status, str(e)) from None

    # ---- auth ----------------------------------------------------------------------

    @app.post("/auth/login")
    def login(body: LoginIn, request: Request, conn: Conn):
        result = password_login(conn, body.username, body.password, client_ip(request))
        if result is None:
            raise HTTPException(401, "Invalid username or password, or the account is locked.")
        token, expires_at, row = result
        return {"token": token, "expiresAt": expires_at, "user": users.public_user(row)}

    @app.post("/auth/logout", status_code=204)
    def logout(actor: CurrentActor, conn: Conn, authorization: AuthHeader = None):
        revoke(conn, bearer(authorization))
        audit.append(conn, actor=actor.username, role=actor.role, action="auth.logout", target="session", ip=actor.ip)
        return Response(status_code=204)

    @app.get("/auth/me")
    def me(actor: CurrentActor, conn: Conn):
        row = conn.execute("SELECT * FROM users WHERE id = ?", (actor.id,)).fetchone()
        return users.public_user(row)

    @app.post("/auth/password", status_code=204)
    def change_own_password(body: PasswordIn, actor: CurrentActor, conn: Conn):
        run(users.reset_password, conn, actor, actor.id, body.password)
        return Response(status_code=204)

    # ---- users (admins only) -------------------------------------------------------

    @app.get("/users")
    def list_users(actor: AdminActor, conn: Conn):
        return users.list_users(conn, actor)

    @app.post("/users", status_code=201)
    def create_user(body: UserCreateIn, actor: AdminActor, conn: Conn):
        return run(users.create_user, conn, actor, username=body.username, name=body.name, role=body.role,
                   password=body.password, allowed_city_ids=body.allowed_city_ids)

    @app.patch("/users/{user_id}")
    def update_user(user_id: str, body: UserUpdateIn, actor: AdminActor, conn: Conn):
        return run(users.update_user, conn, actor, user_id, name=body.name, role=body.role,
                   allowed_city_ids=body.allowed_city_ids, active=body.active)

    @app.put("/users/{user_id}/password", status_code=204)
    def reset_password(user_id: str, body: PasswordIn, actor: AdminActor, conn: Conn):
        run(users.reset_password, conn, actor, user_id, body.password)
        return Response(status_code=204)

    @app.delete("/users/{user_id}", status_code=204)
    def delete_user(user_id: str, actor: AdminActor, conn: Conn):
        run(users.delete_user, conn, actor, user_id)
        return Response(status_code=204)

    # ---- audit integrity -----------------------------------------------------------

    @app.get("/audit/verify")
    def verify_audit(actor: CurrentActor, conn: Conn):
        if actor.role not in (*ADMIN_ROLES, "auditor"):
            raise HTTPException(403, "Your role cannot verify the audit log.")
        ok, first_bad = audit.verify(conn)
        count = conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
        return {"ok": ok, "entries": count, "firstBadSeq": first_bad}

    @app.get("/health")
    def health():
        return {"status": "ok"}

    app.include_router(operations.build_router(get_conn, current_actor, detector or FrameDetector()))
    return app
