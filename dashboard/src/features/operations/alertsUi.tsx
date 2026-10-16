/*
 * Building blocks of the /alerts command center: the queue's at-a-glance strip, the plate hero,
 * and the match-score ring. Everything here is derived
 * from the real alert list; nothing is estimated or invented.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CheckCheck, Hourglass, Inbox, Siren } from "lucide-react";
import type { Priority } from "../../api/types";
import { KpiCard } from "../../components/ui/KpiCard";
import { PRIORITY_COLOR } from "../../components/ui/priority";
import { isMasked } from "../../lib/mask";
import { cn } from "../../lib/cn";
import { formatNumber } from "../../lib/format";
import { formatWait, SLOW_WAIT_S, waitedSeconds } from "./alertTime";
import { priorityOf, type LiveAlert } from "./api";

/** The four tiles above the queue: what is waiting, how urgent, how long, and what was decided. */
export function QueueStats({ alerts, now }: { alerts: LiveAlert[]; now: number }) {
  const s = useMemo(() => {
    const pending = alerts.filter((a) => a.status === "pending");
    const critical = pending.filter((a) => priorityOf(a.watchlistEntry.reason) === "critical").length;
    const oldest = pending.reduce<string | null>((o, a) => (!o || a.observedAt < o ? a.observedAt : o), null);
    const dayAgo = now - 86_400_000;
    const decided = alerts.filter((a) => a.decision && Date.parse(a.decision.decidedAt) >= dayAgo).length;
    return { pending: pending.length, critical, oldest, decided };
  }, [alerts, now]);
  const oldestSlow = s.oldest ? waitedSeconds(s.oldest, now) > SLOW_WAIT_S : false;
  return (
    <section aria-label="Queue at a glance" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard label="Awaiting review" value={s.pending} format={formatNumber} icon={Inbox}
        caption={s.pending ? `${s.critical} critical in the queue` : "Queue is clear"} />
      <KpiCard label="Critical pending" value={s.critical} format={formatNumber} icon={Siren} tone="gold"
        caption="Stolen vehicles, listed first" />
      <KpiCard label="Oldest waiting" value={0} format={() => (s.oldest ? formatWait(s.oldest, now) : "—")} icon={Hourglass}
        tone={oldestSlow ? "danger" : "default"} caption={s.oldest ? "Since the camera read" : "Nothing waiting"} />
      <KpiCard label="Decided, last 24 h" value={s.decided} format={formatNumber} icon={CheckCheck} tone="ok"
        caption="Each signed in the audit log" />
    </section>
  );
}

/** The plate as a large physical plate: white field, black ink, the two hairline separators. */
export function PlateHero({ value }: { value: string }) {
  const [number, letter, region] = value.split("|");
  const masked = isMasked(value);
  const sep = <span className="h-[60%] w-[2px] rounded-full bg-plate-ink/85" aria-hidden />;
  return (
    <span
      dir="ltr"
      aria-label={masked ? `Masked plate, region ${region}` : `Plate ${number} ${letter} ${region}`}
      className="relative inline-flex h-[68px] items-center gap-4 overflow-hidden rounded-[14px] px-6 font-mono text-[34px] font-medium tracking-[0.04em] text-plate-ink tabular sm:h-[76px] sm:text-[38px]"
      style={{
        background: "linear-gradient(180deg, var(--plate-bg), color-mix(in oklab, var(--plate-bg) 88%, #8a87a6))",
        boxShadow: "inset 0 0 0 2px var(--plate-ink), inset 0 0 0 5px var(--plate-bg), 0 22px 50px -22px rgb(0 0 0 / 0.9)",
      }}
    >
      {/* soft sheen sliding across the plate, as on a reflective plate */}
      <span className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/3 -skew-x-12 motion-safe:animate-[plate-sheen_6s_var(--ease-out)_infinite]"
        style={{ background: "linear-gradient(90deg, transparent, rgb(255 255 255 / 0.45), transparent)" }} aria-hidden />
      <span className={masked ? "tracking-[0.2em] opacity-50" : undefined}>{number}</span>
      {sep}
      <span className="font-sans font-bold" lang="ar">{letter}</span>
      {sep}
      <span>{region}</span>
    </span>
  );
}

/** Match score as a ring that draws itself in. */
export function MatchRing({ score, priority }: { score: number; priority: Priority }) {
  const reduce = useReducedMotion();
  const r = 50;
  const circ = 2 * Math.PI * r;
  const pct = Math.round(score * 100);
  const c = PRIORITY_COLOR[priority];
  return (
    <div className="relative size-[120px] shrink-0">
      <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label={`Match score ${pct} percent`}>
        <defs>
          <linearGradient id="match-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={c} />
            <stop offset="100%" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border)" strokeWidth="10" />
        <motion.circle cx="60" cy="60" r={r} fill="none" stroke="url(#match-ring)" strokeWidth="10" strokeLinecap="round"
          transform="rotate(-90 60 60)" strokeDasharray={circ}
          initial={{ strokeDashoffset: reduce ? circ * (1 - score) : circ }}
          animate={{ strokeDashoffset: circ * (1 - score) }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
          style={{ filter: `drop-shadow(0 0 6px color-mix(in oklab, ${c} 60%, transparent))` }} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
        <span className="font-display text-[30px] font-semibold leading-none tracking-[-0.03em] tabular">{pct}<span className="text-base text-muted">%</span></span>
        <span className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">match</span>
      </span>
    </div>
  );
}

/** Keyboard hint chip shown inside buttons. Hidden on touch-sized screens. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <kbd aria-hidden className={cn("hidden h-5 min-w-5 items-center justify-center rounded-[5px] border border-current/25 px-1 font-mono text-[10px] font-medium opacity-75 sm:inline-flex", className)}>
      {children}
    </kbd>
  );
}
