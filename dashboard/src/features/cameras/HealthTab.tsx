import { useId, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { BellOff, Info, ShieldAlert } from "lucide-react";
import { Card, CardHeader, RevealGroup } from "../../components/ui/Card";
import { relativeTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { daysUntil, silentFor, STATUS_LABELS, tlsState } from "./logic";
import { STATUS_COLOR } from "./style";
import { KindIcon, StatusChip } from "./ui";
import { CAMERA_STATUSES, type RegistryCamera, type RegistryCity } from "./types";

/**
 * Health from what the registry knows today: current status, last frame time and certificate
 * expiry. Uptime over time needs the camera worker's heartbeat history, which is not collected
 * yet, so this tab does not show (or invent) uptime percentages.
 */
export function HealthTab({ cameras, cities, onOpen }: { cameras: RegistryCamera[]; cities: RegistryCity[]; onOpen: (id: string) => void }) {
  return (
    <RevealGroup className="grid gap-5 xl:grid-cols-2">
      <StatusByCity cameras={cameras} cities={cities} />
      <SilentCameras cameras={cameras} onOpen={onOpen} />
      <LastFrameHeatmap cameras={cameras} onOpen={onOpen} />
      <CertificateTimeline cameras={cameras} onOpen={onOpen} />
    </RevealGroup>
  );
}

function StatusByCity({ cameras, cities }: { cameras: RegistryCamera[]; cities: RegistryCity[] }) {
  const rows = cities.map((city) => ({ city, mine: cameras.filter((c) => c.cityId === city.id) })).filter((r) => r.mine.length);
  return (
    <Card>
      <CardHeader title="Status by city" subtitle="Current status of every camera" />
      <div className="space-y-3 p-6 pt-4">
        {rows.map(({ city, mine }) => (
          <div key={city.id}>
            <div className="mb-1 flex justify-between text-xs"><span className="font-medium">{city.name}</span><span className="text-muted tabular">{mine.filter((c) => c.status === "online").length}/{mine.length} online</span></div>
            <div className="flex h-3 overflow-hidden rounded-full bg-border" role="img" aria-label={`${city.name}: ${CAMERA_STATUSES.map((s) => `${mine.filter((c) => c.status === s).length} ${STATUS_LABELS[s]}`).join(", ")}`}>
              {CAMERA_STATUSES.map((s) => {
                const n = mine.filter((c) => c.status === s).length;
                return n ? <motion.span key={s} style={{ background: STATUS_COLOR[s] }} initial={{ width: 0 }} animate={{ width: `${(n / mine.length) * 100}%` }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} /> : null;
              })}
            </div>
          </div>
        ))}
        {!rows.length && <p className="text-sm text-muted">No cameras yet.</p>}
        <div className="flex flex-wrap gap-3 pt-1 text-[11px] text-muted">
          {CAMERA_STATUSES.map((s) => <span key={s} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: STATUS_COLOR[s] }} aria-hidden />{STATUS_LABELS[s]}</span>)}
        </div>
        <p className="flex items-start gap-1.5 rounded-sm bg-bg-subtle/70 px-3 py-2 text-xs text-muted"><Info size={13} className="mt-px shrink-0" aria-hidden />Uptime over time needs heartbeat history from the camera worker, which is not collected yet.</p>
      </div>
    </Card>
  );
}

function heatColor(minutes: number | null): string {
  if (minutes === null) return "var(--border-strong)";
  if (minutes <= 2) return "var(--ok)";
  if (minutes <= 15) return "color-mix(in oklab, var(--ok) 45%, var(--warn))";
  if (minutes <= 60) return "var(--warn)";
  return "var(--danger)";
}

