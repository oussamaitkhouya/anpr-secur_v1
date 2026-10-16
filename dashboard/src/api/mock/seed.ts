/*
 * Seeded synthetic data for the mock API. Everything here is invented: one local test city with
 * the PC webcam, two fictional demo cities with mock cameras, demo accounts, random
 * Moroccan-style plates, and IP addresses from private (10.0.0.0/8) and documentation
 * (203.0.113.0/24) ranges. No real people, plates or places.
 */
import type {
  Alert, AuditAction, AuditEntry, Camera, CharConfidence, City, Condition, EvidenceRecord, ModelMetrics,
  PlateType, Priority, ReviewAction, SecurityOverview, StreamEvent, User, WatchlistEntry, WatchlistImport, WatchlistList,
} from "../types";
import type { Role } from "../../lib/rbac";
import { GENESIS, generateSigningKey, linkHash, sha256Hex, sign } from "../../lib/chain";
import { toCsv } from "../../lib/csv";
import { validateWatchlistCsv, WATCHLIST_COLUMNS } from "../../lib/csvImport";
import { maskPlate } from "../../lib/mask";
import { PLATE_LETTERS, REGION_MAX, REGION_MIN, PLATE_TYPES } from "../../lib/plate";
import { Rng } from "./rng";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const MODEL_VERSION = "det-yolo11n-0.3+ocr-crnn-0.2";
export const KEY_ID = "evidence-signing-demo-1";
export const WEBCAM_ID = "cam-pc";

export interface Read {
  id: string;
  plate: string;
  plateType: PlateType;
  cameraId: string;
  at: number;
  confidence: number;
  condition: Condition;
  hit: boolean;
  evidenceId: string | null;
}

export interface MockDb {
  now: number;
  cities: City[];
  cameras: Camera[];
  lists: WatchlistList[];
  entries: WatchlistEntry[];
  imports: WatchlistImport[];
  reads: Read[];
  alerts: Alert[];
  evidence: EvidenceRecord[];
  publicKey: string | null;
  privateKey: CryptoKey | null;
  audit: AuditEntry[];
  security: SecurityOverview;
  models: ModelMetrics;
  rng: Rng;
}

// ---- helpers -------------------------------------------------------------------------

export const iso = (ms: number) => new Date(ms).toISOString();

export function randomPlate(rng: Rng): string {
  const digits = rng.weighted([[5, 6], [4, 3], [3, 1], [2, 0.5], [1, 0.2]] as const);
  let number = String(rng.int(1, 9));
  for (let i = 1; i < digits; i++) number += String(rng.int(0, 9));
  return `${number}|${rng.pick(PLATE_LETTERS)}|${rng.int(REGION_MIN, REGION_MAX)}`;
}

/** Per-character OCR confidence; `weakIndex` gets a low score (the character a human should check). */
export function charConfidences(rng: Rng, plate: string, base: number, weakIndex: number | null = null): CharConfidence[] {
  return plate.replace(/\|/g, "").split("").map((char, i) => ({
    char,
    confidence: i === weakIndex ? rng.float(0.41, 0.63) : Math.min(0.999, Math.max(0.6, base + rng.float(-0.06, 0.04))),
  }));
}

function conditionFor(rng: Rng, at: number, rainyDay: number): Condition {
  const hour = new Date(at).getHours();
  if (rng.chance(0.05)) return "blur";
  if (Math.floor(at / DAY) === rainyDay && rng.chance(0.7)) return "rain";
  return hour < 6 || hour >= 20 ? "night" : "day";
}

const CONDITION_CONFIDENCE: Record<Condition, number> = { day: 0.965, night: 0.91, rain: 0.89, blur: 0.84 };

/** Relative traffic by hour of day: quiet nights, morning and evening peaks. */
const TRAFFIC = [0.15, 0.1, 0.08, 0.08, 0.12, 0.3, 0.7, 1.3, 1.6, 1.2, 0.95, 0.9, 1.0, 1.0, 0.9, 0.95, 1.2, 1.55, 1.45, 1.0, 0.7, 0.5, 0.35, 0.22];

// ---- cities, cameras, users ----------------------------------------------------------

export const CITIES: City[] = [
  { id: "city-local", name: "Local test", demo: false },
  { id: "city-north", name: "Demo City North", demo: true },
  { id: "city-south", name: "Demo City South", demo: true },
];

