/*
 * The "plate vault" pieces of /admin/watchlists: the hero, the reason donut, the 30-day expiry
 * radar and the plate wall (entries as physical plates that flip to show their details).
 * Everything is drawn from the real lists and entries; nothing is estimated.
 */
import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { CalendarClock, Info, LayoutGrid, Radar, Rows3, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { CountUp } from "../../components/ui/CountUp";
import { cn } from "../../lib/cn";
import { formatDateTime, formatNumber, relativeTime } from "../../lib/format";
import type { Entry, Watchlist } from "./api";
import { daysUntilExpiry, expiresSoon, numberHit, REASON_STYLE } from "./reasons";
import { ReasonPill } from "./watchlistsUi";

const EASE = [0.22, 1, 0.36, 1] as const;
export type EntryView = "wall" | "table";

/** Page hero: title, purpose, actions, and how many plates are armed across every list. */
export function VaultHero({ lists, actions }: { lists: Watchlist[] | undefined; actions: ReactNode }) {
  const total = (lists ?? []).reduce((n, l) => n + l.activeEntries, 0);
  const armed = (lists ?? []).filter((l) => l.activeEntries > 0).length;
  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE }}
      className="relative mb-7 overflow-hidden rounded-lg border border-border p-7 shadow-3 sm:p-9"
      style={{ background: "linear-gradient(135deg, color-mix(in oklab, var(--accent-soft) 85%, var(--surface)), var(--surface) 62%)" }}>
      <span className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-accent opacity-25 blur-3xl" aria-hidden />
      <span className="pointer-events-none absolute -bottom-28 left-1/3 size-72 rounded-full bg-accent-2 opacity-10 blur-3xl" aria-hidden />
      <div className="relative flex flex-wrap items-end justify-between gap-8">
        <div className="max-w-xl">
          <p className="mb-3 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            <span className="bg-brand h-px w-7 rounded-full" aria-hidden />Admin · plate vault
          </p>
          <h1 className="text-[2.6rem] font-semibold leading-none tracking-[-0.04em] md:text-[3.4rem]">
            <span className="text-gradient pr-1 font-serif font-normal italic tracking-[-0.01em]">Watchlists</span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            Plates that raise an alert when a camera reads them. Every alert is still decided by a person, and every change here is written to the signed audit log.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">{actions}</div>
        </div>
        {lists && (
          <dl className="flex gap-3">
            <HeroStat label="Active plates" icon={<ShieldCheck size={14} aria-hidden />}>
              <CountUp value={total} format={formatNumber} />
            </HeroStat>
            <HeroStat label="Lists armed" icon={<span className="relative inline-flex size-2"><span className="absolute inset-0 rounded-full bg-ok motion-safe:animate-[live-pulse_1.8s_var(--ease-out)_infinite]" /><span className="relative size-2 rounded-full bg-ok" /></span>}>
              <span className="tabular">{armed}<span className="text-lg text-faint">/{lists.length}</span></span>
            </HeroStat>
          </dl>
        )}
      </div>
    </motion.section>
  );
}

function HeroStat({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="glass min-w-[140px] rounded-md px-5 py-4 shadow-1">
      <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{icon}{label}</dt>
      <dd className="mt-2 font-display text-[40px] font-semibold leading-none tracking-[-0.04em]">{children}</dd>
    </div>
  );
}

