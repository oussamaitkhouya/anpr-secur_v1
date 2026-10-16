/*
 * Types shared by the mock and the real API. They mirror the future FastAPI response models
 * (src/anpr/api), so swapping the implementation in client.ts needs no UI change.
 * Times are ISO-8601 strings in UTC.
 */
import type { Role } from "../lib/rbac";

export type PlateType = "private" | "taxi" | "temporary" | "police" | "government" | "diplomatic";
export type Condition = "day" | "night" | "rain" | "blur";

/** Canonical Moroccan plate: number|letter|region, e.g. 12345|ب|6. */
export interface Plate {
  number: string;
  letter: string;
  region: number;
}

/**
 * Who is calling: only an opaque session token, held in memory by the browser. The server
 * (or the mock) resolves it to a user, so role and allowed cities always come from the server.
 */
/** Who is calling. With cookie sessions the token is a fixed marker, never a credential. */
export interface RequestContext {
  token: string;
}

// ---- users and sessions --------------------------------------------------------------

/** An account as the accounts API returns it. There is never a password or hash field. */
export interface User {
  id: string;
  username: string;
  name: string;
  role: Role;
  /** cities whose cameras, reads and alerts this user may see (Analysts; Admins see all) */
  allowedCityIds: string[];
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string | null;
  /** set by GET /users: whether the caller may edit this account */
  manageable?: boolean;
}

export interface Session {
  token: string;
  user: User;
  expiresAt: string;
}

export interface UserCreate {
  username: string;
  name: string;
  role: Role;
  password: string;
  allowedCityIds: string[];
}

export interface UserPatch {
  name?: string;
  role?: Role;
  allowedCityIds?: string[];
  active?: boolean;
}

// ---- cities and cameras --------------------------------------------------------------

export interface City {
  id: string;
  name: string;
  /** fictional city seeded for the demo */
  demo: boolean;
}

export type CameraStatus = "online" | "degraded" | "offline";
export type TlsStatus = "valid" | "expiring" | "expired";
export type SourceType = "browser-webcam" | "rtsp" | "file";

/**
 * A camera as the API returns it. Credentials are write-only: the response only says whether
 * they are set. There is no username or password field, and `endpoint` never contains them.
 */
export interface Camera {
  id: string;
  cityId: string;
  cityName: string;
  name: string;
  sourceType: SourceType;
  /** host/path without credentials, e.g. rtsps://10.0.4.21:322/stream1; empty for the webcam */
  endpoint: string;
  status: CameraStatus;
  credentialsSet: boolean;
  lastFrameAt: string | null;
  tlsStatus: TlsStatus | "not_applicable";
  uptimePct: number; // last 30 days
  latencyMs: number; // capture -> validated read, p50
  readsToday: number;
  demo: boolean;
}

/** Create or edit a camera. Credentials are set separately, with replaceCredentials. */
export interface CameraInput {
  id?: string;
  cityId: string;
  name: string;
  sourceType: SourceType;
  endpoint: string;
}

export interface CameraCredentials {
  username: string;
  password: string;
}

export interface ConnectionTest {
  ok: boolean;
  latencyMs: number;
  message: string;
}

// ---- reads, search, reveal -----------------------------------------------------------

export interface CharConfidence {
  char: string;
  confidence: number; // 0..1
}

/** A plate read as the search endpoint returns it: the plate is masked server-side. */
export interface SearchResult {
  readId: string;
  plateMasked: string;
  plateType: PlateType;
  cameraId: string;
  cameraName: string;
  capturedAt: string;
  confidence: number;
  condition: Condition;
  watchlistHit: boolean;
  evidenceId: string | null;
}

export interface SearchFilters {
  plate?: string;
  from?: string;
  to?: string;
  cameraId?: string;
  plateType?: PlateType;
}

export interface RevealResult {
  readId: string;
  plate: string; // canonical, unmasked
  auditId: string;
}

// ---- alerts (human-in-the-loop) ------------------------------------------------------

export type AlertStatus = "pending" | "approved" | "rejected" | "escalated";
export type ReviewAction = "approve" | "reject" | "escalate";
export type Priority = "critical" | "high" | "medium";

export type WatchlistReason = "stolen" | "wanted" | "other";
export type WatchlistEntryStatus = "active" | "expired" | "removed";

export interface WatchlistList {
  id: string;
  name: string;
}