function makeCameras(rng: Rng, now: number): Camera[] {
  const city = (id: string) => CITIES.find((c) => c.id === id)!;
  const base = (id: string, cityId: string, name: string, extra: Partial<Camera>): Camera => ({
    id, cityId, cityName: city(cityId).name, name,
    sourceType: "rtsp", endpoint: "", status: "online", credentialsSet: false, lastFrameAt: iso(now - rng.int(1, 8) * 1000),
    tlsStatus: "valid", uptimePct: rng.float(99.4, 99.99), latencyMs: rng.int(88, 165), readsToday: 0, demo: city(cityId).demo,
    ...extra,
  });
  return [
    base(WEBCAM_ID, "city-local", "PC Webcam (test)", {
      sourceType: "browser-webcam", status: "offline", lastFrameAt: null, tlsStatus: "not_applicable", uptimePct: 0, latencyMs: 0,
    }),
    base("cam-n1", "city-north", "North gate · inbound", { endpoint: "rtsps://10.20.1.21:322/stream1", credentialsSet: true }),
    base("cam-n2", "city-north", "Ring road east", {
      endpoint: "rtsps://10.20.1.22:322/stream1", credentialsSet: true, status: "degraded", tlsStatus: "expiring",
      uptimePct: 97.2, latencyMs: rng.int(310, 380), lastFrameAt: iso(now - rng.int(20, 90) * 1000),
    }),
    base("cam-s1", "city-south", "Depot barrier", { endpoint: "rtsps://10.30.2.11:322/main", credentialsSet: true }),
    base("cam-s2", "city-south", "Service lane (recorded)", {
      sourceType: "file", endpoint: "file:///samples/service_lane_demo.mp4", status: "offline", tlsStatus: "not_applicable",
      uptimePct: 91.4, lastFrameAt: iso(now - 6 * HOUR - 17 * 60_000),
    }),
  ];
}

/** Fictional staff who appear in the seeded history (audit log, past reviews). Not accounts. */
export const USERS: User[] = [
  { id: "u-admin", username: "demo.admin", name: "Demo Admin", role: "admin", allowedCityIds: CITIES.map((c) => c.id) },
  { id: "u-analyst-local", username: "analyst.local", name: "Demo Analyst · Local", role: "analyst", allowedCityIds: ["city-local"] },
  { id: "u-analyst-north", username: "analyst.north", name: "Demo Analyst · North", role: "analyst", allowedCityIds: ["city-local", "city-north"] },
  { id: "u-auditor", username: "demo.auditor", name: "Demo Auditor", role: "auditor", allowedCityIds: [] },
];

// ---- reads ---------------------------------------------------------------------------

function makeReads(rng: Rng, now: number, cameras: Camera[]): Read[] {
  const reads: Read[] = [];
  const rainyDay = Math.floor((now - 2 * DAY) / DAY);
  const start = Math.floor((now - 7 * DAY) / HOUR) * HOUR;
  const mock = cameras.filter((c) => c.sourceType !== "browser-webcam");
  const offlineSince = now - 6 * HOUR - 17 * 60_000;
  let n = 0;
  for (let hourStart = start; hourStart < now; hourStart += HOUR) {
    const count = Math.round(38 * TRAFFIC[new Date(hourStart).getHours()] * rng.float(0.8, 1.2));
    for (let i = 0; i < count; i++) {
      const at = hourStart + rng.int(0, HOUR - 1);
      if (at > now) continue;
      const camera = rng.pick(mock);
      if (camera.status === "offline" && at > offlineSince) continue;
      const condition = conditionFor(rng, at, rainyDay);
      reads.push({
        id: `rd-${String(++n).padStart(6, "0")}`,
        plate: randomPlate(rng),
        plateType: rng.weighted([["private", 78], ["taxi", 10], ["temporary", 4], ["government", 4], ["police", 2], ["diplomatic", 2]] as const),
        cameraId: camera.id,
        at,
        confidence: Math.min(0.995, CONDITION_CONFIDENCE[condition] + rng.float(-0.05, 0.03)),
        condition,
        hit: false,
        evidenceId: null,
      });
    }
  }
  return reads.sort((a, b) => a.at - b.at);
}

// ---- watchlists (seeded through the real CSV validator) ------------------------------

export const LISTS: WatchlistList[] = [
  { id: "wl-stolen", name: "Stolen vehicles" },
  { id: "wl-wanted", name: "Wanted vehicles" },
];

