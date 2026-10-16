/*
 * Pure helpers for the camera registry UI: URL preview, wizard validation, health figures.
 * No React here, so every rule is unit-tested directly (logic.test.ts).
 */
import type { CameraDraft, CameraKind, CameraProtocol, CameraStatus, RegistryCamera } from "./types";

export const MASK = "••••••";

export const DEFAULT_PORTS: Partial<Record<CameraProtocol, number>> = { rtsps: 322, rtsp: 554, onvif: 80, mqtt: 1883 };

export const KIND_LABELS: Record<CameraKind, string> = {
  fixed_cctv: "Fixed CCTV", ptz: "PTZ", anpr_camera: "ANPR camera", radar: "Radar",
};
export const PROTOCOL_LABELS: Record<CameraProtocol, string> = {
  rtsps: "RTSPS", rtsp: "RTSP", onvif: "ONVIF", webhook: "Webhook", mqtt: "MQTT", file: "File",
};
export const STATUS_LABELS: Record<CameraStatus, string> = {
  online: "Online", offline: "Offline", degraded: "Degraded", maintenance: "Maintenance", unknown: "Not tested",
};

const SCHEMES: Partial<Record<CameraProtocol, string>> = { rtsps: "rtsps", rtsp: "rtsp", onvif: "http", mqtt: "mqtt" };

/**
 * What the camera worker will connect to, for display only. Credentials are ALWAYS shown as
 * MASK, whether or not they are set and whatever was typed: the real values never reach this
 * function. Returns null for protocols that have no URL (webhook, file) or without a host.
 */
export function assembledUrlPreview(input: { protocol: CameraProtocol; host?: string | null; port?: number | null; streamPath?: string | null; withCredentials: boolean }): string | null {
  const scheme = SCHEMES[input.protocol];
  const host = input.host?.trim();
  if (!scheme || !host) return null;
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = input.port ?? DEFAULT_PORTS[input.protocol];
  const path = input.streamPath?.trim() ? (input.streamPath.trim().startsWith("/") ? input.streamPath.trim() : `/${input.streamPath.trim()}`) : "";
  const auth = input.withCredentials ? `${MASK}:${MASK}@` : "";
  return `${scheme}://${auth}${hostPart}${port ? `:${port}` : ""}${path}`;
}

// ---- validation (mirrors src/anpr/api/schemas.py; the server re-checks everything) ----------

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const SECRET_KEYS = new Set(["user", "username", "usr", "password", "pass", "passwd", "pwd", "token", "auth", "key", "secret"]);

function isIPv4(v: string) {
  const parts = v.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 8 groups of 1-4 hex digits, "::" at most once, optionally an IPv4 tail (counts as 2 groups). */
function isIPv6(v: string) {
  const halves = v.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h ? h.split(":") : []));
  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (i === groups.length - 1 && g.includes(".")) {
      if (!isIPv4(g)) return false;
      count += 2;
    } else if (/^[0-9a-f]{1,4}$/i.test(g)) {
      count += 1;
    } else {
      return false;
    }
  }
  return halves.length === 2 ? count < 8 : count === 8;
}

export function hostProblem(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (!v) return "Enter a hostname or IP address.";
  if (v.includes("://")) return "Host only: remove the scheme (rtsp://…). Pick the protocol above.";
  if (v.includes("@")) return "Never put credentials in the host. Use the Credentials step.";
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  if (isIPv4(v) || isIPv6(v)) return null;
  if (/[/:?#\s\\]/.test(v)) return "Host only: put the port and stream path in their own fields.";
  const labels = v.replace(/\.$/, "").split(".");
  if (v.length > 253 || !labels.every((l) => LABEL.test(l))) return "Not a valid hostname or IP address.";
  if (/^\d+$/.test(labels[labels.length - 1])) return "Looks like an IP address but is not a valid one.";
  return null;
}

export function streamPathProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.includes("://") || v.includes("@")) return "Path only: no scheme and no credentials.";
  if (!v.startsWith("/")) return "Start the path with /";
  if (/\s/.test(v)) return "No spaces in the path.";
  const query = v.split("?")[1] ?? "";
  for (const pair of query.split("&")) {
    const key = decodeURIComponent(pair.split("=")[0] ?? "").toLowerCase();
    if (SECRET_KEYS.has(key)) return "Never put credentials in the query string. Use the Credentials step.";
  }
  return null;
}

