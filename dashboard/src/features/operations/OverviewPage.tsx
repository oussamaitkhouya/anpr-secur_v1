/*
 * / (Overview): today's reads, watchlist matches and camera health from the PostgreSQL API,
 * scoped to the caller's cities. Every figure is a real count; where nothing is measured yet
 * (OCR accuracy on live reads, plate types) the page says so instead of showing a number.
 */
import { Link, useNavigate } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Camera as CameraIcon, CheckCircle2, ListChecks, RefreshCw, ScanLine, ShieldAlert, ShieldCheck, Siren, Timer, UserCheck } from "lucide-react";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Card, CardHeader, RevealGroup } from "../../components/ui/Card";
import { KpiCard } from "../../components/ui/KpiCard";
import { PageHeader } from "../../components/ui/PageHeader";
import { PlateText } from "../../components/ui/PlateText";
import { LoadingBlock, Skeleton } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { PRIORITY_TONE } from "../../components/ui/tones";
import { HourlyReadsChart } from "../../components/charts/HourlyReadsChart";
import { cn } from "../../lib/cn";
import { formatNumber, relativeTime } from "../../lib/format";
import { useCameras, useCities } from "../cameras/hooks";
import { STATUS_LABELS } from "../cameras/logic";
import { StatusChip } from "../cameras/ui";
import { POLL_MS, priorityOf, REASON_LABELS, useAlerts, useOverview, type Overview } from "./api";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const int = (n: number) => formatNumber(Math.round(n));

export default function OverviewPage() {
  const { user } = useSession();
  const overview = useOverview();
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title={`${greeting()}, ${user.name}`}
        description="Plate reads, watchlist matches and camera health in your cities, from live data."
        actions={
          <span className="flex items-center gap-2 text-xs text-muted">
            <RefreshCw size={13} className={overview.isFetching ? "animate-spin" : ""} aria-hidden />
            Refreshes every {POLL_MS / 1000} s
          </span>
        }
      />
      {overview.error ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : !overview.data ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading overview">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="card-surface relative rounded-lg p-5"><Skeleton className="h-4 w-28" /><Skeleton className="mt-5 h-9 w-36" /></div>)}
        </div>
      ) : (
        <Body data={overview.data} />
      )}
    </>
  );
}