export interface WatchlistEntry {
  id: string;
  listId: string;
  plate: string; // canonical
  reason: WatchlistReason;
  caseRef: string;
  source: string;
  addedAt: string;
  expiresAt: string | null;
  status: WatchlistEntryStatus;
  /** id of the import that added it */
  importId: string;
}

export interface WatchlistEntryInput {
  plate: string;
  reason: WatchlistReason;
  color?: string;
  make?: string;
  model?: string;
  vehicleType?: string;
  caseRef?: string;
  source?: string;
  expiresAt?: string;
}

export interface WatchlistImport {
  id: string;
  listId: string;
  fileName: string;
  sha256: string;
  rowsTotal: number;
  rowsAccepted: number;
  rowsRejected: number;
  importedBy: string;
  importedAt: string;
  /** 1, 2, 3... per list */
  version: number;
}

export interface WatchlistImportRequest {
  listId: string;
  fileName: string;
  csvText: string;
}

export interface Alert {
  id: string;
  readId: string;
  plate: string; // canonical OCR output
  plateType: PlateType;
  confidence: number;
  chars: CharConfidence[];
  cameraId: string;
  cameraName: string;
  cityId: string;
  cityName: string;
  capturedAt: string;
  condition: Condition;
  matchScore: number; // OCR text vs watchlist plate, 0..1
  watchlistEntry: WatchlistEntry;
  evidenceId: string;
  status: AlertStatus;
  decision: { action: ReviewAction; justification: string; reviewer: string; decidedAt: string; auditId: string } | null;
}

// ---- evidence vault ------------------------------------------------------------------

/** The signed content of a capture. Holds a digest of the plate, never the plate itself. */
export interface EvidencePayload {
  readId: string;
  cameraId: string;
  capturedAt: string;
  plateDigest: string;
  frameSha256: string;
  modelVersion: string;
}

export interface EvidenceRecord {
  id: string;
  seq: number; // position in the hash chain, from 1
  payload: EvidencePayload;
  prevHash: string;
  hash: string; // sha256(prevHash + "\n" + canonicalJson(payload))
  signature: string | null; // Ed25519 over `hash`, base64; null if the browser lacks Ed25519
  keyId: string;
  plateMasked: string;
  cameraName: string;
  /** mock only: explains a record altered on purpose for the demo */
  demoNote?: string;
}

export interface EvidenceList {
  records: EvidenceRecord[];
  publicKey: string | null; // raw Ed25519 public key, base64
  keyId: string;
  algorithm: "Ed25519";
}

export interface CustodyEvent {
  at: string;
  actor: string;
  action: string;
}

export interface EvidenceDetail {
  record: EvidenceRecord;
  plateType: PlateType;
  condition: Condition;
  confidence: number;
  custody: CustodyEvent[];
  /** seed for the generated placeholder art (no real photos exist) */
  artSeed: number;
}

// ---- audit ---------------------------------------------------------------------------

export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "alert.approve"
  | "alert.reject"
  | "alert.escalate"
  | "plate.reveal"
  | "plate.search"
  | "evidence.verify"
  | "audit.export"
  | "watchlist.add"
  | "settings.update"
  | "retention.purge"
  | "camera.start"
  | "camera.stop"
  | "auth.logout"
  | "camera.create"
  | "camera.update"
  | "camera.credentials_replace"
  | "camera.test"
  | "watchlist.import"
  | "watchlist.remove"
  | "watchlist.expire"
  | "user.update";

export interface AuditEntry {
  id: string;
  seq: number;
  at: string;
  actor: string;
  role: Role | "system";
  action: AuditAction;
  target: string;
  justification: string | null;
  ip: string;
  prevHash: string;
  hash: string;
}

export interface AuditFilters {
  q?: string;
  action?: AuditAction;
  actor?: string;
  from?: string;
  to?: string;
}

// ---- metrics -------------------------------------------------------------------------

export type IntegrityStatus = "verified" | "tamper_detected" | "unknown";

export interface OverviewMetrics {
  platesToday: number;
  watchlistHits: number;
  avgLatencyMs: number;
  ocrAccuracy: number; // 0..1
  activeCameras: number;
  totalCameras: number;
  integrity: { status: IntegrityStatus; checkedLinks: number; brokenLinks: number };
  /** 14 daily points, oldest first, for the KPI sparklines */
  sparklines: Record<"platesToday" | "watchlistHits" | "avgLatencyMs" | "ocrAccuracy" | "activeCameras", number[]>;
  hourly: { hour: string; reads: number; hits: number }[];
  byPlateType: { type: PlateType; count: number }[];
}

