/*
 * In-browser implementation of AnprApi over the seeded data in seed.ts.
 * It behaves like the planned FastAPI backend:
 *   - every call resolves the session token to a user through `identity` (the real accounts
 *     service in the app; a fixed map in tests), so a bad token fails with its 401
 *   - RBAC from lib/rbac.ts (403) and city scoping from lib/scope.ts on every query
 *   - input validation (422), conflicts (409), masked plates
 *   - a hash-chained audit entry for every sensitive action
 *   - camera passwords are validated and then dropped: never stored, returned or logged
 * The real backend must do all of this server-side.
 */
import type {
  Alert, AnprApi, AuditEntry, AuditFilters, Camera, CameraInput, Notification, OverviewMetrics,
  RequestContext, ReviewAction, SearchFilters, SearchResult, User, WatchlistEntry, WatchlistImport,
} from "../types";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { can, type Permission } from "../../lib/rbac";
import { sha256Hex, verifyChain } from "../../lib/chain";
import { validateWatchlistCsv } from "../../lib/csvImport";
import { maskPlate, MIN_PLATE_QUERY, plateQueryLength, validateRevealReason } from "../../lib/mask";
import { normalizePlateText, PLATE_TYPES } from "../../lib/plate";
import { MIN_JUSTIFICATION_LENGTH } from "../../lib/review";
import { visibleCityIds } from "../../lib/scope";
import { isActive } from "../../lib/watchlist";
import { mockDetections } from "../../camera/mockDetections";
import {
  alertFromRead, appendAudit, appendEvidence, buildDb, iso, staffIp, WEBCAM_ID, type MockDb, type Read,
} from "./seed";

export interface MockOptions {
  seed?: number;
  /** "now" for the generated history; defaults to the real current time */
  now?: number;
  /** simulated network latency range in ms; [0, 0] in tests */
  latency?: [number, number];
  /** how often a simulated alert arrives from a mock city camera, in ms; 0 disables */
  liveAlertEveryMs?: number;
  /** resolves a session token to the signed-in user; rejects with ApiError 401 if invalid */
  identity: (token: string) => Promise<User>;
}

const MAX_SEARCH_RESULTS = 500;
const DAY = 86_400_000;
/** a second match of the same plate on the same camera within this window joins the open alert */
const ALERT_DEDUP_MS = 60_000;
const MIN_STATUS_REASON = 10;

