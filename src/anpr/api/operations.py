"""Operational routes of the accounts API: overview, alerts, plate search, evidence, audit, cameras,
watchlists and live-camera frames. The contract is dashboard/src/api/http.ts and types.ts.

Every route:
- checks the role permission (anpr.security.permissions, same map as the dashboard) -> 403
- applies city scoping: analysts only see cameras, reads and alerts of their allowed cities.
  Anything outside the caller's scope answers 404, so its existence is not confirmed.
- writes a hash-chained audit entry for every sensitive action, in the same transaction

Watchlist matches only ever create PENDING alerts. A person approves, rejects or escalates them.
"""

import base64
import hashlib
import json
import os
import socket
import sqlite3
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit
from urllib.request import url2pathname

from cryptography.exceptions import InvalidSignature
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from anpr.db.database import now_iso, transaction
from anpr.db.users import Actor
from anpr.pipeline import matcher, watchlist_csv
from anpr.pipeline.live import FrameDetector, FrameError, decode_jpeg
from anpr.pipeline.validator import normalize
from anpr.security import audit, crypto, evidence
from anpr.security.audit import GENESIS, link_hash
from anpr.security.keys import EnvKeyProvider, KeyConfigError
from anpr.security.masking import mask_fixed
from anpr.security.permissions import can

MIN_JUSTIFICATION = 15        # alert reviews (dashboard/src/lib/review.ts)
MIN_REASON = 10               # plate reveals and watchlist status changes
MIN_PLATE_QUERY = 3           # shorter partial searches would let someone enumerate plates
MAX_SEARCH_RESULTS = 500
MAX_AUDIT_RESULTS = 2000
MAX_FRAME_BYTES = 2_000_000
ONLINE_WINDOW = timedelta(seconds=60)   # a webcam is online if a frame arrived this recently
READ_DEDUP = timedelta(seconds=10)      # the same plate on the same camera is one read
ALERT_DEDUP = timedelta(seconds=60)     # ...and joins the open alert within this window
CONNECT_TIMEOUT_S = 3.0


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class ReviewIn(Model):
    action: str
    justification: str = Field(max_length=2000)


class ReasonIn(Model):
    reason: str = Field(max_length=500)


class VerificationIn(Model):
    checked: int = Field(ge=0)
    broken: int = Field(ge=0)


class ExportIn(Model):
    rows: int = Field(ge=0)


class CameraIn(Model):
    id: str | None = Field(default=None, max_length=40)
    city_id: str = Field(max_length=40)
    name: str = Field(max_length=200)
    source_type: str
    endpoint: str = Field(default="", max_length=300)


class CredentialsIn(Model):
    username: str = Field(max_length=200)
    password: str = Field(max_length=256)


class CameraEventIn(Model):
    kind: str
    detail: str = Field(default="", max_length=200)


class ImportIn(Model):
    list_id: str = Field(max_length=40)
    file_name: str = Field(max_length=300)
    csv_text: str = Field(max_length=watchlist_csv.MAX_BYTES)


class EntryIn(Model):
    plate: str = Field(max_length=40)
    reason: str
    color: str | None = Field(default=None, max_length=30)
    make: str | None = Field(default=None, max_length=40)
    model: str | None = Field(default=None, max_length=40)
    vehicle_type: str | None = Field(default=None, max_length=30)
    case_ref: str = Field(default="", max_length=40)
    source: str = Field(default="", max_length=60)
    expires_at: str | None = Field(default=None, max_length=40)


class StatusIn(Model):
    status: str
    reason: str = Field(max_length=500)


@dataclass
class LiveSession:
    """Detections for the last frame of one browser-camera session. Memory only; frames are not kept."""
    user_id: str
    camera_id: str
    seq: int
    detections: list[dict]


# ---- small helpers ---------------------------------------------------------------------

def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, "Dates must be ISO-8601.") from None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def need(actor: Actor, permission: str, what: str) -> None:
    if not can(actor.role, permission):
        raise HTTPException(403, f"Your role cannot {what}.")


def visible_city_ids(conn: sqlite3.Connection, actor: Actor) -> set[str]:
    ids = {r["id"] for r in conn.execute("SELECT id FROM cities")}
    return ids & set(actor.allowed_city_ids) if actor.role == "analyst" else ids


def visible_camera_ids(conn: sqlite3.Connection, actor: Actor) -> set[str]:
    cities = visible_city_ids(conn, actor)
    return {r["id"] for r in conn.execute("SELECT id, city_id FROM cameras") if r["city_id"] in cities}


def _in(ids: set[str]) -> tuple[str, list[str]]:
    """'(?,?,?)' and its values, for an SQL IN over a scoped id set ('(NULL)' when empty)."""
    return ("(" + ",".join("?" * len(ids)) + ")" if ids else "(NULL)"), sorted(ids)


def audit_id(seq: int) -> str:
    return f"au-{seq}"


def _audit(conn: sqlite3.Connection, actor: Actor, action: str, target: str, detail: str | None = None) -> dict:
    """Append an audit entry and return it in the dashboard's AuditEntry shape."""
    entry = audit.append(conn, actor=actor.username, role=actor.role, action=action, target=target, detail=detail, ip=actor.ip)
    seq = conn.execute("SELECT seq FROM audit_log WHERE hash = ?", (entry["hash"],)).fetchone()["seq"]
    return _audit_out({**entry, "seq": seq})


def _audit_out(row) -> dict:
    return {"id": audit_id(row["seq"]), "seq": row["seq"], "at": row["at"], "actor": row["actor"], "role": row["role"],
            "action": row["action"], "target": row["target"], "justification": row["detail"], "ip": row["ip"],
            "prevHash": row["prev_hash"], "hash": row["hash"]}


