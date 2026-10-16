import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight, Camera as CameraIcon, CheckCircle2, Gauge, RefreshCw, ScanLine, ShieldAlert, ShieldCheck, Siren, Timer, UserCheck,
} from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { Alert, Camera, OverviewMetrics } from "../api/types";
import { useSession } from "../app/session";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardHeader, RevealGroup } from "../components/ui/Card";
import { KpiCard } from "../components/ui/KpiCard";
import { LiveDot } from "../components/ui/LiveDot";
import { PageHeader } from "../components/ui/PageHeader";
import { PlateText } from "../components/ui/PlateText";
import { LoadingBlock, Skeleton } from "../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../components/ui/States";
import { useToast } from "../components/ui/toast";
import { ALERT_STATUS, CAMERA_STATUS, PRIORITY_TONE, TLS_STATUS } from "../components/ui/tones";
import { HourlyReadsChart } from "../components/charts/HourlyReadsChart";
import { PlateTypeDonut } from "../components/charts/PlateTypeDonut";
import { cn } from "../lib/cn";
import { formatMs, formatNumber, formatTime, relativeTime } from "../lib/format";
import { priorityOf, REASON_LABELS } from "../lib/watchlist";

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function Overview() {
  const session = useSession();
  const overview = useApi((ctx) => api.getOverview(ctx));
  const [loadedAt, setLoadedAt] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (overview.data) setLoadedAt(new Date().toISOString());
  }, [overview.data]);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title={`${greeting()}, ${session.user.name.replace(/^Demo /, "").split(" ")[0]}`}
        description={
          session.role === "analyst"
            ? `Plate reads, watchlist matches and integrity for your ${session.user.allowedCityIds.length === 1 ? "city" : `${session.user.allowedCityIds.length} cities`}.`
            : "Plate reads, watchlist matches and platform integrity across all cities."
        }
        actions={
          <>
            <Badge tone="ok"><LiveDot className="mr-0.5" /> Live</Badge>
            <span className="text-xs text-muted">Updated {formatTime(loadedAt)}</span>
            <Button size="sm" variant="ghost" onClick={overview.reload} aria-label="Refresh overview">
              <RefreshCw size={14} className={overview.loading ? "animate-spin" : ""} aria-hidden /> Refresh
            </Button>
          </>
        }
      />
      {overview.error ? (
        <ErrorState error={overview.error} onRetry={overview.reload} />
      ) : !overview.data ? (
        <OverviewSkeleton />
      ) : (
        <OverviewBody data={overview.data} />
      )}
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading overview">
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-lg border border-border bg-surface p-5 shadow-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-5 h-9 w-36" />
            <Skeleton className="mt-4 h-3 w-44" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-80 rounded-lg lg:col-span-2" />
        <Skeleton className="h-80 rounded-lg" />
      </div>
    </div>
  );
}