/** The wizard's working copy. Numbers are strings while typing; parse() turns it into a body. */
export interface CameraForm {
  cityId: string;
  name: string;
  kind: CameraKind | "";
  district: string;
  streetAddress: string;
  latitude: string;
  longitude: string;
  viewDirectionDeg: string;
  lane: string;
  installedOn: string;
  owner: string;
  protocol: CameraProtocol;
  host: string;
  port: string;
  streamPath: string;
  vlan: string;
  firmwareVersion: string;
  notes: string;
  credUsername: string;
  credPassword: string;
}

export const STEPS = ["Identity", "Location", "Network and stream", "Credentials", "Review"] as const;
export type FormErrors = Partial<Record<keyof CameraForm, string>>;

export function emptyForm(cityId = ""): CameraForm {
  return {
    cityId, name: "", kind: "", district: "", streetAddress: "", latitude: "", longitude: "", viewDirectionDeg: "", lane: "",
    installedOn: "", owner: "", protocol: "rtsps", host: "", port: "", streamPath: "", vlan: "", firmwareVersion: "", notes: "",
    credUsername: "", credPassword: "",
  };
}

export function formFromCamera(c: RegistryCamera): CameraForm {
  const s = (v: string | number | null) => (v === null ? "" : String(v));
  return {
    cityId: c.cityId, name: c.name, kind: c.kind, district: s(c.district), streetAddress: s(c.streetAddress),
    latitude: String(c.latitude), longitude: String(c.longitude), viewDirectionDeg: s(c.viewDirectionDeg), lane: s(c.lane),
    installedOn: s(c.installedOn), owner: s(c.owner), protocol: c.protocol, host: s(c.host), port: s(c.port),
    streamPath: s(c.streamPath), vlan: s(c.vlan), firmwareVersion: s(c.firmwareVersion), notes: s(c.notes),
    credUsername: "", credPassword: "", // never prefilled: the API does not return credentials
  };
}

function numberIn(v: string, min: number, max: number, integer = false): boolean {
  if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
  const n = Number(v);
  return n >= min && n <= max && (!integer || Number.isInteger(n));
}

const NEEDS_HOST: CameraProtocol[] = ["rtsps", "rtsp", "onvif", "mqtt"];

export function validateStep(step: number, f: CameraForm, editing: boolean): FormErrors {
  const e: FormErrors = {};
  if (step === 0) {
    if (!f.cityId) e.cityId = "Choose a city.";
    if (!f.name.trim()) e.name = "Give the camera a name.";
    else if (f.name.trim().length > 80) e.name = "80 characters at most.";
    if (!f.kind) e.kind = "Choose the camera type.";
    if (f.owner.length > 80) e.owner = "80 characters at most.";
  }
  if (step === 1) {
    if (!numberIn(f.latitude, -90, 90)) e.latitude = "Latitude between -90 and 90.";
    if (!numberIn(f.longitude, -180, 180)) e.longitude = "Longitude between -180 and 180.";
    if (f.viewDirectionDeg && !numberIn(f.viewDirectionDeg, 0, 359, true)) e.viewDirectionDeg = "Whole degrees, 0 to 359.";
    if (f.lane.length > 20) e.lane = "20 characters at most.";
    if (f.streetAddress.length > 200) e.streetAddress = "200 characters at most.";
  }
  if (step === 2) {
    if (NEEDS_HOST.includes(f.protocol) || f.host.trim()) {
      const p = hostProblem(f.host);
      if (p) e.host = p;
    }
    if (f.port && !numberIn(f.port, 1, 65535, true)) e.port = "Port between 1 and 65535.";
    const sp = streamPathProblem(f.streamPath);
    if (sp) e.streamPath = sp;
    if (f.vlan && !numberIn(f.vlan, 1, 4094, true)) e.vlan = "VLAN between 1 and 4094.";
  }
  if (step === 3) {
    const either = f.credUsername || f.credPassword;
    if (either && !f.credUsername) e.credUsername = "Enter the username too.";
    if (either && !f.credPassword) e.credPassword = "Enter the password too.";
    if (f.credPassword.length > 256) e.credPassword = "256 characters at most.";
    void editing;
  }
  return e;
}