/** The next 30 days: each active entry that stops alerting in that window is a marker on the line. */
export function ExpiryRadar({ entries }: { entries: Entry[] }) {
  const [now] = useState(() => Date.now());
  const upcoming = entries
    .map((e) => ({ e, d: daysUntilExpiry(e, now) }))
    .filter((x): x is { e: Entry; d: number } => x.d !== null && x.d <= 30)
    .sort((a, b) => a.d - b.d);
  const week = upcoming.filter((x) => x.d <= 7).length;
  return (
    <section aria-label="Expiry radar, next 30 days" className="card-surface relative mb-5 rounded-lg px-6 py-5 shadow-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 font-display text-base font-semibold"><Radar size={16} className="text-accent" aria-hidden /> Expiry radar · next 30 days</h3>
        <p className="text-xs text-muted">
          {upcoming.length ? `${upcoming.length} plate${upcoming.length === 1 ? "" : "s"} stop alerting${week ? ` · ${week} this week` : ""}` : "No plate stops alerting in the next 30 days"}
        </p>
      </div>
      <div className="relative mt-6 h-12" aria-hidden={!upcoming.length}>
        <span className="absolute inset-x-0 top-5 h-0.5 rounded-full bg-border" />
        <span className="absolute left-0 top-5 h-0.5 rounded-full bg-gold" style={{ width: `${(7 / 30) * 100}%` }} />
        <span className="absolute left-0 top-8 font-mono text-[10px] text-faint">today</span>
        <span className="absolute top-8 -translate-x-1/2 font-mono text-[10px] text-gold-strong" style={{ left: `${(7 / 30) * 100}%` }}>7 d</span>
        <span className="absolute right-0 top-8 font-mono text-[10px] text-faint">30 d</span>
        <ol>
          {upcoming.map(({ e, d }, i) => (
            <motion.li key={e.id} className="absolute top-[13px] -translate-x-1/2" style={{ left: `${Math.min(98, Math.max(2, (d / 30) * 100))}%` }}
              initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2 + i * 0.06, type: "spring", stiffness: 380, damping: 22 }}>
              <span tabIndex={0} role="img" aria-label={`${e.plateCanonical} stops alerting ${relativeTime(e.expiresAt!, now)}`} title={`${e.plateCanonical.replaceAll("|", " ")} · ${formatDateTime(e.expiresAt!)}`}
                className={cn("focus-ring block size-4 rounded-full", d <= 7 ? "bg-gold shadow-[0_0_0_5px_color-mix(in_oklab,var(--gold)_22%,transparent),0_0_16px_var(--gold)]" : "bg-accent shadow-[0_0_0_5px_var(--accent-soft)]")} />
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** Plate wall / table switch. */
export function ViewToggle({ view, onChange }: { view: EntryView; onChange: (v: EntryView) => void }) {
  const items: { id: EntryView; label: string; icon: typeof LayoutGrid }[] = [{ id: "wall", label: "Plate wall", icon: LayoutGrid }, { id: "table", label: "Table", icon: Rows3 }];
  return (
    <div role="tablist" aria-label="View" className="inline-flex rounded-sm border border-border bg-surface/60 p-1 shadow-1 backdrop-blur">
      {items.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => onChange(id)}
          className={cn("focus-ring relative flex h-9 items-center gap-1.5 rounded-xs px-3.5 text-[13px] font-medium transition-colors", view === id ? "text-text" : "text-muted hover:text-text")}>
          {view === id && <motion.span layoutId="wl-view" className="absolute inset-0 rounded-xs bg-surface-raised shadow-1 ring-1 ring-border" transition={{ type: "spring", stiffness: 420, damping: 34 }} aria-hidden />}
          <Icon size={14} className="relative" aria-hidden /><span className="relative">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Entries as a wall of plates; each card flips (hover, or the info button) to its details. */
export function PlateWall({ entries, query, onExpire, onRemove }: {
  entries: Entry[]; query: string; onExpire: (e: Entry) => void; onRemove: (e: Entry) => void;
}) {
  return (
    <motion.ul aria-label="Plate wall" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.035 } } }}>
      {entries.map((e) => (
        <motion.li key={e.id} variants={{ hidden: { opacity: 0, y: 14, scale: 0.97 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: EASE } } }}>
          <PlateCard entry={e} query={query} onExpire={() => onExpire(e)} onRemove={() => onRemove(e)} />
        </motion.li>
      ))}
    </motion.ul>
  );
}