export type TestSet = "synthetic" | "real";

export interface DetectorScore {
  precision: number;
  recall: number;
  map50: number;
  n: number;
}

export interface OcrScore {
  charAccuracy: number;
  plateAccuracy: number;
  n: number;
}

export interface SetScores<T> {
  /** what the test set is, e.g. "Synthetic Moroccan plates (generated)" */
  label: string;
  byCondition: Record<Condition, T>;
  /** null when the set has no Moroccan plate types (e.g. a public foreign dataset) */
  byPlateType: Record<PlateType, T> | null;
}

export interface ModelMetrics {
  /** true while the numbers are illustrative mock values, not results of a real run */
  illustrative: boolean;
  detector: { version: string; bySet: Record<TestSet, SetScores<DetectorScore> | null> };
  ocr: { version: string; bySet: Record<TestSet, SetScores<OcrScore> | null> };
}

// ---- security ------------------------------------------------------------------------

export type ControlStatus = "mitigated" | "monitored" | "gap";

export interface ThreatTechnique {
  id: string; // ATT&CK (Txxxx) or ATLAS (AML.Txxxx) technique id
  name: string;
  framework: "ATT&CK" | "ATLAS";
  tactic: string;
  status: ControlStatus;
  control: string;
}

export type StrideCategory = "Spoofing" | "Tampering" | "Repudiation" | "Information disclosure" | "Denial of service" | "Elevation of privilege";

export interface StrideCell {
  category: StrideCategory;
  component: string;
  status: ControlStatus;
  control: string;
}

export interface AdversarialResult {
  attack: string;
  before: number; // attack success rate 0..1, no defense
  after: number; // with defense
  defense: string;
}

export type StreamEventKind = "replay" | "tamper" | "frame_gap" | "clock_skew" | "cert_mismatch";

export interface StreamEvent {
  id: string;
  at: string;
  kind: StreamEventKind;
  cameraId: string;
  severity: Priority;
  detail: string;
  blocked: boolean;
}

export interface SecurityOverview {
  /** true while the adversarial numbers are illustrative, not measured */
  illustrative: boolean;
  techniques: ThreatTechnique[];
  stride: StrideCell[];
  adversarial: AdversarialResult[];
  streamEvents: StreamEvent[];
  /** hourly buckets for the last 48 h, oldest first */
  authTimeline: { hour: string; failedLogins: number; anomalies: number }[];
}

// ---- settings, notifications ---------------------------------------------------------

export interface RetentionPolicy {
  nonHitReadsDays: number;
  hitReadsDays: number;
  auditLogDays: number;
  evidenceDays: number;
  lastPurge: { at: string; deleted: number };
  nextPurgeAt: string;
}

export interface Notification {
  id: string;
  at: string;
  title: string;
  body: string;
  severity: Priority;
  href: string;
}

// ---- live camera ---------------------------------------------------------------------

/** One JPEG frame from the browser camera. Only ever held in memory. */
export interface CameraFrame {
  sessionId: string;
  cameraId: string;
  seq: number;
  capturedAt: string;
  width: number;
  height: number;
  jpeg: Blob;
}

export interface FrameAck {
  sessionId: string;
  seq: number;
  /** round trip, ms */
  latencyMs: number;
}

/** A plate found in a frame. Box coordinates are fractions (0..1) of the frame size. */
export interface Detection {
  id: string;
  frameSeq: number;
  box: { x: number; y: number; w: number; h: number };
  plate: string; // canonical
  confidence: number;
  chars: CharConfidence[];
  /** set when the plate is on the watchlist; a human must still review it */
  watchlistMatch: WatchlistEntry | null;
  /** the pending alert this match created (or joined, if one exists from the last minute) */
  alertId: string | null;
}

export type CameraEventKind = "start" | "stop";

// ---- the API surface -----------------------------------------------------------------

/**
 * Accounts: the real FastAPI service on the local SQLite database (src/anpr/api/app.py).
 * Always HTTP, even while the rest of the data is mock.
 */
/** Step 1 of sign-in: the password was right; a TOTP code is always required next. */
export interface LoginStep {
  mfaEnrolled: boolean;
}

/** First sign-in only: the TOTP secret to add to an authenticator app. Shown once. */
export interface MfaSetup {
  otpauthUri: string;
  secret: string;
}