def _entry_out(row, now: datetime) -> dict:
    status = row["status"]
    if status == "active" and row["expires_at"] and _parse(row["expires_at"]) <= now:
        status = "expired"
    return {"id": row["id"], "listId": row["list_id"], "plate": row["plate"], "reason": row["reason"],
            "caseRef": row["case_ref"], "source": row["source"], "addedAt": row["added_at"],
            "expiresAt": row["expires_at"], "status": status, "importId": row["import_id"] or ""}


def _active_entries(conn: sqlite3.Connection, now: datetime) -> list[sqlite3.Row]:
    rows = conn.execute("SELECT * FROM watchlist_entries WHERE status = 'active'").fetchall()
    return [r for r in rows if not r["expires_at"] or _parse(r["expires_at"]) > now]


def _camera_out(conn: sqlite3.Connection, row, now: datetime) -> dict:
    day = _iso(now.replace(hour=0, minute=0, second=0, microsecond=0))
    stats = conn.execute("SELECT COUNT(*) AS n, AVG(latency_ms) AS lat FROM plate_reads WHERE camera_id = ? AND captured_at >= ?",
                         (row["id"], day)).fetchone()
    last = _parse(row["last_frame_at"])
    online = row["source_type"] == "browser-webcam" and row["streaming"] and last is not None and now - last < ONLINE_WINDOW
    return {
        "id": row["id"], "cityId": row["city_id"], "cityName": row["city_name"], "name": row["name"],
        "sourceType": row["source_type"], "endpoint": row["endpoint"],
        # Only the browser webcam streams into this API so far; RTSP/file cameras have no ingest yet.
        "status": "online" if online else "offline",
        "credentialsSet": row["credentials_encrypted"] is not None,
        "lastFrameAt": row["last_frame_at"],
        "tlsStatus": "unknown" if row["source_type"] == "rtsp" else "not_applicable",  # no certificate check yet
        "uptimePct": 0,  # not measured
        "latencyMs": round(stats["lat"] or 0),
        "readsToday": stats["n"],
    }


CAMERA_SELECT = "SELECT c.*, ci.name AS city_name FROM cameras c JOIN cities ci ON ci.id = c.city_id"

ALERT_SELECT = """
SELECT a.*, r.plate, r.confidence, r.chars, r.camera_id, r.captured_at, r.evidence_id,
       c.name AS camera_name, c.city_id, ci.name AS city_name,
       e.id AS e_id, e.list_id AS e_list_id, e.plate AS e_plate, e.reason AS e_reason, e.case_ref AS e_case_ref,
       e.source AS e_source, e.added_at AS e_added_at, e.expires_at AS e_expires_at, e.status AS e_status,
       e.import_id AS e_import_id
FROM alerts a
JOIN plate_reads r ON r.id = a.read_id
JOIN cameras c ON c.id = r.camera_id
JOIN cities ci ON ci.id = c.city_id
JOIN watchlist_entries e ON e.id = a.entry_id
"""

REVIEW_STATUS = {"approve": "approved", "reject": "rejected", "escalate": "escalated"}


def _alert_out(row, now: datetime) -> dict:
    entry = {k[2:]: row[k] for k in row.keys() if k.startswith("e_")}  # noqa: SIM118 (sqlite3.Row iterates values)
    decision = None
    if row["status"] != "pending":
        action = next(a for a, s in REVIEW_STATUS.items() if s == row["status"])
        decision = {"action": action, "justification": row["justification"], "reviewer": row["reviewer"],
                    "decidedAt": row["decided_at"], "auditId": audit_id(row["audit_seq"])}
    return {
        "id": row["id"], "readId": row["read_id"], "plate": row["plate"], "plateType": None,
        "confidence": row["confidence"], "chars": json.loads(row["chars"]),
        "cameraId": row["camera_id"], "cameraName": row["camera_name"], "cityId": row["city_id"], "cityName": row["city_name"],
        "capturedAt": row["captured_at"], "condition": None, "matchScore": row["match_score"],
        "watchlistEntry": _entry_out(entry, now), "evidenceId": row["evidence_id"],
        "status": row["status"], "decision": decision,
    }


def verify_evidence(conn: sqlite3.Connection) -> tuple[int, int]:
    """(links checked, links broken). Same checks as the browser: hash, link, signature."""
    key = evidence.signing_key()
    public = key.public_key() if key else None
    prev, checked, broken = GENESIS, 0, 0
    for r in conn.execute("SELECT * FROM evidence ORDER BY seq"):
        ok = r["prev_hash"] == prev and link_hash(r["prev_hash"], json.loads(r["payload"])) == r["hash"]
        if ok and public and r["signature"]:
            try:
                public.verify(base64.b64decode(r["signature"]), r["hash"].encode())
            except (InvalidSignature, ValueError):
                ok = False
        checked += 1
        broken += not ok
        prev = r["hash"]
    return checked, broken


def _validate_endpoint(source_type: str, endpoint: str) -> str:
    """Endpoints never carry credentials, and must match the source type."""
    if source_type == "browser-webcam":
        if endpoint:
            raise HTTPException(422, "The browser webcam has no URL.")
        return ""
    url = urlsplit(endpoint)
    if not url.scheme or (source_type == "rtsp" and not url.hostname):
        raise HTTPException(422, "Enter a full URL.")
    if url.username or url.password or "@" in endpoint:
        raise HTTPException(422, "Never put a username or password in the URL. Use the credentials fields: "
                                 "they are stored encrypted and never shown again.")
    if source_type == "rtsp" and url.scheme != "rtsps":
        raise HTTPException(422, "Use rtsps:// (RTSP over TLS).")
    if source_type == "file" and url.scheme != "file":
        raise HTTPException(422, "File sources use a file:/// URL.")
    return endpoint


def _key_provider():
    try:
        return EnvKeyProvider(os.environ.get("APP_DATA_KEYS", ""), os.environ.get("APP_ACTIVE_KEY_ID", ""),
                              os.environ.get("AUDIT_SIGNING_KEY", ""))
    except KeyConfigError:
        raise HTTPException(503, "Credential encryption is not configured (APP_DATA_KEYS, APP_ACTIVE_KEY_ID, "
                                 "AUDIT_SIGNING_KEY).") from None