async function seedWatchlists(rng: Rng, now: number) {
  const entries: WatchlistEntry[] = [];
  const imports: WatchlistImport[] = [];
  try {
    const saved = localStorage.getItem("anpr_mock_entries");
    if (saved) {
      entries.push(...JSON.parse(saved));
    }
  } catch (e) {}
  return { entries, imports };
}

// ---- alerts --------------------------------------------------------------------------

const DECISION_TEXT: Record<ReviewAction, string[]> = {
  approve: [
    "Plate crop and full frame match the watchlist entry; vehicle make consistent with case notes.",
    "All characters legible on the crop, region and letter match. Confirmed.",
    "Match confirmed against the frame; security desk informed per procedure.",
  ],
  reject: [
    "Low-confidence digit is a 3, not an 8, on the crop. Not the listed vehicle.",
    "Region code differs on the full frame. OCR misread, no match.",
    "Glare on the plate; the crop shows a different letter. False match.",
  ],
  escalate: [
    "Plate matches but vehicle colour differs from the case notes; possible cloned plate. Escalating to supervisor.",
    "Partial occlusion, cannot confirm the last digit. Escalating for a second reviewer.",
  ],
};

/** Who reviews alerts from a city in the seed: someone who is allowed to see that city. */
const REVIEWER_BY_CITY: Record<string, { username: string; role: Role }> = {
  "city-north": { username: "analyst.north", role: "analyst" },
  "city-south": { username: "demo.admin", role: "admin" },
  "city-local": { username: "analyst.local", role: "analyst" },
};

export function alertFromRead(
  rng: Rng, id: string, read: Read, entry: WatchlistEntry, camera: Camera, weak: number | null,
): Alert {
  return {
    id,
    readId: read.id,
    plate: read.plate,
    plateType: read.plateType,
    confidence: read.confidence,
    chars: charConfidences(rng, read.plate, read.confidence, weak),
    cameraId: camera.id,
    cameraName: camera.name,
    cityId: camera.cityId,
    cityName: camera.cityName,
    capturedAt: iso(read.at),
    condition: read.condition,
    matchScore: read.plate === entry.plate ? 1 : 1 - 1 / read.plate.replace(/\|/g, "").length,
    watchlistEntry: entry,
    evidenceId: "",
    status: "pending",
    decision: null,
  };
}

function makeAlerts(rng: Rng, now: number, reads: Read[], cameras: Camera[], entries: WatchlistEntry[]): Alert[] {
  if (entries.length === 0) return [];
  const recent = reads.filter((r) => r.at > now - 2 * DAY);
  const chosen = new Set<number>();
  while (chosen.size < 18) chosen.add(rng.int(0, recent.length - 1));

  return [...chosen].sort((a, b) => a - b).map((idx, i) => {
    const read = recent[idx];
    const entry = rng.pick(entries);
    const nearMatch = rng.chance(0.3);
    let weak: number | null = null;
    read.plate = entry.plate;
    if (nearMatch) {
      // OCR text differs from the watchlist plate in one digit: exactly the case a human must catch
      const [digits, ...rest] = entry.plate.split("|");
      weak = rng.int(1, digits.length - 1 || 1);
      if (weak < digits.length) {
        const swapped = String((Number(digits[weak]) + rng.int(1, 8)) % 10);
        read.plate = `${digits.slice(0, weak)}${swapped}${digits.slice(weak + 1)}|${rest.join("|")}`;
      }
    } else if (rng.chance(0.4)) {
      weak = rng.int(0, entry.plate.replace(/\|/g, "").length - 1);
    }
    read.hit = true;
    const camera = cameras.find((c) => c.id === read.cameraId)!;
    const alert = alertFromRead(rng, `al-${String(i + 1).padStart(4, "0")}`, read, entry, camera, weak);
    const decided = now - read.at > 3 * HOUR && i < 14;
    if (decided) {
      const action: ReviewAction = alert.matchScore < 1
        ? rng.weighted([["reject", 7], ["escalate", 3]] as const)
        : rng.weighted([["approve", 8], ["escalate", 2]] as const);
      alert.status = ({ approve: "approved", reject: "rejected", escalate: "escalated" } as const)[action];
      alert.decision = {
        action, justification: rng.pick(DECISION_TEXT[action]), reviewer: REVIEWER_BY_CITY[camera.cityId].username,
        decidedAt: iso(read.at + rng.int(2, 25) * 60_000), auditId: "",
      };
    }
    return alert;
  });
}