function OverviewBody({ data }: { data: OverviewMetrics }) {
  const navigate = useNavigate();
  const { can } = useSession();
  const s = data.sparklines;
  const weekAvg = s.platesToday.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
  const offline = data.totalCameras - data.activeCameras;
  const tampered = data.integrity.status === "tamper_detected";

  return (
    <RevealGroup className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          label="Plates read today"
          icon={ScanLine}
          value={data.platesToday}
          format={formatNumber}
          trend={s.platesToday}
          caption={`So far today. Full days this week average ${formatNumber(weekAvg)}.`}
        />
        <KpiCard
          label="Watchlist hits today"
          icon={Siren}
          tone="gold"
          value={data.watchlistHits}
          format={formatNumber}
          trend={s.watchlistHits}
          caption="Each one is confirmed by a human before any action."
          onClick={can("alerts:view") ? () => navigate("/alerts") : undefined}
        />
        <KpiCard
          label="Average latency"
          icon={Timer}
          value={data.avgLatencyMs}
          format={(n) => formatMs(n)}
          trend={s.avgLatencyMs}
          caption="Capture to validated read, median across online cameras."
        />
        <KpiCard
          label="OCR plate accuracy"
          icon={Gauge}
          value={data.ocrAccuracy * 100}
          format={(n) => `${n.toFixed(1)}%`}
          trend={s.ocrAccuracy}
          caption={<>Synthetic test set, daylight. <Link to="/models" className="text-accent underline-offset-2 hover:underline">See all conditions</Link></>}
        />
        <KpiCard
          label="Active cameras"
          icon={CameraIcon}
          tone={offline ? "default" : "ok"}
          value={data.activeCameras}
          format={(n) => `${Math.round(n)} / ${data.totalCameras}`}
          trend={s.activeCameras}
          caption={offline ? <span className="text-danger">{offline} offline, see camera health below</span> : "All cameras reporting."}
        />
        <KpiCard
          label="Evidence integrity"
          icon={tampered ? ShieldAlert : ShieldCheck}
          tone={tampered ? "danger" : "ok"}
          value={tampered ? data.integrity.brokenLinks : data.integrity.checkedLinks}
          format={(n) => (tampered ? `${Math.round(n)} broken` : `${Math.round(n)} verified`)}
          caption={`${data.integrity.checkedLinks} signed records checked (SHA-256 chain, Ed25519).${tampered ? " Open the vault to inspect." : ""}`}
          onClick={can("evidence:view") ? () => navigate("/evidence") : undefined}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Reads per hour"
            subtitle="Last 24 hours, all sites"
            actions={
              <div className="flex items-center gap-4 text-xs text-muted">
                <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-chart-1" aria-hidden /> Reads</span>
                <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] bg-gold" aria-hidden /> Watchlist hits</span>
              </div>
            }
          />
          <div className="px-4 pb-4 pt-2">
            <HourlyReadsChart data={data.hourly} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Detections by plate type" subtitle="Today" />
          <div className="p-6 pt-4">
            <PlateTypeDonut data={data.byPlateType} />
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          {can("cameras:view") ? <CameraHealth /> : <RestrictedPanel title="Camera health" what="camera details" />}
        </Card>
        <Card>
          {can("alerts:view") ? <RecentAlerts /> : <RestrictedPanel title="Recent alerts" what="watchlist alerts" />}
        </Card>
      </div>
    </RevealGroup>
  );
}

function RestrictedPanel({ title, what }: { title: string; what: string }) {
  return (
    <>
      <CardHeader title={title} />
      <div className="p-6">
        <EmptyState title="Not available for your role">Your role cannot see {what}. This is the RBAC demo at work.</EmptyState>
      </div>
    </>
  );
}

function CameraHealth() {
  const cameras = useApi((ctx) => api.getCameras(ctx));
  return (
    <>
      <CardHeader
        title="Camera health"
        subtitle={cameras.data ? `${cameras.data.filter((c) => c.status === "online").length} of ${cameras.data.length} online` : "Loading…"}
        actions={<Link to="/cameras" className="focus-ring inline-flex items-center gap-1 rounded-xs text-sm text-accent hover:underline">All cameras <ArrowRight size={14} aria-hidden /></Link>}
      />
      {cameras.error ? (
        <div className="p-6"><ErrorState error={cameras.error} onRetry={cameras.reload} /></div>
      ) : !cameras.data ? (
        <LoadingBlock label="Loading cameras" />
      ) : (
        <ul className="grid gap-3 p-6 pt-4 sm:grid-cols-2 xl:grid-cols-3">
          {cameras.data.map((c) => <CameraTile key={c.id} camera={c} />)}
        </ul>
      )}
    </>
  );
}

