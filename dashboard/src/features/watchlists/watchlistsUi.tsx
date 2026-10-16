/*
 * Pieces of the /admin/watchlists registry: list cards, the selected list's summary (reason mix,
 * expiring soon, last import), reason pills and the import timeline. Derived from real data only.
 */
import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CalendarClock, FileSpreadsheet, ShieldAlert, type LucideIcon } from "lucide-react";
import { CountUp } from "../../components/ui/CountUp";
import { cn } from "../../lib/cn";
import { formatDate, formatNumber, relativeTime } from "../../lib/format";
import type { Entry, ImportRecord, Reason, Watchlist } from "./api";
import { expiresSoon, REASON_STYLE } from "./reasons";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Reason with its glyph and colour; the text says it too, so colour is never the only cue. */
export function ReasonPill({ reason }: { reason: Reason }) {
  const r = REASON_STYLE[reason];
  return (
    <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium"
      style={{ color: reason === "stolen" ? "var(--gold-strong)" : r.color, background: `color-mix(in oklab, ${r.color} 13%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${r.color} 35%, transparent)` }}>
      <r.icon size={12} aria-hidden />{r.label}
    </span>
  );
}

/** Every watchlist as a card, with its share of all active plates. */
export function ListCards({ lists, selectedId, onSelect }: { lists: Watchlist[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const max = Math.max(1, ...lists.map((l) => l.activeEntries));
  return (
    <div role="group" aria-label="Watchlists" className="mb-6 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
      {lists.map((l, i) => {
        const on = l.id === selectedId;
        return (
          <motion.button key={l.id} type="button" onClick={() => onSelect(l.id)} aria-pressed={on}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.05, duration: 0.45, ease: EASE }}
            whileHover={{ y: -3 }}
            className={cn("focus-ring card-surface relative flex flex-col gap-4 overflow-hidden rounded-lg p-5 text-left transition-shadow", on ? "shadow-glow" : "shadow-1 hover:shadow-2")}>
            {on && <span className="pointer-events-none absolute -right-14 -top-14 size-44 rounded-full bg-accent opacity-20 blur-3xl" aria-hidden />}
            <span className="relative flex items-center gap-3">
              <span className={cn("grid size-10 shrink-0 place-items-center rounded-[12px] transition-colors", on ? "bg-accent-soft text-accent" : "bg-bg-subtle text-muted")}>
                <ShieldAlert size={18} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-semibold">{l.name}</span>
                <span className="block truncate text-xs text-muted">{l.source}</span>
              </span>
            </span>
            <span className="relative flex items-baseline gap-1.5">
              <span className="font-display text-[30px] font-semibold leading-none tracking-[-0.03em]"><CountUp value={l.activeEntries} format={formatNumber} /></span>
              <span className="text-[13px] text-muted">active plate{l.activeEntries === 1 ? "" : "s"}</span>
            </span>
            <span className="relative block h-1 overflow-hidden rounded-full bg-border" aria-hidden>
              <motion.span className="block h-full rounded-full" style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-2))" }}
                initial={{ width: 0 }} animate={{ width: `${(l.activeEntries / max) * 100}%` }} transition={{ duration: 0.9, ease: EASE }} />
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

/** The selected list at a glance: what its active plates are listed for, and what needs attention. */
export function ListSummary({ list, entries, lastImport }: { list: Watchlist; entries: Entry[] | undefined; lastImport: ImportRecord | undefined }) {
  const active = (entries ?? []).filter((e) => e.status === "active");
  const mix = (Object.keys(REASON_STYLE) as Reason[]).map((r) => ({ r, n: active.filter((e) => e.reason === r).length }));
  const soon = (entries ?? []).filter((e) => expiresSoon(e)).length;
  return (
    <section aria-label={`${list.name} summary`} className="card-surface relative mb-5 overflow-hidden rounded-lg p-6 shadow-2">
      <span className="pointer-events-none absolute inset-0 opacity-80" style={{ background: "radial-gradient(60% 100% at 0% 0%, var(--spot), transparent 60%)" }} aria-hidden />
      <div className="relative flex flex-wrap items-center justify-between gap-6">
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-semibold tracking-tight">{list.name}</h2>
          <p className="mt-1 text-sm text-muted">{list.source} · created {formatDate(list.createdAt)}</p>
        </div>
        <div className="flex min-w-[240px] flex-1 items-center gap-6">
          <ReasonDonut mix={mix} />
          <div className="flex flex-col gap-2 text-sm text-muted">
            {mix.map(({ r, n }) => {
              const { color, icon: Icon, label } = REASON_STYLE[r];
              return (
                <span key={r} className="inline-flex items-center gap-2"><span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden /><Icon size={13} aria-hidden />{label} <span className="font-mono font-semibold text-text tabular">{n}</span></span>
              );
            })}
          </div>
        </div>
        <div className="flex gap-3">
          <Stat label="Expiring 7 d" icon={CalendarClock} tone={soon ? "gold" : undefined}>{entries ? soon : "…"}</Stat>
          <Stat label="Last import" icon={FileSpreadsheet} hint={lastImport ? relativeTime(lastImport.importedAt) : undefined}>{lastImport ? `v${lastImport.version}` : "—"}</Stat>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, icon: Icon, tone, hint, children }: { label: string; icon: LucideIcon; tone?: "gold"; hint?: string; children: ReactNode }) {
  return (
    <div className={cn("min-w-[120px] rounded-md border px-4 py-3", tone === "gold" ? "border-gold bg-gold-soft" : "border-border bg-bg/40")}>
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint"><Icon size={12} aria-hidden />{label}</p>
      <p className={cn("mt-1 font-display text-[22px] font-semibold leading-tight tabular", tone === "gold" && "text-gold-strong")}>{children}</p>
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

/** Import versions as a vertical timeline, newest first. */
export function ImportTimeline({ imports }: { imports: ImportRecord[] }) {
  return (
    <ol className="ml-1.5 space-y-5 border-l-2 border-border">
      {imports.map((r, i) => (
        <motion.li key={r.id} className="relative pl-6" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 8) * 0.05 }}>
          <span className={cn("absolute -left-[7px] top-1 size-3 rounded-full", i === 0 ? "bg-accent shadow-[0_0_0_4px_var(--accent-soft)]" : "bg-border-strong")} aria-hidden />
          <p className="text-sm">
            <span className="font-semibold">v{r.version}</span> · {r.fileName}
            <span className="text-ok"> · {r.rowsAccepted} added</span>
            {r.rowsRejected > 0 && <span className="text-danger"> · {r.rowsRejected} rejected</span>}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-faint" title={r.sha256}>SHA-256 {r.sha256.slice(0, 16)}… · {relativeTime(r.importedAt)}</p>
        </motion.li>
      ))}
    </ol>
  );
}

/** Active plates of a list as a ring, one arc per reason, drawn in on mount. */
export function ReasonDonut({ mix, size = 132 }: { mix: { r: Reason; n: number }[]; size?: number }) {
  const reduce = useReducedMotion();
  const total = mix.reduce((s, m) => s + m.n, 0);
  const stroke = 12;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const gap = total > 1 && mix.filter((m) => m.n).length > 1 ? 6 : 0;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`Active plates by reason: ${mix.map(({ r: k, n }) => `${REASON_STYLE[k].label} ${n}`).join(", ")}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        {total > 0 && mix.filter((m) => m.n).map(({ r: k, n }, i) => {
          const len = Math.max(0, (n / total) * circ - gap);
          const arc = (
            <motion.circle key={k} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={REASON_STYLE[k].color} strokeWidth={stroke}
              strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeDashoffset={-offset}
              initial={{ strokeDasharray: reduce ? `${len} ${circ}` : `0 ${circ}` }} animate={{ strokeDasharray: `${len} ${circ}` }}
              transition={{ duration: 0.9, delay: i * 0.12, ease: EASE }} />
          );
          offset += (n / total) * circ;
          return arc;
        })}
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
        <span className="font-display text-[34px] font-semibold leading-none tracking-[-0.04em] tabular">{total}</span>
        <span className="mt-1 text-[10px] uppercase tracking-[0.16em] text-faint">active</span>
      </span>
    </div>
  );
}