// ---- evidence chain ------------------------------------------------------------------

export async function appendEvidence(db: Pick<MockDb, "evidence" | "privateKey" | "rng" | "cameras">, read: Read): Promise<EvidenceRecord> {
  const prev = db.evidence[db.evidence.length - 1];
  const seq = (prev?.seq ?? 0) + 1;
  const payload = {
    readId: read.id,
    cameraId: read.cameraId,
    capturedAt: iso(read.at),
    plateDigest: await sha256Hex(`plate:${read.plate}`),
    frameSha256: db.rng.hex(64),
    modelVersion: MODEL_VERSION,
  };
  const prevHash = prev?.hash ?? GENESIS;
  const hash = await linkHash(prevHash, payload);
  const record: EvidenceRecord = {
    id: `ev-${String(seq).padStart(4, "0")}`,
    seq,
    payload,
    prevHash,
    hash,
    signature: db.privateKey ? await sign(db.privateKey, hash) : null,
    keyId: KEY_ID,
    plateMasked: maskPlate(read.plate),
    cameraName: db.cameras.find((c) => c.id === read.cameraId)?.name ?? read.cameraId,
  };
  db.evidence.push(record);
  read.evidenceId = record.id;
  return record;
}

// ---- audit chain ---------------------------------------------------------------------

export interface AuditDraft {
  at: number;
  actor: string;
  role: Role | "system";
  action: AuditAction;
  target: string;
  justification: string | null;
  ip: string;
}

export async function appendAudit(audit: AuditEntry[], draft: AuditDraft): Promise<AuditEntry> {
  const prev = audit[audit.length - 1];
  const seq = (prev?.seq ?? 0) + 1;
  const content = { ...draft, at: iso(draft.at) };
  const prevHash = prev?.hash ?? GENESIS;
  const entry: AuditEntry = { id: `au-${String(seq).padStart(6, "0")}`, seq, ...content, prevHash, hash: await linkHash(prevHash, content) };
  audit.push(entry);
  return entry;
}

/** The fields an audit hash covers (everything except id/seq/prevHash/hash). */
export function auditPayload(e: AuditEntry) {
  return { at: e.at, actor: e.actor, role: e.role, action: e.action, target: e.target, justification: e.justification, ip: e.ip };
}

export function staffIp(rng: Rng): string {
  return `10.20.${rng.int(1, 4)}.${rng.int(10, 240)}`;
}

const REVEAL_REASONS = [
  "Security desk request: vehicle blocking fire lane at the depot.",
  "Follow-up on escalated alert for supervisor review.",
  "Visitor dispute about a parking penalty, ticket ref in case notes.",
  "Incident report: damage to barrier, identify vehicle.",
];

