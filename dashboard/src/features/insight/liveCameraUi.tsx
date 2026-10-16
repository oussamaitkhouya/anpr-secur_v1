/*
 * Pieces of the /camera console: the camera rail, the session telemetry tiles, the viewfinder
 * frame over the video and the plate-read rows. Purely presentational; the page owns the data.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { motion } from "framer-motion";
import { CircleAlert, CircleCheck, Siren, Webcam, Wifi, type LucideIcon } from "lucide-react";
import { PlateText } from "../../components/ui/PlateText";
import { cn } from "../../lib/cn";
import { STATUS_LABELS } from "../cameras/logic";
import { STATUS_COLOR } from "../cameras/style";
import type { RegistryCamera } from "../cameras/types";

/** Every camera as a card. Local cameras (this browser can monitor them) come first. */
export function CameraRail({ cameras, selectedId, cityName }: { cameras: RegistryCamera[]; selectedId: string | null; cityName: (id: string) => string }) {
  const sorted = [...cameras].sort((a, b) => Number(b.protocol === "file") - Number(a.protocol === "file") || a.name.localeCompare(b.name));
  return (
    <nav aria-label="Cameras" className="-mx-1 mb-6 overflow-x-auto px-1 pb-2">
      <ul className="flex gap-3">
        {sorted.map((c, i) => {
          const on = c.id === selectedId;
          const local = c.protocol === "file";
          const Icon = local ? Webcam : Wifi;
          const color = STATUS_COLOR[c.status];
          return (
            <motion.li key={c.id} className="w-[240px] shrink-0" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.04, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
              <Link to={`/camera/${c.id}`} aria-current={on ? "page" : undefined}
                className={cn("focus-ring card-surface relative flex items-center gap-3 rounded-md p-3.5 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5",
                  on ? "shadow-glow" : "shadow-1 hover:shadow-2")}>
                <span className={cn("grid size-10 shrink-0 place-items-center rounded-[12px] transition-colors", on ? "bg-accent-soft text-accent" : "bg-bg-subtle text-muted")}>
                  <Icon size={18} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{c.name}</span>
                  <span className="block truncate text-xs text-muted">{cityName(c.cityId)} · {local ? "Local" : "Network"}</span>
                </span>
                <span className="relative inline-flex size-2 shrink-0" title={STATUS_LABELS[c.status]}>
                  {c.status === "online" && <span className="absolute inset-0 rounded-full motion-safe:animate-[live-pulse_1.8s_var(--ease-out)_infinite]" style={{ background: color }} />}
                  <span className="relative size-2 rounded-full" style={{ background: color }} />
                  <span className="sr-only">{STATUS_LABELS[c.status]}</span>
                </span>
              </Link>
            </motion.li>
          );
        })}
      </ul>
    </nav>
  );
}

/** One live number of the monitoring session. */
export function TelemetryTile({ label, value, icon: Icon, color, hint }: { label: string; value: ReactNode; icon: LucideIcon; color: string; hint?: string }) {
  return (
    <div className="card-surface relative overflow-hidden rounded-md p-4 shadow-1">
      <span className="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full opacity-20 blur-2xl" style={{ background: color }} aria-hidden />
      <div className="relative flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">{label}</span>
        <span className="grid size-7 place-items-center rounded-[9px]" style={{ color, background: `color-mix(in oklab, ${color} 16%, transparent)` }}>
          <Icon size={14} aria-hidden />
        </span>
      </div>
      <p className="relative mt-2.5 font-display text-[28px] font-semibold leading-none tracking-[-0.03em] tabular">{value}</p>
      {hint && <p className="relative mt-1.5 text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

/** Viewfinder corner brackets drawn over the video. */
export function ViewfinderCorners() {
  const base = "pointer-events-none absolute size-6 border-white/55";
  return (
    <>
      <span className={cn(base, "left-3 top-3 rounded-tl-lg border-l-2 border-t-2")} aria-hidden />
      <span className={cn(base, "right-3 top-3 rounded-tr-lg border-r-2 border-t-2")} aria-hidden />
      <span className={cn(base, "bottom-3 left-3 rounded-bl-lg border-b-2 border-l-2")} aria-hidden />
      <span className={cn(base, "bottom-3 right-3 rounded-br-lg border-b-2 border-r-2")} aria-hidden />
    </>
  );
}

/** Glass chip used in the video's heads-up display. */
export function HudChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 font-mono text-[11px] text-white backdrop-blur-md", className)}>
      {children}
    </span>
  );
}

/** Idle beacon: radar rings around the camera icon, waiting for "Start monitoring". */
export function IdleBeacon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="relative grid size-24 place-items-center" aria-hidden>
      <span className="absolute inset-0 rounded-full border border-accent motion-safe:animate-[beacon_2.6s_var(--ease-out)_infinite]" />
      <span className="absolute inset-0 rounded-full border border-accent motion-safe:animate-[beacon_2.6s_var(--ease-out)_1.3s_infinite]" />
      <span className="grid size-16 place-items-center rounded-full bg-accent-soft text-accent shadow-glow"><Icon size={26} /></span>
    </span>
  );
}

type ReadTone = "watch" | "ok" | "weak";
const READ_TONE: Record<ReadTone, { icon: LucideIcon; color: string }> = {
  watch: { icon: Siren, color: "var(--danger)" },
  ok: { icon: CircleCheck, color: "var(--accent-2)" },
  weak: { icon: CircleAlert, color: "var(--warn)" },
};

/** A plate read: tone tile, plate, confidence meter, and when. */
export function ReadRow({ plate, confidence, when, tone, note }: { plate: string; confidence: number; when: string; tone: ReadTone; note?: ReactNode }) {
  const t = READ_TONE[tone];
  const pct = Math.round(confidence * 100);
  return (
    <div className="flex gap-3">
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-[10px]", tone === "watch" && "motion-safe:animate-pulse")}
        style={{ color: t.color, background: `color-mix(in oklab, ${t.color} 15%, transparent)` }} aria-hidden>
        <t.icon size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-center justify-between gap-2">
          <PlateText value={plate} size="sm" />
          <span className="shrink-0 font-mono text-[11px] text-faint tabular">{when}</span>
        </span>
        <span className="flex items-center gap-2" title={`Read confidence ${pct}%`}>
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-border">
            <motion.span className="block h-full rounded-full" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              style={{ background: tone === "weak" || confidence < 0.7 ? "var(--warn)" : "linear-gradient(90deg, var(--accent), var(--accent-2))" }} />
          </span>
          <span className="font-mono text-[11px] text-muted tabular">{pct}%</span>
        </span>
        {note && <span className="text-[11px]">{note}</span>}
      </span>
    </div>
  );
}
