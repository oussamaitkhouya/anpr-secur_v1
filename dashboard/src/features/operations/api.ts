/*
 * Alerts and overview, from the PostgreSQL API (src/anpr/api/routes/alerts.py). Real data only:
 * there is no demo fallback here. Pages refresh by polling (POLL_MS) until a push channel exists.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { v1 } from "../../api/v1";

export const POLL_MS = 15_000;
export const MIN_JUSTIFICATION = 20; // matches schemas.Justification on the server

export type AlertStatus = "pending" | "approved" | "rejected" | "escalated";
export type ReviewAction = "approve" | "reject" | "escalate";
export type WatchlistReason = "stolen" | "wanted" | "other";

export interface LiveAlert {
  id: string;
  detectionId: string;
  /** full OCR read for reviewers; masked (plateMasked) for every other role */
  plate: string;
  plateMasked: boolean;
  plateConfidence: number;
  chars: { char: string; confidence: number }[];
  cameraId: string;
  cameraName: string;
  cameraAddress: string | null;
  cameraLatitude: number | null;
  cameraLongitude: number | null;
  /** compass bearing the camera looks at, 0 = north */
  cameraViewDeg: number | null;
  cityId: string;
  cityName: string;
  observedAt: string;
  receivedAt: string;
  kind: "full_match" | "plate_only_mismatch_vehicle" | "fuzzy_match";
  matchScore: number;
  observedColor: string | null;
  observedMake: string | null;
  observedModel: string | null;
  evidenceSha256: string | null;
  /** [x, y, w, h] of the plate in the evidence frame, fractions of its size; null for older reads */
  plateBox: number[] | null;
  speedKmh: number | null;
  watchlistEntry: {
    id: string; listId: string; listName: string; plate: string; reason: WatchlistReason; caseRef: string | null; source: string | null;
    color: string | null; make: string | null; model: string | null; addedAt: string; expiresAt: string | null;
  };
  status: AlertStatus;
  createdAt: string;
  decision: { action: ReviewAction; justification: string; reviewer: string; decidedAt: string } | null;
}

export interface Overview {
  platesToday: number;
  watchlistHitsToday: number;
  pendingAlerts: number;
  avgLatencyMs: number | null;
  activeCameras: number;
  totalCameras: number;
  integrity: { ok: boolean; entries: number; firstBadSeq: number | null; reason: string | null } | null;
  daily: { day: string; reads: number; hits: number; latencyMs: number | null; camerasReporting: number }[];
  hourly: { hour: string; reads: number; hits: number }[];
}

export const opsKeys = { alerts: ["ops", "alerts"] as const, overview: ["ops", "overview"] as const };

export function useAlerts(enabled = true) {
  return useQuery({ queryKey: opsKeys.alerts, queryFn: () => v1.call<LiveAlert[]>("GET", "/alerts?limit=500"), refetchInterval: POLL_MS, enabled });
}

export function useOverview() {
  return useQuery({ queryKey: opsKeys.overview, queryFn: () => v1.call<Overview>("GET", "/overview"), refetchInterval: POLL_MS });
}

export function useReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: ReviewAction; justification: string }) =>
      v1.call<LiveAlert>("POST", `/alerts/${encodeURIComponent(v.id)}/review`, { action: v.action, justification: v.justification }),
    onSuccess: (updated) => {
      qc.setQueryData<LiveAlert[]>(opsKeys.alerts, (xs) => xs?.map((x) => (x.id === updated.id ? updated : x)));
      void qc.invalidateQueries({ queryKey: opsKeys.overview });
    },
  });
}

/**
 * The frame that raised the alert. The server re-hashes it against the SHA-256 stored at capture
 * (409 if it differs) and audits every view, so this is fetched only when a person opens the alert,
 * never polled. The browser hashes it again as an independent check.
 */
export async function fetchEvidence(alertId: string): Promise<Blob> {
  return (await v1.blob(`/alerts/${encodeURIComponent(alertId)}/evidence`)).blob;
}

/** Hex SHA-256 of the bytes, or null where Web Crypto is unavailable (non-secure context). */
export async function sha256Hex(blob: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const REASON_LABELS: Record<WatchlistReason, string> = { stolen: "Stolen vehicle", wanted: "Wanted vehicle", other: "Other" };
export const KIND_LABELS: Record<LiveAlert["kind"], string> = {
  full_match: "Exact plate match", plate_only_mismatch_vehicle: "Plate matches, vehicle differs", fuzzy_match: "Near match (possible misread)",
};

export function priorityOf(reason: WatchlistReason): "critical" | "high" | "medium" {
  return reason === "stolen" ? "critical" : reason === "wanted" ? "high" : "medium";
}

/** Short, readable form of a UUID for headings ("a1b2c3d4"). The full id stays in titles. */
export const shortId = (id: string) => id.slice(0, 8);