function auditDrafts(rng: Rng, now: number, alerts: Alert[], reads: Read[], imports: WatchlistImport[]): AuditDraft[] {
  const drafts: AuditDraft[] = [];
  const start = now - 7 * DAY;
  const staff = USERS.map((u) => [u.username, u.role] as const);
  const searchers = ["analyst.north", "demo.admin"];

  for (let day = start; day < now; day += DAY) {
    for (const [actor, role] of staff) {
      for (let i = 0; i < rng.int(1, 2); i++) {
        drafts.push({ at: day + rng.int(6, 20) * HOUR + rng.int(0, HOUR), actor, role, action: "auth.login", target: "session", justification: null, ip: staffIp(rng) });
      }
    }
    drafts.push({ at: day + 3 * HOUR, actor: "svc.retention", role: "system", action: "retention.purge", target: `${rng.int(640, 910)} non-hit reads older than 30 days`, justification: "Retention policy RP-30", ip: "10.20.0.5" });
    drafts.push({ at: day + rng.int(9, 17) * HOUR, actor: "demo.auditor", role: "auditor", action: "evidence.verify", target: "evidence chain", justification: "Daily integrity check", ip: staffIp(rng) });
    for (let i = 0; i < rng.int(5, 10); i++) {
      drafts.push({ at: day + rng.int(0, DAY - 1), actor: rng.pick(searchers), role: "analyst", action: "plate.search", target: `filters: plate~${rng.int(3, 9)} chars`, justification: null, ip: staffIp(rng) });
    }
    if (rng.chance(0.6)) {
      drafts.push({ at: day + rng.int(8, 19) * HOUR, actor: "analyst.north", role: "analyst", action: "plate.reveal", target: rng.pick(reads).id, justification: rng.pick(REVEAL_REASONS), ip: staffIp(rng) });
    }
  }
  for (let t = start; t < now; t += HOUR) {
    if (rng.chance(0.18)) {
      const [actor, role] = rng.pick(staff);
      drafts.push({ at: t + rng.int(0, HOUR - 1), actor, role, action: "auth.login_failed", target: "session", justification: null, ip: staffIp(rng) });
    }
  }
  // one password-spraying burst from an outside address, 9 hours ago
  const burst = now - 9 * HOUR;
  for (let i = 0; i < 26; i++) {
    drafts.push({ at: burst + i * rng.int(8, 30) * 1000, actor: rng.pick(["admin", "root", "operator", "demo.admin"]), role: "analyst", action: "auth.login_failed", target: "session", justification: null, ip: `203.0.113.${rng.int(20, 60)}` });
  }
  for (const a of alerts) {
    if (!a.decision) continue;
    const reviewer = USERS.find((u) => u.username === a.decision!.reviewer)!;
    drafts.push({ at: Date.parse(a.decision.decidedAt), actor: reviewer.username, role: reviewer.role, action: `alert.${a.decision.action}`, target: a.id, justification: a.decision.justification, ip: staffIp(rng) });
  }
  for (const imp of imports) {
    drafts.push({
      at: Date.parse(imp.importedAt), actor: imp.importedBy, role: "admin", action: "watchlist.import",
      target: `${imp.listId} v${imp.version}: ${imp.fileName}`,
      justification: `${imp.rowsAccepted} accepted, ${imp.rowsRejected} rejected; sha256 ${imp.sha256}`, ip: staffIp(rng),
    });
  }
  drafts.push({ at: now - 4 * DAY, actor: "demo.admin", role: "admin", action: "audit.export", target: "1,204 rows (CSV)", justification: "Quarterly access review", ip: staffIp(rng) });
  drafts.push({ at: now - 5 * DAY, actor: "demo.admin", role: "admin", action: "user.update", target: "analyst.north", justification: "role=analyst; cities=city-local,city-north", ip: staffIp(rng) });
  return drafts.filter((d) => d.at <= now).sort((a, b) => a.at - b.at);
}

// ---- security ------------------------------------------------------------------------

