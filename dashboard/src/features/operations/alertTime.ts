/** Waiting-time helpers for the alert queue: a ticking clock and compact durations. */
import { useEffect, useState } from "react";

/** Current time, ticking every `ms`. Drives the waiting clocks without refetching. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** "0:42", "12:40", "2 h 05", "3 d": how long an alert has waited since the camera read. */
export function formatWait(sinceIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)} d`;
}

/** Waiting longer than this is shown in warning colour. */
export const SLOW_WAIT_S = 10 * 60;

export function waitedSeconds(sinceIso: string, now: number) {
  return (now - Date.parse(sinceIso)) / 1000;
}