/**
 * The PostgreSQL accounts API (/api/v1/auth, /api/v1/admin/users). The session is in httpOnly
 * cookies, so `ctx` is accepted for symmetry with AnprApi but carries no secret.
 */
export interface AccountsApi {
  login(username: string, password: string): Promise<LoginStep>;
  mfaSetup(): Promise<MfaSetup>;
  mfaVerify(code: string): Promise<User>;
  logout(ctx: RequestContext): Promise<void>;
  me(ctx: RequestContext): Promise<User>;
  changeOwnPassword(ctx: RequestContext, password: string): Promise<void>;
  listUsers(ctx: RequestContext): Promise<User[]>;
  createUser(ctx: RequestContext, input: UserCreate): Promise<User>;
  updateUser(ctx: RequestContext, userId: string, patch: UserPatch): Promise<User>;
  resetPassword(ctx: RequestContext, userId: string, password: string): Promise<void>;
  deleteUser(ctx: RequestContext, userId: string): Promise<void>;
}

/** Operational data (cameras, alerts, evidence...). Mock today, FastAPI later. */
export interface AnprApi {
  getOverview(ctx: RequestContext): Promise<OverviewMetrics>;
  getAlerts(ctx: RequestContext): Promise<Alert[]>;
  reviewAlert(ctx: RequestContext, alertId: string, action: ReviewAction, justification: string): Promise<Alert>;
  /** push channel for new alerts (SSE/WebSocket in the real API); returns an unsubscribe function */
  subscribeAlerts(ctx: RequestContext, onAlert: (alert: Alert) => void): () => void;
  searchPlates(ctx: RequestContext, filters: SearchFilters): Promise<SearchResult[]>;
  revealPlate(ctx: RequestContext, readId: string, reason: string): Promise<RevealResult>;
  getEvidence(ctx: RequestContext): Promise<EvidenceList>;
  getEvidenceDetail(ctx: RequestContext, id: string): Promise<EvidenceDetail>;
  recordChainVerification(ctx: RequestContext, summary: { checked: number; broken: number }): Promise<AuditEntry>;
  getAudit(ctx: RequestContext, filters: AuditFilters): Promise<AuditEntry[]>;
  recordAuditExport(ctx: RequestContext, rows: number): Promise<AuditEntry>;
  getCities(ctx: RequestContext): Promise<City[]>;
  getCameras(ctx: RequestContext): Promise<Camera[]>;
  getCamera(ctx: RequestContext, id: string): Promise<Camera>;
  saveCamera(ctx: RequestContext, input: CameraInput): Promise<Camera>;
  /** write-only: the password is never returned, logged or stored in the clear */
  replaceCredentials(ctx: RequestContext, cameraId: string, credentials: CameraCredentials): Promise<Camera>;
  testConnection(ctx: RequestContext, cameraId: string): Promise<ConnectionTest>;

  getWatchlists(ctx: RequestContext): Promise<{ lists: WatchlistList[]; entries: WatchlistEntry[] }>;
  getWatchlistImports(ctx: RequestContext): Promise<WatchlistImport[]>;
  /** the server validates every row again; client-side validation is only a preview */
  importWatchlist(ctx: RequestContext, request: WatchlistImportRequest): Promise<WatchlistImport>;
  addWatchlistEntry(ctx: RequestContext, listId: string, input: WatchlistEntryInput): Promise<WatchlistEntry>;
  setWatchlistEntryStatus(ctx: RequestContext, entryId: string, status: "removed" | "expired", reason: string): Promise<WatchlistEntry>;

  getModelMetrics(ctx: RequestContext): Promise<ModelMetrics>;
  getSecurity(ctx: RequestContext): Promise<SecurityOverview>;
  getRetention(ctx: RequestContext): Promise<RetentionPolicy>;
  getNotifications(ctx: RequestContext): Promise<Notification[]>;
  /** audit a camera start/stop; `detail` is e.g. the device label or the stop reason */
  recordCameraEvent(ctx: RequestContext, cameraId: string, kind: CameraEventKind, detail: string): Promise<AuditEntry>;
  /** hand one frame to the detector. The mock reads only its size and drops it. */
  sendFrame(ctx: RequestContext, frame: CameraFrame): Promise<FrameAck>;
  /** detections for the most recent frame of a camera session */
  getDetections(ctx: RequestContext, sessionId: string): Promise<Detection[]>;
}