function CameraTile({ camera: c }: { camera: Camera }) {
  const status = CAMERA_STATUS[c.status];
  return (
    <li
      className={cn(
        "rounded-md border p-3.5 transition-shadow hover:shadow-2",
        c.status === "offline" ? "border-danger bg-danger-soft" : c.status === "degraded" ? "border-warn bg-warn-soft" : "border-border bg-surface-raised",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{c.name}</p>
          <p className="font-mono text-[11px] text-muted">{c.id}</p>
        </div>
        <Badge tone={status.tone} dot>{status.label}</Badge>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div><dt className="text-muted">Latency</dt><dd className="font-mono tabular">{c.status === "offline" ? "—" : `${c.latencyMs} ms`}</dd></div>
        <div><dt className="text-muted">Today</dt><dd className="font-mono tabular">{formatNumber(c.readsToday)}</dd></div>
        <div><dt className="text-muted">TLS</dt><dd className={cn("font-medium", c.tlsStatus === "valid" ? "text-ok" : c.tlsStatus === "expiring" ? "text-warn" : c.tlsStatus === "expired" ? "text-danger" : "text-muted")}>{c.tlsStatus === "not_applicable" ? "n/a" : TLS_STATUS[c.tlsStatus].label}</dd></div>
      </dl>
    </li>
  );
}

function RecentAlerts() {
  const toast = useToast();
  const { token } = useSession();
  const initial = useApi((ctx) => api.getAlerts(ctx));
  const [live, setLive] = useState<Alert[]>([]);

  useEffect(() => {
    return api.subscribeAlerts({ token }, (a) => {
      setLive((xs) => [a, ...xs]);
      toast({
        tone: priorityOf(a.watchlistEntry.reason) === "critical" ? "critical" : "info",
        title: "New watchlist match",
        body: `${a.cityName} · ${a.cameraName} · ${REASON_LABELS[a.watchlistEntry.reason]}. Awaiting human review.`,
      });
    });
  }, [token, toast]);

  const alerts = [...live, ...(initial.data ?? []).filter((a) => !live.some((l) => l.id === a.id))].slice(0, 6);
  const pending = [...live, ...(initial.data ?? [])].filter((a) => a.status === "pending").length;

  return (
    <>
      <CardHeader
        title="Recent alerts"
        subtitle={initial.data ? `${pending} awaiting human review` : "Loading…"}
        actions={<Link to="/alerts" className="focus-ring inline-flex items-center gap-1 rounded-xs text-sm text-accent hover:underline">Review <ArrowRight size={14} aria-hidden /></Link>}
      />
      {initial.error ? (
        <div className="p-6"><ErrorState error={initial.error} onRetry={initial.reload} /></div>
      ) : !initial.data ? (
        <LoadingBlock label="Loading alerts" />
      ) : alerts.length === 0 ? (
        <div className="p-6"><EmptyState title="No alerts">No watchlist matches yet.</EmptyState></div>
      ) : (
        <ul className="space-y-1 p-3" aria-live="polite">
          <AnimatePresence initial={false}>
            {alerts.map((a) => {
              const fresh = live.some((l) => l.id === a.id);
              return (
                <motion.li
                  key={a.id}
                  layout
                  initial={{ opacity: 0, x: -16, scale: 0.98 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 320, damping: 28 }}
                >
                  <Link
                    to={`/alerts?id=${a.id}`}
                    className={cn(
                      "focus-ring flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-bg-subtle",
                      fresh && "bg-gold-soft ring-1 ring-gold",
                    )}
                  >
                    <span className={cn("grid size-8 shrink-0 place-items-center rounded-full", a.status === "pending" ? "bg-accent-soft text-accent" : "bg-bg-subtle text-muted")}>
                      {a.status === "pending" ? <Siren size={15} aria-hidden /> : a.status === "approved" ? <CheckCircle2 size={15} aria-hidden /> : <UserCheck size={15} aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <PlateText value={a.plate} size="sm" />
                        <Badge tone={PRIORITY_TONE[priorityOf(a.watchlistEntry.reason)]} className="h-5 px-2 text-[10px] uppercase tracking-wide">{a.watchlistEntry.reason}</Badge>
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted">{a.cityName} · {a.cameraName} · {relativeTime(a.capturedAt)}</span>
                    </span>
                    <span className="sr-only">{ALERT_STATUS[a.status].label}</span>
                  </Link>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
      <p className="flex items-center gap-2 border-t border-border px-6 py-3 text-xs text-muted">
        <UserCheck size={14} className="text-accent" aria-hidden /> A human confirms every watchlist match.
      </p>
    </>
  );
}