# ---- routes ----------------------------------------------------------------------------

def build_router(conn_dep: Callable, actor_dep: Callable, detector: FrameDetector) -> APIRouter:
    router = APIRouter()
    Conn = Annotated[sqlite3.Connection, Depends(conn_dep)]
    CurrentActor = Annotated[Actor, Depends(actor_dep)]
    sessions: dict[str, LiveSession] = {}

    def visible_camera(conn: sqlite3.Connection, actor: Actor, camera_id: str) -> sqlite3.Row:
        row = conn.execute(f"{CAMERA_SELECT} WHERE c.id = ?", (camera_id,)).fetchone()
        if row is None or row["id"] not in visible_camera_ids(conn, actor):
            raise HTTPException(404, f"Camera {camera_id} not found.")
        return row

    # ---- overview and notifications ------------------------------------------------

    @router.get("/metrics/overview")
    def overview(actor: CurrentActor, conn: Conn):
        need(actor, "overview:view", "view the overview")
        now = datetime.now(UTC)
        cams = visible_camera_ids(conn, actor)
        marks, ids = _in(cams)
        day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        reads = conn.execute(f"SELECT captured_at, watchlist_hit, latency_ms, camera_id FROM plate_reads "
                             f"WHERE camera_id IN {marks} AND captured_at >= ?", (*ids, _iso(day - timedelta(days=13)))).fetchall()
        cameras = [_camera_out(conn, r, now) for r in conn.execute(f"{CAMERA_SELECT} WHERE c.id IN {marks}", ids)]

        def between(start: datetime, end: datetime) -> list[sqlite3.Row]:
            a, b = _iso(start), _iso(end)
            return [r for r in reads if a <= r["captured_at"] < b]

        def avg_latency(rs) -> float:
            lat = [r["latency_ms"] for r in rs if r["latency_ms"] is not None]
            return round(sum(lat) / len(lat)) if lat else 0

        days = [between(day - timedelta(days=13 - i), day - timedelta(days=12 - i)) for i in range(14)]
        today = days[-1]
        hour = now.replace(minute=0, second=0, microsecond=0)
        checked, broken = verify_evidence(conn)
        ocr = detector.ocr_metrics() if detector.reads_plates else None
        return {
            "platesToday": len(today),
            "watchlistHits": sum(r["watchlist_hit"] for r in today),
            "avgLatencyMs": avg_latency(today),
            # validation plate accuracy recorded in the OCR checkpoint; None without an OCR model
            "ocrAccuracy": ocr.get("plate_acc") if ocr else None,
            "activeCameras": sum(c["status"] == "online" for c in cameras),
            "totalCameras": len(cameras),
            "integrity": {"status": "verified" if broken == 0 else "tamper_detected", "checkedLinks": checked, "brokenLinks": broken},
            "sparklines": {
                "platesToday": [len(d) for d in days],
                "watchlistHits": [sum(r["watchlist_hit"] for r in d) for d in days],
                "avgLatencyMs": [avg_latency(d) for d in days],
                "ocrAccuracy": [],  # live reads have no ground truth, so there is no daily accuracy
                "activeCameras": [len({r["camera_id"] for r in d}) for d in days],
            },
            "hourly": [
                {"hour": _iso(h), "reads": len(rs), "hits": sum(r["watchlist_hit"] for r in rs)}
                for h in (hour - timedelta(hours=23 - i) for i in range(24))
                for rs in [between(h, h + timedelta(hours=1))]
            ],
            "byPlateType": [],  # the pipeline does not classify plate types yet
        }

    @router.get("/notifications")
    def notifications(actor: CurrentActor, conn: Conn):
        need(actor, "overview:view", "view notifications")
        if not can(actor.role, "alerts:view"):
            return []
        marks, ids = _in(visible_camera_ids(conn, actor))
        rows = conn.execute(f"{ALERT_SELECT} WHERE a.status = 'pending' AND r.camera_id IN {marks} ORDER BY r.captured_at DESC LIMIT 50", ids)
        severity = {"stolen": "critical", "wanted": "high"}
        return [{"id": f"n-{r['id']}", "at": r["captured_at"], "title": "Watchlist match awaiting review",
                 "body": f"{r['city_name']} · {r['camera_name']}", "severity": severity.get(r["e_reason"], "medium"),
                 "href": f"/alerts?id={r['id']}"} for r in rows]

    # ---- alerts --------------------------------------------------------------------

    @router.get("/alerts")
    def list_alerts(actor: CurrentActor, conn: Conn):
        need(actor, "alerts:view", "view alerts")
        now = datetime.now(UTC)
        marks, ids = _in(visible_camera_ids(conn, actor))
        rows = conn.execute(f"{ALERT_SELECT} WHERE r.camera_id IN {marks} ORDER BY r.captured_at DESC LIMIT 500", ids)
        return [_alert_out(r, now) for r in rows]

    @router.post("/alerts/{alert_id}/review")
    def review_alert(alert_id: str, body: ReviewIn, actor: CurrentActor, conn: Conn):
        need(actor, "alerts:review", "review alerts")
        if body.action not in REVIEW_STATUS:
            raise HTTPException(422, "Action must be approve, reject or escalate.")
        text = body.justification.strip()
        if len(text) < MIN_JUSTIFICATION:
            raise HTTPException(422, f"A justification of at least {MIN_JUSTIFICATION} characters is required.")
        with transaction(conn):
            row = conn.execute(f"{ALERT_SELECT} WHERE a.id = ?", (alert_id,)).fetchone()
            if row is None or row["camera_id"] not in visible_camera_ids(conn, actor):
                raise HTTPException(404, f"Alert {alert_id} not found.")
            if row["status"] != "pending":
                raise HTTPException(409, f"Alert {alert_id} was already {row['status']} by {row['reviewer']}.")
            entry = _audit(conn, actor, f"alert.{body.action}", alert_id, text)
            conn.execute("UPDATE alerts SET status = ?, reviewer = ?, decided_at = ?, justification = ?, audit_seq = ? WHERE id = ?",
                         (REVIEW_STATUS[body.action], actor.username, entry["at"], text, entry["seq"], alert_id))
        return _alert_out(conn.execute(f"{ALERT_SELECT} WHERE a.id = ?", (alert_id,)).fetchone(), datetime.now(UTC))

    # ---- plate search and reveal ---------------------------------------------------

    @router.get("/plates/search")
    def search(actor: CurrentActor, conn: Conn, request: Request):
        need(actor, "search:view", "search plates")
        q = request.query_params
        unknown = set(q) - {"plate", "from", "to", "cameraId", "plateType"}
        if unknown:
            raise HTTPException(422, f"Unknown filter: {min(unknown)}.")
        text = normalize(q.get("plate", ""))[:40]
        if text and len(text.replace("|", "")) < MIN_PLATE_QUERY:
            raise HTTPException(422, f"Enter at least {MIN_PLATE_QUERY} plate characters.")
        cams = visible_camera_ids(conn, actor)
        camera_id = q.get("cameraId", "")
        if camera_id:
            if camera_id not in cams:
                raise HTTPException(404, f"Camera {camera_id} not found.")
            cams = {camera_id}
        start, end = _parse(q.get("from")), _parse(q.get("to"))
        marks, ids = _in(cams)
        sql = f"SELECT r.*, c.name AS camera_name FROM plate_reads r JOIN cameras c ON c.id = r.camera_id WHERE r.camera_id IN {marks}"
        args: list = list(ids)
        if text:
            sql += " AND instr(r.plate, ?) > 0"
            args.append(text)
        if start:
            sql += " AND r.captured_at >= ?"
            args.append(_iso(start))
        if end:
            sql += " AND r.captured_at <= ?"
            args.append(_iso(end))
        if q.get("plateType"):
            sql += " AND 0"  # plate types are not classified yet, so no read has one
        rows = conn.execute(sql + " ORDER BY r.captured_at DESC LIMIT ?", (*args, MAX_SEARCH_RESULTS)).fetchall()
        described = ", ".join(f"plate~{len(v)} chars" if k == "plate" else f"{k}={v}" for k, v in q.items() if v)
        _audit(conn, actor, "plate.search", f"filters: {described or 'none'}")
        return [{"readId": r["id"], "plateMasked": mask_fixed(r["plate"]), "plateType": None, "cameraId": r["camera_id"],
                 "cameraName": r["camera_name"], "capturedAt": r["captured_at"], "confidence": r["confidence"],
                 "condition": None, "watchlistHit": bool(r["watchlist_hit"]), "evidenceId": r["evidence_id"]} for r in rows]

    @router.post("/plates/{read_id}/reveal")
    def reveal(read_id: str, body: ReasonIn, actor: CurrentActor, conn: Conn):
        need(actor, "plates:reveal", "reveal plates")
        row = conn.execute("SELECT * FROM plate_reads WHERE id = ?", (read_id,)).fetchone()
        if row is None or row["camera_id"] not in visible_camera_ids(conn, actor):
            raise HTTPException(404, f"Read {read_id} not found.")
        reason = body.reason.strip()
        if len(reason) < MIN_REASON:
            raise HTTPException(422, f"Give a reason of at least {MIN_REASON} characters.")
        if len(set(reason.replace(" ", ""))) == 1:
            raise HTTPException(422, "The reason must describe why you need the plate.")
        entry = _audit(conn, actor, "plate.reveal", read_id, reason)
        return {"readId": read_id, "plate": row["plate"], "auditId": entry["id"]}

    # ---- evidence ------------------------------------------------------------------

    def _record_out(r) -> dict:
        return {"id": r["id"], "seq": r["seq"], "payload": json.loads(r["payload"]), "prevHash": r["prev_hash"],
                "hash": r["hash"], "signature": r["signature"], "keyId": r["key_id"],
                "plateMasked": mask_fixed(r["plate"]), "cameraName": r["camera_name"]}

    EVIDENCE_SELECT = ("SELECT ev.*, r.plate, r.confidence, r.captured_at, r.camera_id, c.name AS camera_name "
                       "FROM evidence ev JOIN plate_reads r ON r.id = ev.read_id JOIN cameras c ON c.id = r.camera_id")

    @router.get("/evidence")
    def list_evidence(actor: CurrentActor, conn: Conn):
        need(actor, "evidence:view", "view evidence")
        # The whole chain is returned: the browser can only verify links it can see.
        rows = conn.execute(f"{EVIDENCE_SELECT} ORDER BY ev.seq DESC").fetchall()
        return {"records": [_record_out(r) for r in rows], "publicKey": evidence.public_key(),
                "keyId": evidence.KEY_ID, "algorithm": "Ed25519"}

    @router.get("/evidence/{evidence_id}")
    def evidence_detail(evidence_id: str, actor: CurrentActor, conn: Conn):
        need(actor, "evidence:view", "view evidence")
        r = conn.execute(f"{EVIDENCE_SELECT} WHERE ev.id = ?", (evidence_id,)).fetchone()
        if r is None:
            raise HTTPException(404, f"Evidence {evidence_id} not found.")
        payload = json.loads(r["payload"])
        custody = [
            {"at": r["captured_at"], "actor": r["camera_id"], "action": "Frame received from the browser camera (not stored)"},
            {"at": r["captured_at"], "actor": "svc.detector", "action": f"Plate read ({payload['modelVersion']})"},
            {"at": r["created_at"], "actor": "svc.evidence", "action": f"Record #{r['seq']} hashed, chained"
                                                                         f"{' and signed' if r['signature'] else ' (unsigned)'} ({r['key_id']})"},
        ]
        for a in conn.execute("SELECT * FROM alerts WHERE read_id = ? AND status != 'pending'", (r["read_id"],)):
            verb = next(k for k, v in REVIEW_STATUS.items() if v == a["status"])
            custody.append({"at": a["decided_at"], "actor": a["reviewer"], "action": f"Alert {verb}d by human reviewer"})
        return {"record": _record_out(r), "plateType": None, "condition": None, "confidence": r["confidence"], "custody": custody}

    @router.post("/evidence/verifications")
    def record_verification(body: VerificationIn, actor: CurrentActor, conn: Conn):
        need(actor, "evidence:verify", "verify the evidence chain")
        return _audit(conn, actor, "evidence.verify", "evidence chain", f"{body.checked} links checked, {body.broken} broken")

    # ---- audit ---------------------------------------------------------------------

    @router.get("/audit")
    def audit_log(actor: CurrentActor, conn: Conn, request: Request):
        need(actor, "audit:view", "view the audit log")
        p = request.query_params
        sql, args = "SELECT * FROM audit_log WHERE 1", []
        for column, key in (("action", "action"), ("actor", "actor")):
            if p.get(key):
                sql += f" AND {column} = ?"
                args.append(p[key])
        if p.get("from"):
            sql += " AND at >= ?"
            args.append(_iso(_parse(p["from"])))
        if p.get("to"):
            sql += " AND at <= ?"
            args.append(_iso(_parse(p["to"])))
        text = p.get("q", "").strip().lower()[:100]
        if text:
            sql += " AND (instr(lower(actor), ?) OR instr(lower(action), ?) OR instr(lower(target), ?)" \
                   " OR instr(lower(coalesce(detail, '')), ?) OR instr(ip, ?) OR ('au-' || seq) = ?)"
            args += [text] * 6
        rows = conn.execute(sql + " ORDER BY seq DESC LIMIT ?", (*args, MAX_AUDIT_RESULTS))
        return [_audit_out(r) for r in rows]

    @router.post("/audit/exports")
    def record_export(body: ExportIn, actor: CurrentActor, conn: Conn):
        need(actor, "audit:export", "export the audit log")
        return _audit(conn, actor, "audit.export", f"{body.rows} rows (CSV)")

    # ---- cities and cameras --------------------------------------------------------

    @router.get("/cities")
    def list_cities(actor: CurrentActor, conn: Conn):
        need(actor, "cameras:view", "view cities")
        ids = visible_city_ids(conn, actor)
        return [{"id": r["id"], "name": r["name"]} for r in conn.execute("SELECT * FROM cities ORDER BY name") if r["id"] in ids]

    @router.get("/cameras")
    def list_cameras(actor: CurrentActor, conn: Conn):
        need(actor, "cameras:view", "view cameras")
        now = datetime.now(UTC)
        ids = visible_camera_ids(conn, actor)
        return [_camera_out(conn, r, now) for r in conn.execute(f"{CAMERA_SELECT} ORDER BY ci.name, c.name") if r["id"] in ids]

    @router.get("/cameras/{camera_id}")
    def get_camera(camera_id: str, actor: CurrentActor, conn: Conn):
        need(actor, "cameras:view", "view cameras")
        return _camera_out(conn, visible_camera(conn, actor, camera_id), datetime.now(UTC))

    def save_camera(body: CameraIn, actor: Actor, conn: sqlite3.Connection, camera_id: str | None):
        need(actor, "admin:cameras", "manage cameras")
        name = " ".join(body.name.split())
        if not 2 <= len(name) <= 60:
            raise HTTPException(422, "Name must be 2 to 60 characters.")
        if body.source_type not in ("browser-webcam", "rtsp", "file"):
            raise HTTPException(422, "Unknown source type.")
        if conn.execute("SELECT 1 FROM cities WHERE id = ?", (body.city_id,)).fetchone() is None:
            raise HTTPException(422, "Unknown city.")
        endpoint = _validate_endpoint(body.source_type, body.endpoint.strip())
        now = now_iso()
        try:
            with transaction(conn):
                if camera_id is None:
                    camera_id = _new_id("cam")
                    conn.execute("INSERT INTO cameras (id, city_id, name, source_type, endpoint, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                                 (camera_id, body.city_id, name, body.source_type, endpoint, now, now))
                    _audit(conn, actor, "camera.create", camera_id, f"{name} · {body.city_id} · {body.source_type}")
                else:
                    old = conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone()
                    if old is None:
                        raise HTTPException(404, f"Camera {camera_id} not found.")
                    changes = [c for c, changed in (
                        ("name", old["name"] != name), (f"city {old['city_id']}->{body.city_id}", old["city_id"] != body.city_id),
                        (f"source {old['source_type']}->{body.source_type}", old["source_type"] != body.source_type),
                        ("endpoint", old["endpoint"] != endpoint)) if changed]
                    # a new endpoint or source makes the stored credentials meaningless
                    reset = old["endpoint"] != endpoint or old["source_type"] != body.source_type
                    conn.execute("UPDATE cameras SET city_id = ?, name = ?, source_type = ?, endpoint = ?, updated_at = ?"
                                 + (", credentials_encrypted = NULL, credentials_key_id = NULL" if reset else "") + " WHERE id = ?",
                                 (body.city_id, name, body.source_type, endpoint, now, camera_id))
                    _audit(conn, actor, "camera.update", camera_id, f"changed: {', '.join(changes)}" if changes else "no changes")
        except sqlite3.IntegrityError:
            raise HTTPException(409, "A camera with this name already exists in this city.") from None
        return _camera_out(conn, visible_camera(conn, actor, camera_id), datetime.now(UTC))

    @router.post("/cameras", status_code=201)
    def create_camera(body: CameraIn, actor: CurrentActor, conn: Conn):
        return save_camera(body, actor, conn, None)

    @router.put("/cameras/{camera_id}")
    def update_camera(camera_id: str, body: CameraIn, actor: CurrentActor, conn: Conn):
        return save_camera(body, actor, conn, camera_id)

    @router.put("/cameras/{camera_id}/credentials")
    def replace_credentials(camera_id: str, body: CredentialsIn, actor: CurrentActor, conn: Conn):
        need(actor, "admin:cameras", "manage camera credentials")
        camera = visible_camera(conn, actor, camera_id)
        if camera["source_type"] == "browser-webcam":
            raise HTTPException(422, "The browser webcam has no credentials.")
        username = body.username.strip()
        if not username or len(username) > 64 or any(c in username for c in " :@/\t"):
            raise HTTPException(422, "Username: 1 to 64 characters, no spaces, ':', '@' or '/'.")
        if not 8 <= len(body.password) <= 256:
            raise HTTPException(422, "Password: 8 to 256 characters.")
        blob, key_id = crypto.encrypt(_key_provider(), json.dumps({"username": username, "password": body.password}).encode(),
                                      purpose="camera_credentials", row_id=camera_id)
        with transaction(conn):
            conn.execute("UPDATE cameras SET credentials_encrypted = ?, credentials_key_id = ?, updated_at = ? WHERE id = ?",
                         (blob, key_id, now_iso(), camera_id))
            _audit(conn, actor, "camera.credentials_replace", camera_id, "credentials replaced (values are never logged)")
        return _camera_out(conn, visible_camera(conn, actor, camera_id), datetime.now(UTC))

    @router.post("/cameras/{camera_id}/test")
    def test_connection(camera_id: str, actor: CurrentActor, conn: Conn):
        """A real reachability check: TCP connect for RTSP, file existence for files. It does not
        authenticate or decode a stream, and says so."""
        need(actor, "admin:cameras", "test camera connections")
        camera = visible_camera(conn, actor, camera_id)
        if camera["source_type"] == "browser-webcam":
            result = {"ok": False, "latencyMs": 0, "message": "The browser webcam is tested from its live view, after you allow camera access."}
        elif camera["source_type"] == "file":
            exists = Path(url2pathname(urlsplit(camera["endpoint"]).path)).is_file()
            result = {"ok": exists, "latencyMs": 0, "message": "File found." if exists else "File not found on the API server."}
        elif camera["credentials_encrypted"] is None:
            result = {"ok": False, "latencyMs": 0, "message": "Set credentials first."}
        else:
            url = urlsplit(camera["endpoint"])
            started = time.perf_counter()
            try:
                socket.create_connection((url.hostname, url.port or 322), timeout=CONNECT_TIMEOUT_S).close()
                ms = round((time.perf_counter() - started) * 1000)
                result = {"ok": True, "latencyMs": ms, "message": f"TCP connection to {url.hostname}:{url.port or 322} OK. "
                                                                  "RTSP login and TLS were not tested."}
            except OSError:
                result = {"ok": False, "latencyMs": round(CONNECT_TIMEOUT_S * 1000),
                          "message": f"No TCP connection to {url.hostname}:{url.port or 322} within {CONNECT_TIMEOUT_S:.0f} s."}
        _audit(conn, actor, "camera.test", camera_id, "ok" if result["ok"] else result["message"])
        return result

    # ---- watchlists ----------------------------------------------------------------

    @router.get("/watchlists")
    def watchlists(actor: CurrentActor, conn: Conn):
        need(actor, "admin:watchlists", "view watchlists")
        now = datetime.now(UTC)
        return {"lists": [{"id": r["id"], "name": r["name"]} for r in conn.execute("SELECT * FROM watchlist_lists ORDER BY name")],
                "entries": [_entry_out(r, now) for r in conn.execute("SELECT * FROM watchlist_entries ORDER BY added_at DESC")]}

    def _import_out(r) -> dict:
        return {"id": r["id"], "listId": r["list_id"], "fileName": r["file_name"], "sha256": r["sha256"],
                "rowsTotal": r["rows_total"], "rowsAccepted": r["rows_accepted"], "rowsRejected": r["rows_rejected"],
                "importedBy": r["imported_by"], "importedAt": r["imported_at"], "version": r["version"]}

    @router.get("/watchlists/imports")
    def imports(actor: CurrentActor, conn: Conn):
        need(actor, "admin:watchlists", "view watchlist imports")
        return [_import_out(r) for r in conn.execute("SELECT * FROM watchlist_imports ORDER BY imported_at DESC")]

    @router.post("/watchlists/imports", status_code=201)
    def import_watchlist(body: ImportIn, actor: CurrentActor, conn: Conn):
        need(actor, "admin:watchlists", "import watchlists")
        if conn.execute("SELECT 1 FROM watchlist_lists WHERE id = ?", (body.list_id,)).fetchone() is None:
            raise HTTPException(422, "Unknown watchlist.")
        file_name = body.file_name.replace("\\", "/").split("/")[-1][:120] or "import.csv"
        now = datetime.now(UTC)
        with transaction(conn):
            active = {r["plate"] for r in _active_entries(conn, now)}
            result = watchlist_csv.validate(body.csv_text, now, active)
            if result.fatal:
                raise HTTPException(422, result.fatal)
            if result.accepted == 0:
                raise HTTPException(422, "No valid rows to import.")
            version = conn.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM watchlist_imports WHERE list_id = ?",
                                   (body.list_id,)).fetchone()[0]
            import_id, at = _new_id("imp"), now_iso()
            sha = hashlib.sha256(body.csv_text.encode()).hexdigest()
            conn.execute("INSERT INTO watchlist_imports (id, list_id, file_name, sha256, rows_total, rows_accepted, rows_rejected,"
                         " imported_by, imported_at, version) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (import_id, body.list_id, file_name, sha, len(result.rows), result.accepted, result.rejected,
                          actor.username, at, version))
            for row in result.rows:
                if row.entry:
                    e = row.entry
                    conn.execute("INSERT INTO watchlist_entries (id, list_id, import_id, plate, reason, case_ref, source, added_at, expires_at)"
                                 " VALUES (?,?,?,?,?,?,?,?,?)",
                                 (_new_id("we"), body.list_id, import_id, e["plate"], e["reason"], e["caseRef"], e["source"], at, e["expiresAt"]))
            _audit(conn, actor, "watchlist.import", f"{body.list_id} v{version}: {file_name}",
                   f"{result.accepted} accepted, {result.rejected} rejected; sha256 {sha}")
        return _import_out(conn.execute("SELECT * FROM watchlist_imports WHERE id = ?", (import_id,)).fetchone())

    @router.post("/watchlists/{list_id}/entries", status_code=201)
    def add_entry(list_id: str, body: EntryIn, actor: CurrentActor, conn: Conn):
        need(actor, "admin:watchlists", "manage watchlist entries")
        if conn.execute("SELECT 1 FROM watchlist_lists WHERE id = ?", (list_id,)).fetchone() is None:
            raise HTTPException(422, "Unknown watchlist.")
        plate = matcher.canonical_or_none(body.plate)
        if plate is None:
            raise HTTPException(422, "Plate is not number|letter|region with a known letter and region.")
        if body.reason not in watchlist_csv.REASONS:
            raise HTTPException(422, "Reason must be stolen, wanted or other.")
        if body.case_ref and not watchlist_csv.CASE_REF.match(body.case_ref.strip()):
            raise HTTPException(422, "caseRef: letters, digits and . _ - / only, at most 40 characters.")
        now = datetime.now(UTC)
        expires = _parse(body.expires_at)
        if expires and expires <= now:
            raise HTTPException(422, "The expiry date is in the past.")
        entry_id = _new_id("we")
        try:
            with transaction(conn):
                conn.execute("INSERT INTO watchlist_entries (id, list_id, plate, reason, case_ref, source, color, make, model,"
                             " vehicle_type, added_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                             (entry_id, list_id, plate, body.reason, body.case_ref.strip(), body.source.strip(), body.color,
                              body.make, body.model, body.vehicle_type, now_iso(), _iso(expires) if expires else None))
                _audit(conn, actor, "watchlist.add", list_id, f"added {mask_fixed(plate)} ({body.reason})")
        except sqlite3.IntegrityError:
            raise HTTPException(409, "This plate is already active on this watchlist.") from None
        return _entry_out(conn.execute("SELECT * FROM watchlist_entries WHERE id = ?", (entry_id,)).fetchone(), now)

    @router.post("/watchlists/entries/{entry_id}/status")
    def set_entry_status(entry_id: str, body: StatusIn, actor: CurrentActor, conn: Conn):
        need(actor, "admin:watchlists", "change watchlist entries")
        if body.status not in ("removed", "expired"):
            raise HTTPException(422, "Status must be removed or expired.")
        reason = body.reason.strip()
        if len(reason) < MIN_REASON:
            raise HTTPException(422, f"Give a reason of at least {MIN_REASON} characters.")
        now = datetime.now(UTC)
        with transaction(conn):
            row = conn.execute("SELECT * FROM watchlist_entries WHERE id = ?", (entry_id,)).fetchone()
            if row is None:
                raise HTTPException(404, f"Watchlist entry {entry_id} not found.")
            current = _entry_out(row, now)["status"]
            if current != "active":
                raise HTTPException(409, f"Entry {entry_id} is already {current}.")
            conn.execute("UPDATE watchlist_entries SET status = ?, expires_at = CASE WHEN ? = 'expired' THEN ? ELSE expires_at END WHERE id = ?",
                         (body.status, body.status, now_iso(), entry_id))
            _audit(conn, actor, "watchlist.remove" if body.status == "removed" else "watchlist.expire",
                   f"{entry_id} ({mask_fixed(row['plate'])})", reason)
        return _entry_out(conn.execute("SELECT * FROM watchlist_entries WHERE id = ?", (entry_id,)).fetchone(), now)

    # ---- models, security, settings ------------------------------------------------

    @router.get("/metrics/models")
    def model_metrics(actor: CurrentActor):
        need(actor, "models:view", "view model metrics")
        # No per-condition test run has been recorded yet; the sets stay empty rather than invented.
        empty = {"synthetic": None, "real": None}
        return {"illustrative": False,
                "detector": {"version": detector.version.split(" + ")[0], "bySet": empty},
                "ocr": {"version": detector.version.split(" + ")[1] if detector.reads_plates else "none", "bySet": empty}}

    @router.get("/security/overview")
    def security_overview(actor: CurrentActor, conn: Conn):
        need(actor, "security:view", "view the security center")
        hour = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
        start = hour - timedelta(hours=47)
        rows = conn.execute("SELECT at, action FROM audit_log WHERE at >= ? AND action IN ('auth.login_failed', 'auth.lockout')",
                            (_iso(start),)).fetchall()
        timeline = []
        for i in range(48):
            a, b = _iso(start + timedelta(hours=i)), _iso(start + timedelta(hours=i + 1))
            bucket = [r["action"] for r in rows if a <= r["at"] < b]
            timeline.append({"hour": a, "failedLogins": bucket.count("auth.login_failed"), "anomalies": bucket.count("auth.lockout")})
        # Threat model and adversarial results live in docs/ until they are measured by code.
        return {"illustrative": False, "techniques": [], "stride": [], "adversarial": [], "streamEvents": [], "authTimeline": timeline}

    @router.get("/settings/retention")
    def retention(actor: CurrentActor):
        need(actor, "settings:view", "view settings")
        raise HTTPException(501, "No retention job is configured yet, so there is no policy to show.")

    # ---- live camera ---------------------------------------------------------------

    def browser_camera(conn: sqlite3.Connection, actor: Actor, camera_id: str) -> sqlite3.Row:
        need(actor, "camera:live", "use the live camera")
        camera = visible_camera(conn, actor, camera_id)
        if camera["source_type"] != "browser-webcam":
            raise HTTPException(422, "Only the browser webcam is streamed from this page.")
        return camera

    @router.post("/cameras/{camera_id}/events")
    def camera_event(camera_id: str, body: CameraEventIn, actor: CurrentActor, conn: Conn):
        browser_camera(conn, actor, camera_id)
        if body.kind not in ("start", "stop"):
            raise HTTPException(422, "Kind must be start or stop.")
        with transaction(conn):
            conn.execute("UPDATE cameras SET streaming = ?, last_frame_at = CASE WHEN ? THEN ? ELSE last_frame_at END WHERE id = ?",
                         (int(body.kind == "start"), body.kind == "start", now_iso(), camera_id))
            return _audit(conn, actor, f"camera.{body.kind}", camera_id, body.detail.strip() or None)

    @router.post("/detections/frame")
    def receive_frame(request: Request, actor: CurrentActor, conn: Conn,
                      file: Annotated[UploadFile, File()], session_id: Annotated[str, Form(alias="sessionId", max_length=40)],
                      camera_id: Annotated[str, Form(alias="cameraId", max_length=40)], seq: Annotated[int, Form(ge=0)]):
        """One JPEG from the browser camera -> YOLO boxes -> (with OCR) reads, evidence, pending alerts.
        The image is only held in memory for this request."""
        started = time.perf_counter()
        camera = browser_camera(conn, actor, camera_id)
        data = file.file.read(MAX_FRAME_BYTES + 1)
        if not data:
            raise HTTPException(422, "Empty frame.")
        if len(data) > MAX_FRAME_BYTES:
            raise HTTPException(413, f"Frames must be at most {MAX_FRAME_BYTES // 1_000_000} MB.")
        try:
            found = detector.detect(decode_jpeg(data))
        except FrameError as e:
            raise HTTPException(422, str(e)) from None
        except FileNotFoundError:
            raise HTTPException(503, "The plate detector weights are missing on the server.") from None
        frame_sha = hashlib.sha256(data).hexdigest()
        del data

        now = datetime.now(UTC)
        latency = round((time.perf_counter() - started) * 1000)
        detections = []
        with transaction(conn):
            conn.execute("UPDATE cameras SET last_frame_at = ? WHERE id = ?", (_iso(now), camera_id))
            entries = _active_entries(conn, now) if any(f.plate for f in found) else []
            for i, f in enumerate(found):
                det = {"id": f"{session_id}-{seq}-{i}", "frameSeq": seq,
                       "box": dict(zip(("x", "y", "w", "h"), f.box, strict=True)),
                       "plate": f.plate, "confidence": f.confidence if f.plate else f.box_confidence,
                       "chars": [{"char": c, "confidence": p} for c, p in f.chars], "watchlistMatch": None, "alertId": None}
                detections.append(det)
                if f.plate:
                    _record_read(conn, camera, f, entries, det, now, latency, frame_sha)
        sessions[session_id] = LiveSession(actor.id, camera_id, seq, detections)
        if len(sessions) > 200:  # forget the oldest sessions; this is a cache, not storage
            for key in list(sessions)[:100]:
                sessions.pop(key, None)
        return {"sessionId": session_id, "seq": seq, "latencyMs": round((time.perf_counter() - started) * 1000)}

    def _record_read(conn, camera, f, entries, det, now, latency, frame_sha) -> None:
        """Store a validated read with its evidence record, and raise a pending alert on a watchlist
        match. The same plate on the same camera within READ_DEDUP reuses the last read."""
        recent = conn.execute("SELECT * FROM plate_reads WHERE camera_id = ? AND plate = ? AND captured_at >= ? "
                              "ORDER BY captured_at DESC LIMIT 1", (camera["id"], f.plate, _iso(now - READ_DEDUP))).fetchone()
        candidates = [matcher.Candidate(e["id"], e["plate"], e["color"], e["make"], e["model"]) for e in entries]
        read = matcher.PlateRead(f.plate, f.confidence, tuple(p for _, p in f.chars))
        best = next(iter(matcher.match(read, candidates, now=now)), None)
        if recent is None:
            read_id = _new_id("rd")
            conn.execute("INSERT INTO plate_reads (id, camera_id, plate, confidence, chars, captured_at, latency_ms, watchlist_hit)"
                         " VALUES (?,?,?,?,?,?,?,?)",
                         (read_id, camera["id"], f.plate, f.confidence, json.dumps(det["chars"], ensure_ascii=False),
                          _iso(now), latency, int(best is not None)))
            ev_id = evidence.append(conn, read_id=read_id, camera_id=camera["id"], captured_at=_iso(now), plate=f.plate,
                                    frame_sha256=frame_sha, model_version=detector.version)
            conn.execute("UPDATE plate_reads SET evidence_id = ? WHERE id = ?", (ev_id, read_id))
        else:
            read_id = recent["id"]
        if best is None:
            return
        entry = next(e for e in entries if e["id"] == best.entry_id)
        det["watchlistMatch"] = _entry_out(entry, now)
        open_alert = conn.execute(
            "SELECT a.id FROM alerts a JOIN plate_reads r ON r.id = a.read_id WHERE a.entry_id = ? AND r.camera_id = ?"
            " AND a.status = 'pending' AND a.created_at >= ? ORDER BY a.created_at DESC LIMIT 1",
            (entry["id"], camera["id"], _iso(now - ALERT_DEDUP))).fetchone()
        if open_alert:
            det["alertId"] = open_alert["id"]
            return
        alert_id = _new_id("al")
        conn.execute("INSERT INTO alerts (id, read_id, entry_id, match_score, created_at) VALUES (?,?,?,?,?)",
                     (alert_id, read_id, entry["id"], best.score, _iso(now)))
        audit.append(conn, actor="svc.detector", role="system", action="alert.create", target=alert_id,
                     detail=f"{best.kind} on {camera['id']}; awaiting human review", ip="local")
        det["alertId"] = alert_id

    @router.get("/detections")
    def detections(actor: CurrentActor, sessionId: str = ""):
        need(actor, "camera:live", "use the live camera")
        session = sessions.get(sessionId)
        if session is None or session.user_id != actor.id:
            return []
        return session.detections

    return router