function PlateCard({ entry: e, query, onExpire, onRemove }: { entry: Entry; query: string; onExpire: () => void; onRemove: () => void }) {
  const [pinned, setPinned] = useState(false); // flipped by click or keyboard (touch screens have no hover)
  const [hover, setHover] = useState(false);
  const flipped = pinned || hover;
  const r = REASON_STYLE[e.reason];
  const soon = expiresSoon(e);
  const vehicle = [e.color, e.make, e.model].filter(Boolean).join(" ") || "—";
  return (
    <div className="h-[212px] [perspective:1200px]" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="relative size-full transition-transform duration-700 ease-[var(--ease-out)] [transform-style:preserve-3d]" style={{ transform: flipped ? "rotateY(180deg)" : undefined }}>
        {/* front: the plate */}
        <div inert={flipped} className={cn("card-surface absolute inset-0 flex flex-col rounded-lg p-4 [backface-visibility:hidden]", e.status !== "active" && "opacity-60")}
          style={{ boxShadow: `0 22px 50px -32px color-mix(in oklab, ${r.color} 55%, transparent)`, outline: soon ? "1px solid var(--gold)" : undefined }}>
          <div className="relative flex items-center justify-between gap-2">
            <ReasonPill reason={e.reason} />
            {e.status !== "active" ? <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] font-medium capitalize text-muted">{e.status}</span>
              : e.expiresAt ? (soon
                ? <span className="inline-flex items-center gap-1 rounded-full bg-gold-soft px-2 py-1 text-xs font-medium text-gold-strong" title={formatDateTime(e.expiresAt)}><CalendarClock size={12} aria-hidden />{relativeTime(e.expiresAt)}</span>
                : <span className="text-xs text-faint">until {formatDateTime(e.expiresAt).split(",")[0]}</span>)
              : <span className="text-xs text-faint">no expiry</span>}
          </div>
          <div className="relative flex flex-1 items-center justify-center">
            <PhysicalPlate value={e.plateCanonical} query={query} />
          </div>
          <div className="relative flex items-center justify-between text-xs text-faint">
            <span>added {relativeTime(e.addedAt)}{e.importId ? " · CSV" : ""}</span>
            <button type="button" onClick={() => setPinned(true)} aria-label={`Details of ${e.plateCanonical}`}
              className="focus-ring grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-bg-subtle hover:text-text"><Info size={15} aria-hidden /></button>
          </div>
        </div>
        {/* back: the details and actions */}
        <div inert={!flipped} className="absolute inset-0 flex flex-col gap-3 rounded-lg border border-accent/40 p-4 shadow-glow [backface-visibility:hidden] [transform:rotateY(180deg)]"
          style={{ background: "linear-gradient(160deg, var(--accent-soft), var(--surface) 75%)" }}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
            <div><dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Case</dt><dd className="font-mono">{e.caseRef ?? "—"}</dd></div>
            <div><dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Source</dt><dd className="truncate">{e.source ?? "—"}</dd></div>
            <div className="col-span-2"><dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Vehicle</dt><dd className="truncate">{vehicle}</dd></div>
            <div className="col-span-2"><dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Expires</dt><dd>{e.expiresAt ? formatDateTime(e.expiresAt) : "never"}</dd></div>
          </dl>
          <div className="mt-auto flex gap-2">
            {e.status !== "removed" && (
              <>
                <button type="button" onClick={onExpire} aria-label={`Set expiry for ${e.plateCanonical}`}
                  className="focus-ring flex h-10 flex-1 items-center justify-center gap-1.5 rounded-sm border border-border text-[13px] font-medium transition-colors hover:border-border-strong hover:bg-bg-subtle"><CalendarClock size={14} aria-hidden /> Expiry</button>
                <button type="button" onClick={onRemove} aria-label={`Remove ${e.plateCanonical}`}
                  className="focus-ring flex h-10 flex-1 items-center justify-center gap-1.5 rounded-sm border border-danger bg-danger-soft text-[13px] font-medium text-danger transition-colors hover:brightness-95"><Trash2 size={14} aria-hidden /> Remove</button>
              </>
            )}
            <button type="button" onClick={() => { setPinned(false); setHover(false); }} aria-label={`Back to the plate ${e.plateCanonical}`}
              className="focus-ring grid size-10 shrink-0 place-items-center rounded-sm border border-border text-muted transition-colors hover:text-text"><Undo2 size={15} aria-hidden /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A plate drawn like the physical one: white field, black ink and frame, a light sheen; search hits highlighted. */
function PhysicalPlate({ value, query }: { value: string; query: string }) {
  const [number, letter, region] = value.split("|");
  const hit = numberHit(value, query);
  const sep = <span className="h-8 w-[2px] rounded-full bg-plate-ink/85" aria-hidden />;
  return (
    <span dir="ltr" aria-label={`Plate ${number} ${letter} ${region}`}
      className="relative inline-flex h-[60px] items-center gap-3 overflow-hidden rounded-[10px] px-5 font-mono text-[28px] font-medium tracking-[0.04em] text-plate-ink tabular"
      style={{ background: "linear-gradient(180deg, var(--plate-bg), color-mix(in oklab, var(--plate-bg) 86%, #8a87a6))",
        boxShadow: "inset 0 0 0 2px var(--plate-ink), inset 0 0 0 5px var(--plate-bg), 0 18px 40px -20px rgb(0 0 0 / 0.85)" }}>
      <span className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/3 motion-safe:animate-[plate-sheen_6s_var(--ease-out)_infinite]"
        style={{ background: "linear-gradient(90deg, transparent, rgb(255 255 255 / 0.5), transparent)" }} aria-hidden />
      <span className="relative">
        {hit ? <>{number.slice(0, hit[0])}<mark className="rounded-[4px] bg-accent/30 text-plate-ink">{number.slice(hit[0], hit[1])}</mark>{number.slice(hit[1])}</> : number}
      </span>
      {sep}<span className="relative font-sans font-bold" lang="ar">{letter}</span>{sep}<span className="relative">{region}</span>
    </span>
  );
}