export function firstInvalidStep(f: CameraForm, editing: boolean): number | null {
  for (let i = 0; i < 4; i++) if (Object.keys(validateStep(i, f, editing)).length) return i;
  return null;
}

/** Form -> API body. Credentials are NOT part of it: they go to PUT /credentials separately. */
export function toDraft(f: CameraForm): CameraDraft {
  const opt = (v: string) => (v.trim() ? v.trim() : null);
  const int = (v: string) => (v.trim() ? Number(v) : null);
  return {
    cityId: f.cityId, name: f.name.trim(), kind: f.kind as CameraKind, district: opt(f.district), streetAddress: opt(f.streetAddress),
    latitude: Number(f.latitude), longitude: Number(f.longitude), viewDirectionDeg: int(f.viewDirectionDeg), lane: opt(f.lane),
    installedOn: opt(f.installedOn), owner: opt(f.owner), protocol: f.protocol, host: opt(f.host), port: int(f.port),
    streamPath: opt(f.streamPath), vlan: int(f.vlan), firmwareVersion: opt(f.firmwareVersion), notes: opt(f.notes),
  };
}

/** Rough strength hint for a camera password (cameras often limit the charset; hint only). */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!pw) return { score: 0, label: "" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 && classes >= 3) return { score: 3, label: "Strong" };
  if (pw.length >= 12 && classes >= 2) return { score: 2, label: "Fair" };
  return { score: 1, label: "Weak: use 12+ characters, mixed types" };
}

// ---- health -------------------------------------------------------------------------------

export type TlsState = "ok" | "expiring" | "expired" | "none";

export function tlsState(tlsNotAfter: string | null, now = Date.now()): TlsState {
  if (!tlsNotAfter) return "none";
  const days = (Date.parse(tlsNotAfter) - now) / 86_400_000;
  return days < 0 ? "expired" : days < 30 ? "expiring" : "ok";
}

export function daysUntil(iso: string, now = Date.now()): number {
  return Math.round((Date.parse(iso) - now) / 86_400_000);
}

export interface Summary {
  cities: number;
  cameras: number;
  online: number;
  onlinePct: number;
  degraded: number;
  offline: number;
  maintenance: number;
  credentialsMissing: number;
}

export function summarize(cameras: RegistryCamera[], cityCount: number): Summary {
  const count = (s: CameraStatus) => cameras.filter((c) => c.status === s).length;
  const online = count("online");
  return {
    cities: cityCount, cameras: cameras.length, online, onlinePct: cameras.length ? (online / cameras.length) * 100 : 0,
    degraded: count("degraded"), offline: count("offline"), maintenance: count("maintenance"),
    // webhook and file sources do not log in to anything, so they do not need credentials
    credentialsMissing: cameras.filter((c) => !c.credentialsSet && !["webhook", "file"].includes(c.protocol)).length,
  };
}

/** City health 0..1: online counts fully, degraded half, maintenance is excluded. */
export function cityHealth(cameras: RegistryCamera[]): number | null {
  const active = cameras.filter((c) => c.status !== "maintenance");
  if (!active.length) return null;
  return active.reduce((s, c) => s + (c.status === "online" ? 1 : c.status === "degraded" ? 0.5 : 0), 0) / active.length;
}

export function silentFor(c: RegistryCamera, now = Date.now()): number | null {
  return c.lastFrameAt ? Math.floor((now - Date.parse(c.lastFrameAt)) / 60_000) : null;
}