function LastFrameHeatmap({ cameras, onOpen }: { cameras: RegistryCamera[]; onOpen: (id: string) => void }) {
  const sorted = [...cameras].sort((a, b) => (silentFor(b) ?? 1e9) - (silentFor(a) ?? 1e9));
  return (
    <Card>
      <CardHeader title="Last frame" subtitle="Time since each camera last delivered a frame" />
      <div className="p-6 pt-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1.5">
          {sorted.map((c, i) => {
            const m = silentFor(c);
            return (
              <motion.button
                key={c.id} type="button" onClick={() => onOpen(c.id)}
                initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.012 }}
                className="focus-ring grid aspect-square place-items-center rounded-[8px] text-white/90 transition-transform hover:scale-110"
                style={{ background: heatColor(m) }}
                title={`${c.name}: ${m === null ? "no frame yet" : `${m} min ago`}`}
                aria-label={`${c.name}, last frame ${m === null ? "never" : `${m} minutes ago`}`}
              >
                <KindIcon kind={c.kind} size={13} />
              </motion.button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-3 text-[11px] text-muted">
          {[["≤ 2 min", 1], ["≤ 15 min", 10], ["≤ 1 h", 30], ["> 1 h", 120], ["never", null]].map(([l, m]) => (
            <span key={String(l)} className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px]" style={{ background: heatColor(m as number | null) }} aria-hidden />{l}</span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function CertificateTimeline({ cameras, onOpen }: { cameras: RegistryCamera[]; onOpen: (id: string) => void }) {
  const HORIZON = 120;
  const certs = cameras.filter((c) => c.tlsNotAfter).map((c) => ({ c, days: daysUntil(c.tlsNotAfter!) })).sort((a, b) => a.days - b.days);
  return (
    <Card className="xl:col-span-2">
      <CardHeader title="Certificate expiry" subtitle={`RTSPS certificates captured by connection tests, next ${HORIZON} days`} />
      <div className="p-6 pt-4">
        {!certs.length ? <p className="text-sm text-muted">No certificate captured yet. Run "Test connection" on an RTSPS camera to record its expiry.</p> : (
          <>
            <div className="relative mb-2 h-6 text-[10px] text-faint">
              {[0, 30, 60, 90, 120].map((d) => <span key={d} className="absolute -translate-x-1/2 tabular" style={{ left: `${(d / HORIZON) * 100}%` }}>{d === 0 ? "today" : `+${d} d`}</span>)}
            </div>
            <div className="relative space-y-1.5">
              <span className="absolute inset-y-0 border-l border-dashed border-warn/60" style={{ left: `${(30 / HORIZON) * 100}%` }} aria-hidden />
              {certs.map(({ c, days }) => {
                const state = tlsState(c.tlsNotAfter);
                const pct = Math.max(0, Math.min(100, (days / HORIZON) * 100));
                return (
                  <button key={c.id} type="button" onClick={() => onOpen(c.id)} className="focus-ring group relative flex h-7 w-full items-center rounded-xs text-left hover:bg-bg-subtle/60">
                    <motion.span className="absolute left-0 h-1.5 rounded-full" style={{ background: state === "expired" ? "var(--danger)" : state === "expiring" ? "var(--warn)" : "var(--ok)" }} initial={{ width: 0 }} animate={{ width: `${Math.max(pct, 1)}%` }} transition={{ duration: 0.8 }} />
                    <span className={cn("relative ml-2 rounded-full bg-surface-raised px-2 text-xs shadow-1", state === "expired" && "text-danger", state === "expiring" && "text-warn")}>
                      {c.name} · {days < 0 ? `expired ${-days} d ago` : `${days} d`}
                    </span>
                  </button>
                );
              })}
            </div>
            {certs.some((x) => x.days < 30) && <p className="mt-3 flex items-center gap-1.5 text-xs text-warn"><ShieldAlert size={13} aria-hidden />Renew certificates under 30 days before they expire: cameras then fail TLS and drop off.</p>}
          </>
        )}
      </div>
    </Card>
  );
}

function SilentCameras({ cameras, onOpen }: { cameras: RegistryCamera[]; onOpen: (id: string) => void }) {
  const [minutes, setMinutes] = useState(15);
  const id = useId();
  const silent = useMemo(() => cameras.filter((c) => c.status !== "maintenance").map((c) => ({ c, m: silentFor(c) })).filter(({ m }) => m === null || m > minutes)
    .sort((a, b) => (b.m ?? 1e9) - (a.m ?? 1e9)), [cameras, minutes]);
  return (
    <Card>
      <CardHeader
        title="Silent cameras"
        subtitle="No frame for longer than the threshold (maintenance excluded)"
        actions={<label htmlFor={id} className="flex items-center gap-2 text-xs text-muted">More than <input id={id} type="number" min={1} max={10080} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))} className="focus-ring h-8 w-16 rounded-sm border border-border bg-surface px-2 text-right font-mono text-sm" /> min</label>}
      />
      <ul className="max-h-80 space-y-1 overflow-y-auto p-3">
        {silent.map(({ c, m }) => (
          <li key={c.id}>
            <button type="button" onClick={() => onOpen(c.id)} className="focus-ring flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-bg-subtle">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-danger-soft text-danger"><KindIcon kind={c.kind} size={14} /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{c.name}</span><span className="block text-xs text-muted">{m === null ? "Never delivered a frame" : `Silent for ${relativeTime(c.lastFrameAt!).replace(" ago", "")}`}</span></span>
              <StatusChip status={c.status} />
            </button>
          </li>
        ))}
        {!silent.length && <li className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted"><BellOff size={20} aria-hidden />Every camera delivered a frame in the last {minutes} minutes.</li>}
      </ul>
    </Card>
  );
}