function Body({ data }: { data: Overview }) {
  const navigate = useNavigate();
  const { can } = useSession();
  const daily = data.daily;
  const latency = daily.map((d) => d.latencyMs ?? 0);
  const anyReads = daily.some((d) => d.reads > 0);

  return (
    <RevealGroup className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard label="Plates read today" icon={ScanLine} value={data.platesToday} format={int} trend={anyReads ? daily.map((d) => d.reads) : undefined}
          caption={anyReads ? "UTC day. Trend: the last 14 days." : "No plate read yet. Reads appear when the camera worker sends detections."} />
        <KpiCard label="Watchlist hits today" icon={Siren} tone="gold" value={data.watchlistHitsToday} format={int} trend={anyReads ? daily.map((d) => d.hits) : undefined}
          caption="Each one is confirmed by a person before any action." onClick={can("alerts:view") ? () => navigate("/alerts") : undefined} />
        <KpiCard label="Awaiting review" icon={UserCheck} tone={data.pendingAlerts ? "danger" : "ok"} value={data.pendingAlerts} format={int}
          caption={data.pendingAlerts ? "Matches no one has decided yet." : "Nothing waiting for a decision."} onClick={can("alerts:view") ? () => navigate("/alerts") : undefined} />
        <KpiCard label="Capture to server" icon={Timer} value={data.avgLatencyMs ?? 0} format={(n) => (data.avgLatencyMs === null ? "—" : `${Math.round(n)} ms`)}
          trend={latency.some(Boolean) ? latency : undefined} caption={data.avgLatencyMs === null ? "Measured once reads arrive: time from capture to receipt." : "Mean time from capture to receipt, today."} />
        <KpiCard label="Cameras online" icon={CameraIcon} tone={data.totalCameras && data.activeCameras === data.totalCameras ? "ok" : "default"} value={data.activeCameras}
          format={(n) => `${Math.round(n)} / ${data.totalCameras}`} trend={anyReads ? daily.map((d) => d.camerasReporting) : undefined}
          caption={data.totalCameras ? (anyReads ? "Trend: cameras that sent reads each day." : "Status from the camera registry.") : "No camera registered yet."}
          onClick={can("registry:view") ? () => navigate("/admin/cameras") : undefined} />
        {data.integrity ? (
          <KpiCard label="Audit log integrity" icon={data.integrity.ok ? ShieldCheck : ShieldAlert} tone={data.integrity.ok ? "ok" : "danger"} value={data.integrity.entries}
            format={(n) => (data.integrity!.ok ? `${int(n)} verified` : `broken at #${data.integrity!.firstBadSeq}`)}
            caption={data.integrity.ok ? "Every entry's hash link and Ed25519 signature checked just now." : `Tampering detected: ${data.integrity.reason}.`} />
        ) : (
          <KpiCard label="Audit log integrity" icon={ShieldCheck} value={0} format={() => "Admins, auditors"} caption="Chain verification is shown to roles that can verify the audit log." />
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Reads per hour" subtitle="Last 24 hours, UTC, your cities"
            actions={<div className="flex items-center gap-4 text-xs text-muted"><span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-chart-1" aria-hidden /> Reads</span><span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] bg-gold" aria-hidden /> Watchlist hits</span></div>} />
          <div className="px-4 pb-4 pt-2">
            {data.hourly.some((h) => h.reads || h.hits) ? <HourlyReadsChart data={data.hourly} /> : (
              <div className="grid h-72 place-items-center text-center text-sm text-muted">No reads in the last 24 hours.</div>
            )}
          </div>
        </Card>
        <Card>{can("alerts:view") ? <RecentAlerts /> : <Restricted title="Recent alerts" what="watchlist alerts" />}</Card>
      </div>

      <Card>{can("registry:view") ? <CameraHealth /> : <Restricted title="Camera health" what="camera details" />}</Card>
    </RevealGroup>
  );
}

function Restricted({ title, what }: { title: string; what: string }) {
  return <><CardHeader title={title} /><div className="p-6"><EmptyState title="Not available for your role">Your role cannot see {what}.</EmptyState></div></>;
}

function RecentAlerts() {
  const alerts = useAlerts();
  const list = (alerts.data ?? []).slice(0, 6);
  const pending = (alerts.data ?? []).filter((a) => a.status === "pending").length;
  return (
    <>
      <CardHeader title="Recent alerts" subtitle={alerts.data ? `${pending} awaiting review` : "Loading…"}
        actions={<Link to="/alerts" className="focus-ring inline-flex items-center gap-1 rounded-xs text-sm text-accent hover:underline">Review <ArrowRight size={14} aria-hidden /></Link>} />
      {alerts.error ? <div className="p-6"><ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} /></div>
        : !alerts.data ? <LoadingBlock label="Loading alerts" />
        : !list.length ? <div className="p-6"><EmptyState title="No alerts">Nothing has matched a watchlist in your cities.</EmptyState></div>
        : (
          <ul className="space-y-1 p-3" aria-live="polite">
            <AnimatePresence initial={false}>
              {list.map((a) => (
                <motion.li key={a.id} layout initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }}>
                  <Link to={`/alerts?id=${a.id}`} className="focus-ring flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-bg-subtle">
                    <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", a.status === "pending" ? "bg-accent-soft text-accent" : "bg-bg-subtle text-muted")}>
                      {a.status === "pending" ? <Siren size={15} aria-hidden /> : a.status === "approved" ? <CheckCircle2 size={15} aria-hidden /> : <UserCheck size={15} aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <PlateText value={a.plate} size="sm" />
                        <Badge tone={PRIORITY_TONE[priorityOf(a.watchlistEntry.reason)]} className="h-5 px-2 text-[10px] uppercase tracking-wide">{a.watchlistEntry.reason}</Badge>
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted">{a.cityName} · {a.cameraName} · {relativeTime(a.observedAt)} · {REASON_LABELS[a.watchlistEntry.reason]}</span>
                    </span>
                  </Link>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      <p className="flex items-center gap-2 border-t border-border px-6 py-3 text-xs text-muted"><UserCheck size={14} className="text-accent" aria-hidden /> A person confirms every watchlist match.</p>
    </>
  );
}

function CameraHealth() {
  const cameras = useCameras();
  const cities = useCities();
  const order = { offline: 0, degraded: 1, unknown: 2, maintenance: 3, online: 4 } as const;
  const list = [...(cameras.data ?? [])].sort((a, b) => order[a.status] - order[b.status]).slice(0, 9);
  const city = (id: string) => cities.data?.find((c) => c.id === id)?.name ?? "—";
  return (
    <>
      <CardHeader title="Camera health" subtitle={cameras.data ? `${cameras.data.filter((c) => c.status === "online").length} of ${cameras.data.length} online · problems first` : "Loading…"}
        actions={<Link to="/admin/cameras" className="focus-ring inline-flex items-center gap-1 rounded-xs text-sm text-accent hover:underline">Cities &amp; Cameras <ArrowRight size={14} aria-hidden /></Link>} />
      {cameras.error ? <div className="p-6"><ErrorState error={cameras.error} onRetry={() => void cameras.refetch()} /></div>
        : !cameras.data ? <LoadingBlock label="Loading cameras" />
        : !list.length ? <div className="p-6"><EmptyState title="No cameras" action={<Link to="/admin/cameras" className="text-accent hover:underline">Register a camera</Link>}>No camera is registered in your cities yet.</EmptyState></div>
        : (
          <ul className="grid gap-3 p-6 pt-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((c) => (
              <li key={c.id} className={cn("rounded-md border p-3.5 transition-shadow hover:shadow-2", c.status === "offline" ? "border-danger/50 bg-danger-soft/50" : c.status === "degraded" ? "border-warn/50 bg-warn-soft/50" : "border-border bg-surface-raised/60")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="truncate text-sm font-medium">{c.name}</p><p className="truncate text-[11px] text-muted">{city(c.cityId)}{c.district ? ` · ${c.district}` : ""}</p></div>
                  <StatusChip status={c.status} />
                </div>
                <p className="mt-2 text-[11px] text-muted tabular">{c.lastFrameAt ? `Last frame ${relativeTime(c.lastFrameAt)}` : `No frame yet · ${STATUS_LABELS[c.status]}`}</p>
              </li>
            ))}
          </ul>
        )}
      <p className="flex items-center gap-2 border-t border-border px-6 py-3 text-xs text-muted"><ListChecks size={14} className="text-accent" aria-hidden /> Live OCR accuracy and plate types are not measured yet, so they are not shown.</p>
    </>
  );
}
