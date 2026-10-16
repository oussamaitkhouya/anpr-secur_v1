import type { Priority, WatchlistEntry, WatchlistReason } from "../api/types";

export const REASON_LABELS: Record<WatchlistReason, string> = {
  stolen: "Stolen vehicle",
  wanted: "Wanted vehicle",
  other: "Other",
};

/** Review priority follows the reason: stolen first, then wanted. */
export function priorityOf(reason: WatchlistReason): Priority {
  return reason === "stolen" ? "critical" : reason === "wanted" ? "high" : "medium";
}

/** Active means it can still raise alerts: not removed, not expired by status or by date. */
export function isActive(entry: Pick<WatchlistEntry, "status" | "expiresAt">, now: number): boolean {
  return entry.status === "active" && (!entry.expiresAt || Date.parse(entry.expiresAt) > now);
}