function makeSecurity(rng: Rng, now: number, audit: AuditEntry[]): SecurityOverview {
  const kinds: [StreamEvent["kind"], Priority, string, boolean][] = [
    ["replay", "high", "Frame batch re-sent with a used nonce; rejected by the ingest gateway.", true],
    ["tamper", "critical", "Frame signature did not verify; frame quarantined.", true],
    ["frame_gap", "medium", "No frames for 4 min; camera heartbeat missed.", false],
    ["clock_skew", "medium", "Camera clock 41 s ahead of NTP; timestamps flagged.", false],
    ["cert_mismatch", "high", "TLS client certificate presented by the camera did not match its enrolment; connection refused.", true],
  ];
  const streamCams = ["cam-n1", "cam-n2", "cam-s1"];
  const streamEvents: StreamEvent[] = Array.from({ length: 22 }, (_, i) => {
    const [kind, severity, detail, blocked] = rng.weighted([[kinds[0], 5], [kinds[1], 2], [kinds[2], 6], [kinds[3], 4], [kinds[4], 3]] as const);
    return { id: `se-${String(i + 1).padStart(3, "0")}`, at: iso(now - rng.int(5, 47 * 60) * 60_000), kind, severity, detail, blocked, cameraId: rng.pick(streamCams) };
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const authTimeline = Array.from({ length: 48 }, (_, i) => {
    const from = Math.floor(now / HOUR) * HOUR - (47 - i) * HOUR;
    const inHour = (at: string) => Date.parse(at) >= from && Date.parse(at) < from + HOUR;
    return {
      hour: iso(from),
      failedLogins: audit.filter((e) => e.action === "auth.login_failed" && inHour(e.at)).length,
      anomalies: streamEvents.filter((e) => inHour(e.at) && e.severity !== "medium").length,
    };
  });

  return {
    illustrative: true,
    techniques: [
      { id: "T1557", name: "Adversary-in-the-Middle", framework: "ATT&CK", tactic: "Credential Access / Collection", status: "mitigated", control: "Mutual TLS between cameras and ingest" },
      { id: "T1565.002", name: "Transmitted Data Manipulation", framework: "ATT&CK", tactic: "Impact", status: "mitigated", control: "Per-frame signatures, nonce replay check" },
      { id: "T1110", name: "Brute Force", framework: "ATT&CK", tactic: "Credential Access", status: "monitored", control: "Rate limiting, lockout, alert on spray patterns" },
      { id: "T1078", name: "Valid Accounts", framework: "ATT&CK", tactic: "Initial Access", status: "monitored", control: "RBAC, city scoping, MFA (planned), anomaly review" },
      { id: "T1552", name: "Unsecured Credentials", framework: "ATT&CK", tactic: "Credential Access", status: "mitigated", control: "Camera passwords write-only, AES-GCM at rest, keys in KMS (planned)" },
      { id: "T1040", name: "Network Sniffing", framework: "ATT&CK", tactic: "Discovery", status: "mitigated", control: "RTSPS and TLS 1.3, no plaintext plates in transit" },
      { id: "T1070", name: "Indicator Removal", framework: "ATT&CK", tactic: "Defense Evasion", status: "mitigated", control: "Hash-chained, append-only audit log" },
      { id: "T1499", name: "Endpoint Denial of Service", framework: "ATT&CK", tactic: "Impact", status: "gap", control: "Ingest rate limits not yet load-tested" },
      { id: "AML.T0043", name: "Craft Adversarial Data", framework: "ATLAS", tactic: "ML Attack Staging", status: "monitored", control: "Adversarial training, input sanity checks" },
      { id: "AML.T0015", name: "Evade ML Model", framework: "ATLAS", tactic: "Defense Evasion", status: "monitored", control: "Human confirms every watchlist match" },
    ],
    stride: [
      ["Camera → ingest", ["mitigated", "mTLS device certificates"], ["mitigated", "Signed frames + nonces"], ["mitigated", "Signed capture records"], ["mitigated", "RTSPS / TLS 1.3"], ["monitored", "Heartbeat + gap alerts"], ["mitigated", "Cameras have send-only credentials"]],
      ["Inference pipeline", ["mitigated", "Pinned model hash (SHA-256)"], ["mitigated", "Weights verified at load"], ["monitored", "Model version in every record"], ["mitigated", "Plates digested in evidence"], ["gap", "No GPU queue back-pressure yet"], ["mitigated", "Runs as unprivileged service"]],
      ["API & dashboard", ["mitigated", "Session auth (MFA planned)"], ["mitigated", "Server-side validation, CSV re-validated"], ["mitigated", "Every action audited"], ["mitigated", "Masked plates, city scoping"], ["monitored", "Rate limiting"], ["mitigated", "RBAC enforced server-side"]],
      ["Evidence store", ["mitigated", "Ed25519 signing key per deployment"], ["mitigated", "Hash chain + signatures"], ["mitigated", "Chain of custody"], ["mitigated", "Encrypted at rest"], ["monitored", "Storage quotas"], ["mitigated", "Write-once bucket policy"]],
      ["Audit log", ["mitigated", "Actor from session, not request body"], ["mitigated", "Hash chain"], ["mitigated", "Append-only"], ["monitored", "Auditor role only"], ["monitored", "Log volume alerts"], ["gap", "Admin can still rotate log storage"]],
    ].flatMap(([component, ...cells]) =>
      (["Spoofing", "Tampering", "Repudiation", "Information disclosure", "Denial of service", "Elevation of privilege"] as const).map((category, i) => {
        const [status, control] = cells[i] as [SecurityOverview["stride"][number]["status"], string];
        return { category, component: component as string, status, control };
      }),
    ),
    adversarial: [
      { attack: "Adversarial patch on plate", before: 0.62, after: 0.11, defense: "Adversarial training + patch detector" },
      { attack: "Digit sticker (3 → 8)", before: 0.48, after: 0.14, defense: "Per-character confidence gate + human review" },
      { attack: "FGSM perturbation (digital)", before: 0.71, after: 0.09, defense: "Input smoothing + adversarial training" },
      { attack: "IR glare flooding", before: 0.37, after: 0.18, defense: "Exposure checks, frame rejected when saturated" },
      { attack: "Stream replay", before: 0.9, after: 0.0, defense: "Signed frames with nonces" },
    ],
    streamEvents,
    authTimeline,
  };
}

// ---- model metrics (illustrative) ----------------------------------------------------

function makeModels(rng: Rng): ModelMetrics {
  const det = (p: number, r: number, m: number) => ({ precision: p, recall: r, map50: m, n: rng.int(180, 900) });
  const ocr = (c: number, pl: number) => ({ charAccuracy: c, plateAccuracy: pl, n: rng.int(300, 1500) });
  const byType = <T,>(f: (k: number) => T) => Object.fromEntries(PLATE_TYPES.map((t, i) => [t, f(i)])) as Record<PlateType, T>;
  return {
    illustrative: true,
    detector: {
      version: "det-yolo11n-0.3",
      bySet: {
        synthetic: {
          label: "Synthetic Moroccan plates pasted on scenes (generated)",
          byCondition: { day: det(0.982, 0.975, 0.988), night: det(0.951, 0.932, 0.957), rain: det(0.938, 0.921, 0.944), blur: det(0.912, 0.887, 0.919) },
          byPlateType: byType((i) => det(0.97 - i * 0.006, 0.962 - i * 0.008, 0.975 - i * 0.007)),
        },
        real: {
          label: "CCPD2019 (public dataset, Chinese plates), detector only",
          byCondition: { day: det(0.961, 0.948, 0.966), night: det(0.902, 0.874, 0.905), rain: det(0.889, 0.861, 0.893), blur: det(0.842, 0.803, 0.851) },
          byPlateType: null,
        },
      },
    },
    ocr: {
      version: "ocr-crnn-0.2",
      bySet: {
        synthetic: {
          label: "Synthetic Moroccan plates (generated, held-out plate numbers)",
          byCondition: { day: ocr(0.991, 0.962), night: ocr(0.974, 0.901), rain: ocr(0.966, 0.884), blur: ocr(0.948, 0.823) },
          byPlateType: byType((i) => ocr(0.986 - i * 0.004, 0.948 - i * 0.012)),
        },
        // No consented real Moroccan plate images yet, so there is no honest real-test number.
        real: null,
      },
    },
  };
}

// ---- assemble ------------------------------------------------------------------------

export async function buildDb(seed: number, now: number): Promise<MockDb> {
  const rng = new Rng(seed);
  const cameras = makeCameras(rng, now);
  const reads = makeReads(rng, now, cameras);
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  for (const c of cameras) c.readsToday = reads.filter((r) => r.cameraId === c.id && r.at >= dayStart).length;

  const { entries, imports } = await seedWatchlists(rng, now);
  const alerts = makeAlerts(rng, now, reads, cameras, entries);

  const key = await generateSigningKey();
  const signer = { evidence: [] as EvidenceRecord[], privateKey: key?.keyPair.privateKey ?? null, rng, cameras };

  // Sign the alert captures plus the most recent reads, in capture order.
  const alertReads = new Set(alerts.map((a) => a.readId));
  for (const r of reads.filter((x) => alertReads.has(x.id) || x.at > now - 25 * 60_000)) await appendEvidence(signer, r);
  for (const a of alerts) a.evidenceId = reads.find((r) => r.id === a.readId)!.evidenceId!;

  // The deliberately tampered demo record: content edited AFTER it was hashed and signed.
  const victim = signer.evidence[Math.floor(signer.evidence.length / 2)];
  victim.payload = { ...victim.payload, capturedAt: iso(Date.parse(victim.payload.capturedAt) - 12 * 60_000) };
  victim.demoNote = "Demo: this record's capture time was moved back 12 minutes after signing, to show tamper detection.";

  const audit: AuditEntry[] = [];
  for (const d of auditDrafts(rng, now, alerts, reads, imports)) {
    const entry = await appendAudit(audit, d);
    const alert = alerts.find((a) => a.id === d.target && a.decision);
    if (alert?.decision) alert.decision.auditId = entry.id;
  }

  return {
    now, cities: structuredClone(CITIES), lists: structuredClone(LISTS),
    entries, imports, reads, alerts, audit, ...signer,
    publicKey: key?.publicKeyB64 ?? null,
    security: makeSecurity(rng, now, audit),
    models: makeModels(rng),
  };
}
