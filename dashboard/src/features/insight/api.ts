/* Search, live reads, evidence, audit, security, models and account: the PostgreSQL API. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { v1 } from "../../api/v1";

export interface Read {
  detectionId: string;
  plateMasked: string;
  plateValid: boolean;
  plateConfidence: number;
  observedAt: string;
  receivedAt: string;
  sourceKind: string;
  cameraId: string;
  cameraName: string;
  cityId: string;
  cityName: string;
  observedColor: string | null;
  observedMake: string | null;
  observedModel: string | null;
  evidenceSha256: string | null;
  alerts: number;
}

export interface AuditRow {
  seq: number;
  ts: string;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  justification: string | null;
  ip: string;
  prevHash: string;
  hash: string;
  signature: string;
}

export interface Integrity { ok: boolean; entries: number; firstBadSeq: number | null; reason: string | null }

export interface SecurityCheck { id: string; title: string; status: "ok" | "warn" | "fail"; detail: string; count: number | null; area: string }
export interface SecurityOverview { checkedAt: string; checks: SecurityCheck[]; recentEvents: AuditRow[] }

export interface SystemSettings {
  appEnv: string; corsOrigins: string[]; accessTokenMinutes: number; refreshTokenDays: number; maxFailedLogins: number; lockoutMinutes: number;
  authRatePerMinute: number; cameraRatePerMinute: number; probeRatePerMinute: number; detectionRatePerMinute: number;
  maxCsvBytes: number; maxCsvRows: number; allowedCameraNetworks: string[]; dataKeyIds: string[]; activeDataKeyId: string; trustProxyHeaders: boolean;
}

export interface EpochMetrics { epoch: number; precision: number | null; recall: number | null; map50: number | null; map5095: number | null }
export interface LiveQuality {
  reads: number; validPlates: number; validShare: number | null; meanConfidence: number | null; lowConfidenceReads: number;
  alerts: Record<string, number>; confirmedShare: number | null;
}
export interface ModelsInfo {
  detector: { weights: string; available: boolean; run: string; epochs: EpochMetrics[]; final: EpochMetrics | null; plannedEpochs: number | null; baseModel: string | null; imageSize: number | null };
  ocr: { weights: string; available: boolean; metrics: Record<string, number> | null; epoch: number | null; sanityCheckOnly: boolean } | null;
  live: { last24h: LiveQuality; last7d: LiveQuality };
  note: string;
}

const q = (params: Record<string, string | number | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : "";
};
const id = encodeURIComponent;

export const useRecentReads = (cameraId?: string) =>
  useQuery({ queryKey: ["reads", cameraId ?? "all"], queryFn: () => v1.call<Read[]>("GET", `/detections/recent${q({ camera_id: cameraId, limit: 60 })}`), refetchInterval: 5000 });

export const searchPlates = (params: { q: string; since?: string; until?: string; cameraId?: string }) =>
  v1.call<Read[]>("GET", `/plates/search${q({ q: params.q, since: params.since, until: params.until, camera_id: params.cameraId })}`);

export const revealPlate = (detectionId: string, justification: string) =>
  v1.call<{ detectionId: string; plateCanonical: string | null; plateRaw: string }>("POST", `/plates/${id(detectionId)}/reveal`, { justification });

export const useEvidence = () => useQuery({ queryKey: ["evidence"], queryFn: () => v1.call<Read[]>("GET", "/evidence") });
export const verifyEvidence = (detectionId: string, sha256: string) =>
  v1.call<{ detectionId: string; recordedSha256: string; match: boolean }>("POST", `/evidence/${id(detectionId)}/verify`, { sha256 });

export const fetchAudit = (params: { action?: string; actorId?: string; since?: string; until?: string; beforeSeq?: number }) =>
  v1.call<AuditRow[]>("GET", `/audit${q({ action: params.action, actor_id: params.actorId, since: params.since, until: params.until, before_seq: params.beforeSeq, limit: 200 })}`);
export const verifyAudit = () => v1.call<Integrity>("GET", "/audit/verify");
export const recordExport = (rows: number, filters: string) => v1.call<void>("POST", "/audit/exports", { rows, filters });

export const useSecurity = () => useQuery({ queryKey: ["security"], queryFn: () => v1.call<SecurityOverview>("GET", "/security/overview") });
export const useSystemSettings = (enabled: boolean) =>
  useQuery({ queryKey: ["system-settings"], queryFn: () => v1.call<SystemSettings>("GET", "/system/settings"), enabled });
export const useModels = () => useQuery({ queryKey: ["models"], queryFn: () => v1.call<ModelsInfo>("GET", "/models") });

export const useChangePassword = () =>
  useMutation({ mutationFn: (v: { currentPassword: string; newPassword: string }) => v1.call<void>("POST", "/auth/password", v) });
export const useRevokeSessions = () => useMutation({ mutationFn: () => v1.call<void>("POST", "/auth/sessions/revoke") });

/** SHA-256 of a file, in the browser (the file is never uploaded). */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** CSV cell, safe to open in a spreadsheet: quotes escaped, formula prefixes neutralised. */
export function csvCell(value: string | number | null): string {
  let s = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
