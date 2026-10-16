/** Watchlist reasons as shown in the UI, and the "expires soon" rule. */
import { CircleHelp, ShieldAlert, Siren, type LucideIcon } from "lucide-react";
import type { Entry, Reason } from "./api";

export const REASON_STYLE: Record<Reason, { label: string; color: string; icon: LucideIcon }> = {
  stolen: { label: "Stolen", color: "var(--gold)", icon: Siren },
  wanted: { label: "Wanted", color: "var(--danger)", icon: ShieldAlert },
  other: { label: "Other", color: "var(--accent-2)", icon: CircleHelp },
};

const WEEK_MS = 7 * 86_400_000;

/** An active entry whose expiry falls within the next 7 days. */
export function expiresSoon(e: Entry, now = Date.now()) {
  if (e.status !== "active" || !e.expiresAt) return false;
  const t = Date.parse(e.expiresAt);
  return t >= now && t - now <= WEEK_MS;
}

/** Days from now until the entry expires, or null if it never does or already has. */
export function daysUntilExpiry(e: Entry, now = Date.now()): number | null {
  if (e.status !== "active" || !e.expiresAt) return null;
  const ms = Date.parse(e.expiresAt) - now;
  return ms < 0 ? null : ms / 86_400_000;
}

/**
 * Where the search text appears in the plate's number, as [start, end) in that number, or null.
 * Spaces, dashes and "|" in the query are ignored, so "0781" and "40 781" both find 40781.
 */
export function numberHit(plateCanonical: string, query: string): [number, number] | null {
  const q = query.replace(/[\s|\-_/.]+/g, "");
  if (!/^\d+$/.test(q)) return null;
  const number = plateCanonical.split("|")[0] ?? "";
  const at = number.indexOf(q);
  return at < 0 ? null : [at, at + q.length];
}