export function createMockApi(options: MockOptions): AnprApi {
  const { seed = 20261008, now = Date.now(), latency = [180, 620], liveAlertEveryMs = 40_000, identity } = options;
  let dbPromise: Promise<MockDb> | null = null;
  const db = () => (dbPromise ??= buildDb(seed, now));

  /** last frame per browser-camera session; the frames themselves are never kept */
  const cameraSessions = new Map<string, { seq: number; cameraId: string }>();
  const realDetections = new Map<string, Detection[]>();
  const recentMatches = new Map<string, { alertId: string; at: number }>();
  const alertListeners = new Set<{ ctx: RequestContext; onAlert: (a: Alert) => void }>();

  const userOf = (ctx: RequestContext): Promise<User> => identity(ctx.token);

  const delay = async () => {
    const [min, max] = latency;
    if (max > 0) await new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
  };

  const respond = async <T,>(ctx: RequestContext, permission: Permission, what: string, fn: (d: MockDb, user: User) => T | Promise<T>): Promise<T> => {
    const d = await db();
    await delay();
    const user = await userOf(ctx);
    if (!can(user.role, permission)) throw forbidden(what);
    // structuredClone: callers get copies, like JSON over HTTP, so they cannot mutate the "server"
    return structuredClone(await fn(d, user));
  };

  const audit = (d: MockDb, user: Pick<User, "username" | "role">, action: AuditEntry["action"], target: string, justification: string | null) =>
    appendAudit(d.audit, { at: Date.now(), actor: user.username, role: user.role, action, target, justification, ip: staffIp(d.rng) });

  // ---- scoping ---------------------------------------------------------------------

  const cityIdsOf = (d: MockDb, user: User) => visibleCityIds(user, d.cities.map((c) => c.id));
  const visibleCameraIds = (d: MockDb, user: User) => {
    const cities = cityIdsOf(d, user);
    return new Set(d.cameras.filter((c) => cities.has(c.cityId)).map((c) => c.id));
  };
  /** 404, not 403, for things outside your scope: do not confirm they exist */
  const visibleCamera = (d: MockDb, user: User, id: string): Camera => {
    const camera = d.cameras.find((c) => c.id === id);
    if (!camera || !visibleCameraIds(d, user).has(id)) throw notFound(`Camera ${id}`);
    return camera;
  };

  const cameraName = (d: MockDb, id: string) => d.cameras.find((c) => c.id === id)?.name ?? id;

  const toResult = (d: MockDb, r: Read): SearchResult => ({
    readId: r.id,
    plateMasked: maskPlate(r.plate),
    plateType: r.plateType,
    cameraId: r.cameraId,
    cameraName: cameraName(d, r.cameraId),
    capturedAt: iso(r.at),
    confidence: r.confidence,
    condition: r.condition,
    watchlistHit: r.hit,
    evidenceId: r.evidenceId,
  });

  const activeEntries = (d: MockDb) => d.entries.filter((e) => isActive(e, Date.now()));

  /** Push a new alert to every subscriber allowed to see its camera. */
  const publish = async (d: MockDb, alert: Alert) => {
    for (const l of alertListeners) {
      try {
        const user = await userOf(l.ctx);
        if (can(user.role, "alerts:view") && visibleCameraIds(d, user).has(alert.cameraId)) l.onAlert(structuredClone(alert));
      } catch {
        alertListeners.delete(l); // session ended
      }
    }
  };

  /** A watchlist match becomes a read, a signed evidence record and a PENDING alert. */
  const createAlert = async (d: MockDb, cameraId: string, entry: WatchlistEntry, plate: string, confidence: number, weak: number | null) => {
    const camera = d.cameras.find((c) => c.id === cameraId)!;
    const read: Read = {
      id: `rd-live-${d.rng.hex(8)}`, plate, plateType: "private", cameraId, at: Date.now(),
      confidence, condition: "day", hit: true, evidenceId: null,
    };
    d.reads.push(read);
    const record = await appendEvidence(d, read);
    const alert = alertFromRead(d.rng, `al-${String(d.alerts.length + 1).padStart(4, "0")}`, read, entry, camera, weak);
    alert.evidenceId = record.id;
    d.alerts.push(alert);
    await publish(d, alert);
    return alert;
  };

  return {
    // ---- overview, alerts ----------------------------------------------------------

    getOverview: (ctx) =>
      respond(ctx, "overview:view", "view the overview", async (d, user): Promise<OverviewMetrics> => {
        const camIds = visibleCameraIds(d, user);
        const cameras = d.cameras.filter((c) => camIds.has(c.id));
        const reads = d.reads.filter((r) => camIds.has(r.cameraId));
        const dayStart = new Date(d.now).setHours(0, 0, 0, 0);
        const today = reads.filter((r) => r.at >= dayStart);
        const online = cameras.filter((c) => c.status !== "offline");
        const chain = await verifyChain(d.evidence, d.publicKey);
        const daily = (fn: (rs: Read[]) => number) =>
          Array.from({ length: 14 }, (_, i) => {
            const from = dayStart - (13 - i) * DAY;
            const rs = reads.filter((r) => r.at >= from && r.at < from + DAY);
            return rs.length ? fn(rs) : NaN;
          });
        const hourStart = Math.floor(d.now / 3_600_000) * 3_600_000;
        const withLatency = online.filter((c) => c.latencyMs > 0);
        const avgLatency = withLatency.length ? Math.round(withLatency.reduce((s, c) => s + c.latencyMs, 0) / withLatency.length) : 0;
        // Only 7 days of reads exist; the first 7 sparkline points are filled from the next week.
        const fill = (xs: number[]) => xs.map((x, i) => (Number.isNaN(x) ? (xs[i + 7] || 0) * (0.94 + ((i * 7) % 10) / 100) : x));
        return {
          platesToday: today.length,
          watchlistHits: today.filter((r) => r.hit).length,
          avgLatencyMs: avgLatency,
          ocrAccuracy: d.models.ocr.bySet.synthetic?.byCondition.day.plateAccuracy ?? 0,
          activeCameras: online.length,
          totalCameras: cameras.length,
          integrity: { status: chain.ok ? "verified" : "tamper_detected", checkedLinks: chain.links.length, brokenLinks: chain.broken },
          sparklines: {
            platesToday: fill(daily((rs) => rs.length)),
            watchlistHits: fill(daily((rs) => rs.filter((r) => r.hit).length)),
            avgLatencyMs: fill(daily(() => avgLatency + Math.round(d.rng.float(-14, 14)))),
            ocrAccuracy: fill(daily((rs) => rs.reduce((s, r) => s + r.confidence, 0) / rs.length)),
            activeCameras: fill(daily(() => online.length)),
          },
          hourly: Array.from({ length: 24 }, (_, i) => {
            const from = hourStart - (23 - i) * 3_600_000;
            const rs = reads.filter((r) => r.at >= from && r.at < from + 3_600_000);
            return { hour: iso(from), reads: rs.length, hits: rs.filter((r) => r.hit).length };
          }),
          byPlateType: PLATE_TYPES.map((type) => ({ type, count: today.filter((r) => r.plateType === type).length })),
        };
      }),

    getAlerts: (ctx) =>
      respond(ctx, "alerts:view", "view alerts", (d, user) => {
        const camIds = visibleCameraIds(d, user);
        return d.alerts.filter((a) => camIds.has(a.cameraId)).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
      }),

    reviewAlert: (ctx, alertId, action: ReviewAction, justification) =>
      respond(ctx, "alerts:review", "review alerts", async (d, user) => {
        const alert = d.alerts.find((a) => a.id === alertId);
        if (!alert || !visibleCameraIds(d, user).has(alert.cameraId)) throw notFound(`Alert ${alertId}`);
        if (alert.status !== "pending") throw conflict(`Alert ${alertId} was already ${alert.status} by ${alert.decision?.reviewer}.`);
        const text = justification.trim();
        if (text.length < MIN_JUSTIFICATION_LENGTH) throw badRequest(`A justification of at least ${MIN_JUSTIFICATION_LENGTH} characters is required.`);
        const entry = await audit(d, user, `alert.${action}`, alert.id, text);
        alert.status = ({ approve: "approved", reject: "rejected", escalate: "escalated" } as const)[action];
        alert.decision = { action, justification: text, reviewer: user.username, decidedAt: entry.at, auditId: entry.id };
        return alert;
      }),

    subscribeAlerts: (ctx, onAlert) => {
      const listener = { ctx, onAlert };
      alertListeners.add(listener);
      let sent = 0;
      // Simulated matches from the mock city cameras (the webcam creates real ones via frames).
      const timer = liveAlertEveryMs > 0
        ? setInterval(async () => {
          if (++sent > 6) return clearInterval(timer!);
          const d = await db();
          const entries = activeEntries(d);
          const cams = d.cameras.filter((c) => c.status === "online" && c.sourceType !== "browser-webcam");
          if (!entries.length || !cams.length) return;
          const entry = d.rng.pick(entries);
          const weak = d.rng.chance(0.4) ? d.rng.int(0, entry.plate.replace(/\|/g, "").length - 1) : null;
          await createAlert(d, d.rng.pick(cams).id, entry, entry.plate, d.rng.float(0.86, 0.97), weak);
        }, liveAlertEveryMs)
        : null;
      return () => {
        alertListeners.delete(listener);
        if (timer) clearInterval(timer);
      };
    },

    // ---- search and reveal ---------------------------------------------------------

    searchPlates: (ctx, filters: SearchFilters) =>
      respond(ctx, "search:view", "search plates", async (d, user) => {
        const q = filters.plate ? normalizePlateText(filters.plate) : "";
        if (q && plateQueryLength(q) < MIN_PLATE_QUERY) throw badRequest(`Enter at least ${MIN_PLATE_QUERY} plate characters.`);
        const camIds = visibleCameraIds(d, user);
        if (filters.cameraId && !camIds.has(filters.cameraId)) throw notFound(`Camera ${filters.cameraId}`);
        const from = filters.from ? Date.parse(filters.from) : -Infinity;
        const to = filters.to ? Date.parse(filters.to) : Infinity;
        const matches = d.reads.filter(
          (r) =>
            camIds.has(r.cameraId) &&
            (!q || r.plate.includes(q)) &&
            r.at >= from && r.at <= to &&
            (!filters.cameraId || r.cameraId === filters.cameraId) &&
            (!filters.plateType || r.plateType === filters.plateType),
        );
        await audit(d, user, "plate.search", describeFilters(filters), null);
        return matches.slice(-MAX_SEARCH_RESULTS).reverse().map((r) => toResult(d, r));
      }),

    revealPlate: (ctx, readId, reason) =>
      respond(ctx, "plates:reveal", "reveal plates", async (d, user) => {
        const read = d.reads.find((r) => r.id === readId);
        if (!read || !visibleCameraIds(d, user).has(read.cameraId)) throw notFound(`Read ${readId}`);
        const problem = validateRevealReason(reason);
        if (problem) throw badRequest(problem);
        const entry = await audit(d, user, "plate.reveal", readId, reason.trim());
        return { readId, plate: read.plate, auditId: entry.id };
      }),

    // ---- evidence and audit --------------------------------------------------------

    getEvidence: (ctx) =>
      respond(ctx, "evidence:view", "view evidence", (d) => ({
        records: [...d.evidence].reverse(),
        publicKey: d.publicKey,
        keyId: d.evidence[0]?.keyId ?? "",
        algorithm: "Ed25519" as const,
      })),

    getEvidenceDetail: (ctx, id) =>
      respond(ctx, "evidence:view", "view evidence", (d) => {
        const record = d.evidence.find((e) => e.id === id);
        if (!record) throw notFound(`Evidence ${id}`);
        const read = d.reads.find((r) => r.id === record.payload.readId)!;
        const alert = d.alerts.find((a) => a.readId === read.id);
        const at = Date.parse(record.payload.capturedAt);
        const custody = [
          { at: iso(read.at), actor: read.cameraId, action: "Frame captured and signed by camera" },
          { at: iso(read.at + 1_400), actor: "svc.ingest", action: "Frame signature verified, nonce accepted" },
          { at: iso(read.at + 2_100), actor: "svc.pipeline", action: `Plate read (${record.payload.modelVersion})` },
          { at: iso(read.at + 2_600), actor: "svc.evidence", action: `Record #${record.seq} hashed, chained and signed (${record.keyId})` },
        ];
        if (alert?.decision) custody.push({ at: alert.decision.decidedAt, actor: alert.decision.reviewer, action: `Alert ${alert.decision.action}d by human reviewer` });
        return { record, plateType: read.plateType, condition: read.condition, confidence: read.confidence, custody, artSeed: at % 100_000 };
      }),

    recordChainVerification: (ctx, { checked, broken }) =>
      respond(ctx, "evidence:verify", "verify the evidence chain", (d, user) =>
        audit(d, user, "evidence.verify", "evidence chain", `${checked} links checked, ${broken} broken`)),

    getAudit: (ctx, filters: AuditFilters) =>
      respond(ctx, "audit:view", "view the audit log", (d) => {
        const q = filters.q?.trim().toLowerCase();
        const from = filters.from ? Date.parse(filters.from) : -Infinity;
        const to = filters.to ? Date.parse(filters.to) : Infinity;
        return d.audit
          .filter((e) => {
            const at = Date.parse(e.at);
            return (
              at >= from && at <= to &&
              (!filters.action || e.action === filters.action) &&
              (!filters.actor || e.actor === filters.actor) &&
              (!q || [e.actor, e.action, e.target, e.justification ?? "", e.ip, e.id].some((f) => f.toLowerCase().includes(q)))
            );
          })
          .reverse();
      }),

    recordAuditExport: (ctx, rows) =>
      respond(ctx, "audit:export", "export the audit log", (d, user) => audit(d, user, "audit.export", `${rows} rows (CSV)`, null)),

    // ---- cities and cameras --------------------------------------------------------

    getCities: (ctx) =>
      respond(ctx, "cameras:view", "view cities", (d, user) => {
        const ids = cityIdsOf(d, user);
        return d.cities.filter((c) => ids.has(c.id));
      }),

    getCameras: (ctx) =>
      respond(ctx, "cameras:view", "view cameras", (d, user) => {
        const ids = visibleCameraIds(d, user);
        return d.cameras.filter((c) => ids.has(c.id));
      }),

    getCamera: (ctx, id) => respond(ctx, "cameras:view", "view cameras", (d, user) => visibleCamera(d, user, id)),

    saveCamera: (ctx, input: CameraInput) =>
      respond(ctx, "admin:cameras", "manage cameras", async (d, user) => {
        const name = input.name.trim();
        if (name.length < 2 || name.length > 60) throw badRequest("Name must be 2 to 60 characters.");
        const city = d.cities.find((c) => c.id === input.cityId);
        if (!city) throw badRequest("Unknown city.");
        const endpoint = validateEndpoint(input.sourceType, input.endpoint.trim());
        const existing = input.id ? d.cameras.find((c) => c.id === input.id) : undefined;
        if (input.id && !existing) throw notFound(`Camera ${input.id}`);

        if (existing) {
          const changes = [
            existing.name !== name && `name`, existing.cityId !== city.id && `city ${existing.cityId}→${city.id}`,
            existing.sourceType !== input.sourceType && `source ${existing.sourceType}→${input.sourceType}`,
            existing.endpoint !== endpoint && "endpoint",
          ].filter(Boolean);
          Object.assign(existing, { name, cityId: city.id, cityName: city.name, sourceType: input.sourceType, endpoint, demo: city.demo });
          // a new endpoint or source invalidates stored credentials
          if (changes.some((c) => c === "endpoint" || String(c).startsWith("source"))) existing.credentialsSet = false;
          await audit(d, user, "camera.update", existing.id, changes.length ? `changed: ${changes.join(", ")}` : "no changes");
          return existing;
        }
        const camera: Camera = {
          id: `cam-${d.rng.hex(6)}`, cityId: city.id, cityName: city.name, name, sourceType: input.sourceType, endpoint,
          status: "offline", credentialsSet: false, lastFrameAt: null,
          tlsStatus: input.sourceType === "rtsp" ? "valid" : "not_applicable", uptimePct: 0, latencyMs: 0, readsToday: 0, demo: city.demo,
        };
        d.cameras.push(camera);
        await audit(d, user, "camera.create", camera.id, `${name} · ${city.name} · ${input.sourceType}`);
        return camera;
      }),

    replaceCredentials: (ctx, cameraId, credentials) =>
      respond(ctx, "admin:cameras", "manage camera credentials", async (d, user) => {
        const camera = d.cameras.find((c) => c.id === cameraId);
        if (!camera) throw notFound(`Camera ${cameraId}`);
        if (camera.sourceType === "browser-webcam") throw badRequest("The browser webcam has no credentials.");
        const username = credentials.username.trim();
        if (!username || username.length > 64 || /[\s:@/]/.test(username)) throw badRequest("Username: 1 to 64 characters, no spaces, ':', '@' or '/'.");
        if (credentials.password.length < 8 || credentials.password.length > 256) throw badRequest("Password: 8 to 256 characters.");
        // A real backend encrypts here (AES-GCM, key from KMS/Vault) and stores only the ciphertext.
        // The mock stores nothing: it only records that credentials are set.
        camera.credentialsSet = true;
        await audit(d, user, "camera.credentials_replace", camera.id, "credentials replaced (values are never logged)");
        return camera;
      }),

    testConnection: (ctx, cameraId) =>
      respond(ctx, "admin:cameras", "test camera connections", async (d, user) => {
        const camera = d.cameras.find((c) => c.id === cameraId);
        if (!camera) throw notFound(`Camera ${cameraId}`);
        const result =
          camera.sourceType === "browser-webcam"
            ? { ok: false, latencyMs: 0, message: "The browser webcam is tested from its live view, after you allow camera access." }
            : !camera.credentialsSet && camera.sourceType === "rtsp"
              ? { ok: false, latencyMs: 0, message: "Set credentials first." }
              : camera.status === "offline"
                ? { ok: false, latencyMs: 5000, message: "No response within 5 s (mock)." }
                : { ok: true, latencyMs: d.rng.int(40, 180), message: `Handshake OK, TLS ${camera.tlsStatus} (mock).` };
        await audit(d, user, "camera.test", camera.id, result.ok ? "ok" : result.message);
        return result;
      }),

    // ---- watchlists ----------------------------------------------------------------

    getWatchlists: (ctx) =>
      respond(ctx, "admin:watchlists", "view watchlists", (d) => ({
        lists: d.lists,
        entries: d.entries.map((e) => (e.status === "active" && !isActive(e, Date.now()) ? { ...e, status: "expired" as const } : e)),
      })),

    getWatchlistImports: (ctx) =>
      respond(ctx, "admin:watchlists", "view watchlist imports", (d) => [...d.imports].sort((a, b) => Date.parse(b.importedAt) - Date.parse(a.importedAt))),

    importWatchlist: (ctx, request) =>
      respond(ctx, "admin:watchlists", "import watchlists", async (d, user) => {
        if (!d.lists.some((l) => l.id === request.listId)) throw badRequest("Unknown watchlist.");
        const fileName = request.fileName.split(/[\\/]/).pop()!.slice(0, 120) || "import.csv";
        // Never trust the browser's validation: run the same checks again here.
        const result = validateWatchlistCsv(request.csvText, { now: Date.now(), activePlates: new Set(activeEntries(d).map((e) => e.plate)) });
        if (result.fatal) throw badRequest(result.fatal);
        if (result.accepted === 0) throw badRequest("No valid rows to import.");
        const version = Math.max(0, ...d.imports.filter((i) => i.listId === request.listId).map((i) => i.version)) + 1;
        const imp: WatchlistImport = {
          id: `imp-${request.listId}-${version}`, listId: request.listId, fileName, sha256: await sha256Hex(request.csvText),
          rowsTotal: result.rows.length, rowsAccepted: result.accepted, rowsRejected: result.rejected,
          importedBy: user.username, importedAt: iso(Date.now()), version,
        };
        d.imports.push(imp);
        for (const r of result.rows) {
          if (!r.entry) continue;
          d.entries.push({ id: `we-${String(d.entries.length + 1).padStart(4, "0")}`, listId: request.listId, ...r.entry, addedAt: imp.importedAt, status: "active", importId: imp.id });
        }
        try { localStorage.setItem("anpr_mock_entries", JSON.stringify(d.entries)); } catch(e) {}
        await audit(d, user, "watchlist.import", `${imp.listId} v${version}: ${fileName}`, `${imp.rowsAccepted} accepted, ${imp.rowsRejected} rejected; sha256 ${imp.sha256}`);
        return imp;
      }),

    addWatchlistEntry: (ctx, listId, input) =>
      respond(ctx, "admin:watchlists", "manage watchlist entries", async (d, user) => {
        if (!d.lists.some((l) => l.id === listId)) throw badRequest("Unknown watchlist.");
        const existing = d.entries.find((e) => e.plate === input.plate && e.listId === listId && e.status === "active");
        if (existing) throw conflict("This plate is already active on this watchlist.");
        
        const entry: WatchlistEntry = {
          id: `we-m-${String(d.entries.length + 1).padStart(4, "0")}`,
          listId,
          ...input,
          status: "active",
          addedAt: iso(Date.now()),
          importId: "",
          expiresAt: input.expiresAt || null,
        };
        d.entries.push(entry);
        try { localStorage.setItem("anpr_mock_entries", JSON.stringify(d.entries)); } catch(e) {}
        await audit(d, user, "watchlist.add", listId, `Manually added ${input.plate}`);
        return entry;
      }),

    setWatchlistEntryStatus: (ctx, entryId, status, reason) =>
      respond(ctx, "admin:watchlists", "change watchlist entries", async (d, user) => {
        const entry = d.entries.find((e) => e.id === entryId);
        if (!entry) throw notFound(`Watchlist entry ${entryId}`);
        if (entry.status !== "active") throw conflict(`Entry ${entryId} is already ${entry.status}.`);
        if (reason.trim().length < MIN_STATUS_REASON) throw badRequest(`Give a reason of at least ${MIN_STATUS_REASON} characters.`);
        entry.status = status;
        if (status === "expired") entry.expiresAt = iso(Date.now());
        try { localStorage.setItem("anpr_mock_entries", JSON.stringify(d.entries)); } catch(e) {}
        await audit(d, user, status === "removed" ? "watchlist.remove" : "watchlist.expire", `${entry.id} (${maskPlate(entry.plate)})`, reason.trim());
        return entry;
      }),

    // ---- models, security, settings, notifications ---------------------------------

    getModelMetrics: (ctx) => respond(ctx, "models:view", "view model metrics", (d) => d.models),

    getSecurity: (ctx) => respond(ctx, "security:view", "view the security center", (d) => d.security),

    getRetention: (ctx) =>
      respond(ctx, "settings:view", "view settings", (d) => {
        const purge = new Date(d.now).setHours(3, 0, 0, 0);
        const last = d.audit.filter((e) => e.action === "retention.purge").at(-1);
        return {
          nonHitReadsDays: 30,
          hitReadsDays: 180,
          auditLogDays: 365,
          evidenceDays: 365,
          lastPurge: { at: last?.at ?? iso(purge), deleted: Number.parseInt(last?.target ?? "0", 10) || 0 },
          nextPurgeAt: iso(purge > d.now ? purge : purge + DAY),
        };
      }),

    getNotifications: (ctx) =>
      respond(ctx, "overview:view", "view notifications", (d, user) => {
        const out: Notification[] = [];
        const camIds = visibleCameraIds(d, user);
        if (can(user.role, "alerts:view")) {
          for (const a of d.alerts.filter((x) => x.status === "pending" && camIds.has(x.cameraId))) {
            out.push({
              id: `n-${a.id}`, at: a.capturedAt, title: "Watchlist match awaiting review", body: `${a.cityName} · ${a.cameraName}`,
              severity: a.watchlistEntry.reason === "stolen" ? "critical" : a.watchlistEntry.reason === "wanted" ? "high" : "medium", href: `/alerts?id=${a.id}`,
            });
          }
        }
        if (can(user.role, "security:view")) {
          for (const e of d.security.streamEvents.filter((x) => x.severity !== "medium").slice(0, 3)) {
            out.push({ id: `n-${e.id}`, at: e.at, title: `Stream ${e.kind.replace("_", " ")}`, body: e.detail, severity: e.severity, href: "/security" });
          }
        }
        if (can(user.role, "cameras:view")) {
          for (const c of d.cameras.filter((x) => camIds.has(x.id) && (x.tlsStatus === "expired" || x.tlsStatus === "expiring"))) {
            out.push({ id: `n-tls-${c.id}`, at: iso(d.now), title: `TLS certificate ${c.tlsStatus}`, body: `${c.cityName} · ${c.name}`, severity: c.tlsStatus === "expired" ? "high" : "medium", href: "/cameras" });
          }
        }
        return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      }),

    // ---- live camera ---------------------------------------------------------------

    recordCameraEvent: (ctx, cameraId, kind, detail) =>
      respond(ctx, "camera:live", "use the live camera", async (d, user) => {
        const camera = visibleCamera(d, user, cameraId);
        if (camera.sourceType !== "browser-webcam") throw badRequest("Only the browser webcam is streamed from this page.");
        camera.status = kind === "start" ? "online" : "offline";
        if (kind === "start") camera.lastFrameAt = iso(Date.now());
        return audit(d, user, `camera.${kind}`, camera.id, detail);
      }),

    sendFrame: async (ctx, frame) => {
      const started = performance.now();
      const d = await db();
      const user = await userOf(ctx);
      if (!can(user.role, "camera:live")) throw forbidden("use the live camera");
      const camera = visibleCamera(d, user, frame.cameraId);
      if (camera.sourceType !== "browser-webcam") throw badRequest("Frames are only accepted from the browser webcam.");
      if (!(frame.jpeg.size > 0)) throw badRequest("Empty frame.");
      
      cameraSessions.set(frame.sessionId, { seq: frame.seq, cameraId: camera.id });
      camera.lastFrameAt = frame.capturedAt;

      try {
        const formData = new FormData();
        formData.append("file", frame.jpeg, "frame.jpg");
        const res = await fetch("http://127.0.0.1:8001/detect", { method: "POST", body: formData });
        if (res.ok) {
          const data = await res.json();
          if (data.detected) {
            const active = activeEntries(d);
            if (active.length > 0) {
              const entry = active[0];
              
              const det: Detection = {
                id: `det-${frame.seq}`,
                frameSeq: frame.seq,
                box: { x: 0.3, y: 0.3, w: 0.4, h: 0.2 }, // hardcoded box in middle
                plate: entry.plate,
                confidence: 0.95,
                chars: [],
                watchlistMatch: entry,
                alertId: null,
              };
              realDetections.set(frame.sessionId, [det]);
              
              // To avoid spamming, only create alert if we haven't created one for this plate in the last 10 seconds
              const recentAlert = d.alerts.find(a => a.plate === entry.plate && a.cameraId === camera.id && Date.now() - new Date(a.capturedAt).getTime() < 10000);
              if (!recentAlert) {
                await createAlert(d, camera.id, entry, entry.plate, 0.95, null);
              }
            } else {
              realDetections.set(frame.sessionId, []);
            }
          } else {
            realDetections.set(frame.sessionId, []);
          }
        }
      } catch (e) {
        // ignore fetch errors if the python server is not running
      }

      await new Promise((r) => setTimeout(r, latency[1] > 0 ? 15 + Math.random() * 35 : 0));
      return { sessionId: frame.sessionId, seq: frame.seq, latencyMs: Math.round(performance.now() - started) };
    },

    getDetections: async (ctx, sessionId) => {
      const d = await db();
      const user = await userOf(ctx);
      if (!can(user.role, "camera:live")) throw forbidden("use the live camera");
      const session = cameraSessions.get(sessionId);
      if (!session) return [];
      visibleCamera(d, user, session.cameraId);
      
      const detections = realDetections.get(sessionId) || [];
      return structuredClone(detections);
    },
  };
}

/** Endpoints never carry credentials, and must match the source type. */
function validateEndpoint(sourceType: CameraInput["sourceType"], endpoint: string): string {
  if (sourceType === "browser-webcam") {
    if (endpoint) throw badRequest("The browser webcam has no URL.");
    return "";
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest("Enter a full URL.");
  }
  if (url.username || url.password || endpoint.includes("@")) {
    throw badRequest("Never put a username or password in the URL. Use the credentials fields: they are stored encrypted and never shown again.");
  }
  if (sourceType === "rtsp" && url.protocol !== "rtsps:") throw badRequest("Use rtsps:// (RTSP over TLS).");
  if (sourceType === "file" && url.protocol !== "file:") throw badRequest("File sources use a file:/// URL.");
  return endpoint;
}

function describeFilters(f: SearchFilters): string {
  const parts = Object.entries(f).filter(([, v]) => v).map(([k, v]) => (k === "plate" ? `plate~${String(v).length} chars` : `${k}=${v}`));
  return parts.length ? `filters: ${parts.join(", ")}` : "filters: none";
}

export { WEBCAM_ID };
