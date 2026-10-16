/*
 * /camera and /camera/:id: live surveillance. For a local camera (this PC's webcam, protocol
 * File) the page captures ~2 frames/s, the API detects and reads plates, and every read goes
 * through the same watchlist matching as the camera worker: a stolen plate opens a pending alert
 * in Live Alerts immediately, flagged here in red. RTSP/RTSPS cameras are opened by the API, which
 * relays their video (NetworkStream) and reads plates on it; other network cameras send reads only.
 *
 * One frame in flight at a time (no backlog); on 429 the interval doubles. Frames go to the API
 * only; the API keeps a frame solely when it produced a report (evidence, 30-day retention).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Activity, ArrowUpRight, Cctv, Clapperboard, Cpu, Gauge, Plus, ScanLine, ShieldAlert, ShieldCheck, Siren, Square, VideoOff, Wifi } from "lucide-react";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { LiveDot } from "../../components/ui/LiveDot";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { PlateText } from "../../components/ui/PlateText";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useCameras, useCities } from "../cameras/hooks";
import { StatusChip } from "../cameras/ui";
import { ClearHistoryButton } from "../operations/ClearHistory";
import { useRecentReads } from "./api";
import { NetworkStream, useStreamStatus } from "./NetworkStream";
import { useLiveMonitor } from "./useLiveMonitor";
import { CameraRail, HudChip, IdleBeacon, ReadRow, TelemetryTile, ViewfinderCorners } from "./liveCameraUi";


export default function LiveCameraPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const cameras = useCameras();
  const cities = useCities();
  const selected = cameras.data?.find((c) => c.id === id) ?? null;
  const reads = useRecentReads(selected?.id);
  const cityName = (cid: string) => cities.data?.find((c) => c.id === cid)?.name ?? "—";
  const local = useMemo(() => cameras.data?.filter((c) => c.protocol === "file") ?? [], [cameras.data]);

  useEffect(() => {
    if (!id && cameras.data?.length) navigate(`/camera/${(local[0] ?? cameras.data[0]).id}`, { replace: true });
  }, [id, cameras.data, local, navigate]);

  return (
    <>
      <PageHeader eyebrow="Operate" title="Live surveillance"
        description="Watch a camera, read every plate it sees, and raise an alert the moment a watchlisted plate appears. A person still confirms every alert."
        actions={<span className="glass flex items-center gap-2 rounded-full py-2 pl-3 pr-4 text-xs text-muted shadow-1"><ShieldCheck size={15} className="text-accent-2" aria-hidden /> Detection on the server · video never recorded</span>} />
      {cameras.error ? <ErrorState error={cameras.error} onRetry={() => void cameras.refetch()} />
        : !cameras.data ? <Skeleton className="h-[480px] rounded-lg" />
        : !cameras.data.length ? (
          <Card className="p-6"><EmptyState title="No camera registered" action={can("admin:cameras") && <Link to="/admin/cameras" className="btn-primary inline-flex h-10 items-center gap-2 rounded-sm px-4 text-sm font-medium"><Plus size={15} aria-hidden /> Register this PC's webcam</Link>}>
            Register this computer's webcam in Cities &amp; Cameras with protocol <strong>File</strong> (a local source) and its real location. Then come back here to monitor it.
          </EmptyState></Card>
        ) : (
          <>
          <CameraRail cameras={cameras.data} selectedId={selected?.id ?? null} cityName={cityName} />
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(340px,1fr)]">
            <div className="space-y-4">
              {selected && (
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="font-display text-xl font-semibold tracking-tight">{selected.name}</h2>
                  <StatusChip status={selected.status} />
                  <span className="text-sm text-muted">{cityName(selected.cityId)}{selected.streetAddress ? ` · ${selected.streetAddress}` : ""}</span>
                  {selected.protocol !== "file" && <Badge tone="neutral">{selected.protocol === "rtsp" || selected.protocol === "rtsps" ? "video relayed by the API" : "monitored by the camera worker"}</Badge>}
                </div>
              )}
              {selected?.protocol === "file" ? (
                <Monitor key={selected.id} cameraId={selected.id} cameraName={selected.name} />
              ) : selected && (selected.protocol === "rtsp" || selected.protocol === "rtsps") ? (
                <NetworkView key={selected.id} cameraId={selected.id} cameraName={selected.name} canLive={can("camera:live")} />
              ) : (
                <Card className="relative grid aspect-video place-items-center overflow-hidden p-8 text-center">
                  <ViewfinderCorners />
                  <div className="max-w-md space-y-4">
                    <span className="mx-auto block w-fit"><IdleBeacon icon={Wifi} /></span>
                    <p className="font-display text-xl font-semibold">No video for this camera</p>
                    <p className="text-sm text-muted">Live video is relayed for RTSP and RTSPS cameras. This one sends plate reads only; they appear in the feed on the right as they arrive.</p>
                    {!local.length && can("admin:cameras") && <Link to="/admin/cameras" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">Register this PC's webcam <ArrowUpRight size={13} aria-hidden /></Link>}
                  </div>
                </Card>
              )}
            </div>
            <Card className="h-fit overflow-hidden xl:sticky xl:top-[calc(var(--topbar-h)+1.5rem)]">
              <CardHeader title="Plate reads" subtitle={selected ? `${selected.name}, all sources` : "All cameras"}
                actions={<span className="flex items-center gap-3 text-xs text-muted"><span className="flex items-center gap-2"><LiveDot /> <Activity size={13} className={reads.isFetching ? "text-accent" : ""} aria-hidden /> every 5 s</span><ClearHistoryButton size="sm" /></span>} />
              <div className="mx-6 mt-4 h-px bg-border" aria-hidden />
              {reads.error ? <div className="p-6"><ErrorState error={reads.error} onRetry={() => void reads.refetch()} /></div>
                : !reads.data ? <div className="space-y-2 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14 rounded-md" />)}</div>
                : !reads.data.length ? <div className="p-6"><EmptyState title="No reads yet">Start monitoring (or the camera worker). Reads appear here within seconds.</EmptyState></div>
                : (
                  <ul className="max-h-[calc(100vh-18rem)] space-y-1.5 overflow-y-auto p-3" aria-live="polite">
                    <AnimatePresence initial={false}>
                      {reads.data.map((r) => (
                        <motion.li key={r.detectionId} layout initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }}
                          className={cn("rounded-md border p-3 transition-colors", r.alerts ? "border-danger bg-danger-soft/70 shadow-[0_12px_32px_-16px_var(--danger)]" : "border-transparent hover:bg-bg-subtle/60")}>
                          <ReadRow plate={r.plateMasked} confidence={r.plateConfidence} when={relativeTime(r.observedAt)}
                            tone={r.alerts > 0 ? "watch" : r.plateValid ? "ok" : "weak"}
                            note={r.alerts > 0 ? <Link to="/alerts" className="inline-flex items-center gap-1 font-bold uppercase tracking-wide text-danger hover:underline"><Siren size={12} aria-hidden /> watchlist · review alert</Link>
                              : !r.plateValid ? <span className="text-faint">Unreadable</span> : null} />
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                )}
            </Card>
          </div>
          </>
        )}
    </>
  );
}

function Monitor({ cameraId, cameraName }: { cameraId: string; cameraName: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const { state, stats, hits, alarm, setAlarm, modelNote, devices, deviceId, setDeviceId, start, stop, supported } =
    useLiveMonitor({ cameraId, cameraName, video, overlay });
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const live = state.kind === "live";
  return (
    <div className="space-y-4">
      <AnimatePresence>
        {alarm && (
          <motion.div role="alert" initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }}
            className="relative flex flex-wrap items-center gap-4 overflow-hidden rounded-lg border-2 border-danger bg-danger-soft px-5 py-4 shadow-[0_0_0_4px_color-mix(in_oklab,var(--danger)_25%,transparent),0_20px_50px_-20px_var(--danger)]">
            <span className="relative grid size-12 shrink-0 place-items-center rounded-full bg-danger text-white">
              <span className="absolute inset-0 rounded-full bg-danger motion-safe:animate-[live-pulse_1.4s_var(--ease-out)_infinite]" aria-hidden />
              <ShieldAlert size={22} className="relative" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-display text-lg font-bold uppercase tracking-wide text-danger">{alarm.reason === "stolen" ? "Stolen vehicle detected" : "Watchlist plate detected"}</p>
              <p className="flex flex-wrap items-center gap-2 text-sm text-text"><PlateText value={alarm.plate} size="sm" /> {alarm.listName} · {cameraName} · pending human review</p>
            </div>
            <Link to={`/alerts?id=${alarm.id}`} className="btn-primary inline-flex h-10 items-center gap-2 rounded-sm px-4 text-sm font-semibold">Review in Live Alerts <ArrowUpRight size={15} aria-hidden /></Link>
            <button type="button" onClick={() => setAlarm(null)} className="focus-ring rounded-xs text-xs text-muted hover:text-text">Dismiss</button>
          </motion.div>
        )}
      </AnimatePresence>

      <Card className={cn("overflow-hidden", alarm && "ring-2 ring-danger")}>
        <div className="relative bg-[radial-gradient(70%_60%_at_50%_40%,var(--bg-subtle),var(--plate-ink))]">
          <video ref={video} autoPlay playsInline muted aria-label={`Live video from ${cameraName}`} className={cn("block aspect-video w-full object-contain", !live && "opacity-0")} />
          <canvas ref={overlay} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />
          {live && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center justify-between gap-2 px-5 py-4">
                <HudChip className="font-semibold uppercase tracking-[0.15em]"><LiveDot tone="danger" /> Live · {cameraName}</HudChip>
                <HudChip className="tabular">{clock.toLocaleDateString()} {clock.toLocaleTimeString()}</HudChip>
              </div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 px-5 py-4">
                <HudChip className="text-accent-2"><ScanLine size={12} aria-hidden /> ANPR active</HudChip>
                <HudChip className="tabular">{stats.fps || "…"} fps</HudChip>
                <HudChip className="tabular">{stats.ms ? `${Math.round(stats.ms)} ms` : "loading model…"}</HudChip>
              </div>
              <span className="scan-beam opacity-40" aria-hidden />
            </>
          )}
          {!live && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/80">
              {state.kind === "starting" ? "Starting the camera… your browser may ask for permission."
                : state.kind === "error" ? <span className="flex max-w-md flex-col items-center gap-2"><VideoOff size={24} aria-hidden />{state.message}</span>
                : <span className="flex flex-col items-center gap-4"><IdleBeacon icon={Cctv} /><span className="font-display text-xl font-semibold text-white">{cameraName}</span>Start monitoring to detect and read plates in real time.</span>}
            </div>
          )}
          <ViewfinderCorners />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            {devices.length > 1 && (
              <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); if (live) void start(e.target.value); }} aria-label="Webcam" className="focus-ring h-9 rounded-sm border border-border bg-surface px-2 text-sm text-text">
                <option value="">Default webcam</option>
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            )}
            <span className="flex items-center gap-1.5"><Cpu size={13} aria-hidden /> Detection runs on the server; video is not recorded.</span>
          </div>
          {live ? <Button variant="danger" className="h-11 px-5" onClick={stop}><Square size={13} aria-hidden /> Stop monitoring</Button>
            : <Button variant="primary" className="h-11 px-5" onClick={() => void start()} loading={state.kind === "starting"} disabled={!supported}><Cctv size={15} aria-hidden /> Start monitoring</Button>}
        </div>
        {modelNote && <p className="border-t border-border bg-warn-soft px-4 py-2 text-xs text-warn">{modelNote}</p>}
      </Card>

      <section aria-label="Session telemetry" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <TelemetryTile label="Frames" value={stats.frames.toLocaleString()} icon={Clapperboard} color="var(--accent)" hint={live ? `${stats.fps || "…"} fps` : "not monitoring"} />
        <TelemetryTile label="Plates read" value={stats.plates.toLocaleString()} icon={ScanLine} color="var(--accent-2)" hint="reported reads" />
        <TelemetryTile label="Alerts" value={stats.alerts.toLocaleString()} icon={Siren} color="var(--danger)" hint="sent for human review" />
        <TelemetryTile label="Latency" value={stats.ms ? `${Math.round(stats.ms)} ms` : "—"} icon={Gauge} color="var(--gold)" hint="server inference" />
      </section>

      <Card>
        <CardHeader title="This session" subtitle="Plates read since you started monitoring (masked unless you review alerts)" />
        {!hits.length ? <p className="px-6 pb-6 text-sm text-muted">{live ? "Watching… hold a plate in front of the camera." : "Nothing yet."}</p> : (
          <ul className="max-h-80 space-y-1.5 overflow-y-auto p-3">
            {hits.map((h) => (
              <motion.li key={h.id} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className={cn("rounded-md border p-3", h.alert ? "border-danger bg-danger-soft" : "border-transparent hover:bg-bg-subtle/60")}>
                <ReadRow plate={h.plate} confidence={h.confidence} when={new Date(h.at).toLocaleTimeString()} tone={h.alert ? "watch" : h.valid ? "ok" : "weak"}
                  note={h.alert ? <Link to={`/alerts?id=${h.alert.id}`} className="font-semibold text-danger hover:underline">ALERT · {h.alert.listName} · review</Link>
                    : !h.valid ? <span className="text-warn">Not a valid plate</span> : null} />
              </motion.li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function NetworkView({ cameraId, cameraName, canLive }: { cameraId: string; cameraName: string; canLive: boolean }) {
  const status = useStreamStatus(cameraId, canLive);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const s = status.data;
  if (!canLive) return <Card className="grid aspect-video place-items-center p-8 text-center text-sm text-muted">Your role does not include live video.</Card>;
  return (
    <Card className="overflow-hidden">
      <div className="relative aspect-video">
        <NetworkStream cameraId={cameraId} cameraName={cameraName} status={s} />
        {s?.state === "live" && (
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center justify-between gap-2 px-5 py-4">
              <HudChip className="font-semibold uppercase tracking-[0.15em]"><LiveDot tone="danger" /> Live · {cameraName}</HudChip>
              <HudChip className="tabular">{clock.toLocaleDateString()} {clock.toLocaleTimeString()}</HudChip>
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 px-5 py-4">
              <HudChip className="text-accent-2"><ScanLine size={12} aria-hidden /> ANPR on the server</HudChip>
              <HudChip className="tabular">{s.fps || "…"} fps</HudChip>
              {s.width && <HudChip className="tabular">{s.width}×{s.height}</HudChip>}
            </div>
          </>
        )}
        <ViewfinderCorners />
      </div>
      <p className="flex items-center gap-1.5 p-4 text-xs text-muted"><Cpu size={13} aria-hidden /> The API opens the camera stream (credentials never reach this browser) and reads plates on it. Video is not recorded; every view is audited.</p>
    </Card>
  );
}
