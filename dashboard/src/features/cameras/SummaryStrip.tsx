import { motion } from "framer-motion";
import { Building2, Camera, KeyRound, Signal, TriangleAlert, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { CountUp } from "../../components/ui/CountUp";
import { Skeleton } from "../../components/ui/Skeleton";
import { revealItem } from "../../components/ui/motion";
import type { Summary } from "./logic";
import { STATUS_COLOR } from "./style";
import type { CameraStatus } from "./types";

const int = (n: number) => String(Math.round(n));

/**
 * Live figures for the visible (city-scoped) cameras, with a status composition bar. These are
 * the server's current counts; there is no time series yet, so nothing here is extrapolated.
 */
export function SummaryStrip({ summary, byStatus }: { summary: Summary | null; byStatus: Record<CameraStatus, number> | null }) {
  const tiles: { label: string; value: number; format: (n: number) => string; icon: LucideIcon; color: string; status?: CameraStatus }[] = summary ? [
    { label: "Cities", value: summary.cities, format: int, icon: Building2, color: "var(--chart-1)" },
    { label: "Cameras", value: summary.cameras, format: int, icon: Camera, color: "var(--chart-2)" },
    { label: "Online", value: summary.onlinePct, format: (n) => `${n.toFixed(0)}%`, icon: Signal, color: "var(--ok)", status: "online" },
    { label: "Degraded", value: summary.degraded, format: int, icon: TriangleAlert, color: "var(--warn)", status: "degraded" },
    { label: "Offline", value: summary.offline, format: int, icon: WifiOff, color: "var(--danger)", status: "offline" },
    { label: "Credentials missing", value: summary.credentialsMissing, format: int, icon: KeyRound, color: "var(--gold)" },
  ] : [];

  return (
    <section aria-label="Registry summary" className="card-surface relative mb-6 overflow-hidden rounded-lg">
      <motion.div className="grid grid-cols-2 divide-border sm:grid-cols-3 lg:grid-cols-6 lg:divide-x" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }}>
        {summary ? tiles.map((t) => (
          <motion.div key={t.label} variants={revealItem} className="group relative px-5 py-4">
            <span className="pointer-events-none absolute -top-10 left-1/2 size-24 -translate-x-1/2 rounded-full opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-40" style={{ background: t.color }} aria-hidden />
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
              <t.icon size={13} style={{ color: t.color }} aria-hidden /> {t.label}
            </p>
            <p className="mt-1.5 font-display text-[1.9rem] font-semibold leading-none tracking-[-0.03em]">
              <CountUp value={t.value} format={t.format} />
            </p>
            {t.status && byStatus && summary.cameras > 0 && (
              <span className="mt-2 block h-1 overflow-hidden rounded-full bg-border" aria-hidden>
                <motion.span className="block h-full rounded-full" style={{ background: t.color }} initial={{ width: 0 }} animate={{ width: `${(byStatus[t.status] / summary.cameras) * 100}%` }} transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }} />
              </span>
            )}
          </motion.div>
        )) : Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="px-5 py-4"><Skeleton className="h-3 w-20" /><Skeleton className="mt-3 h-7 w-14" /></div>
        ))}
      </motion.div>
      {byStatus && summary && summary.cameras > 0 && (
        <div className="flex h-1.5" role="img" aria-label={`Status mix: ${Object.entries(byStatus).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(", ")}`}>
          {(Object.keys(byStatus) as CameraStatus[]).map((s) => (
            <motion.span key={s} style={{ background: STATUS_COLOR[s] }} initial={{ flexGrow: 0 }} animate={{ flexGrow: byStatus[s] }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }} />
          ))}
        </div>
      )}
    </section>
  );
}
