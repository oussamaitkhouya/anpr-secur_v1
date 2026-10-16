/*
 * Live wall: every camera of the current city filter as a tile, like a control-room video wall.
 *
 *   RTSP/RTSPS camera   video relayed by the API (NetworkStream), plates read on the server
 *   local webcam (File) video from this browser, frames sent to the API for plate reading
 *                       (useLiveMonitor, the same loop as the Live page); starts on a click
 *                       because the browser asks for camera permission
 *   other protocols     no video; the tile shows the camera's plate reads only
 *
 * Every tile lists the camera's latest plate reads (masked unless the role reviews alerts) and
 * turns red when a read matched a watchlist. Alerts are still decided by a person in Live Alerts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { motion } from "framer-motion";
import { ArrowUpRight, Cctv, Columns2, Columns3, Info, LayoutGrid, MapPin, Play, Radio, ScanLine, Siren, Square, Webcam } from "lucide-react";
import { LiveDot } from "../../components/ui/LiveDot";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { readPref, writePref } from "../../lib/storage";
import { useRecentReads, type Read } from "../insight/api";
import { HudChip, ReadRow, ViewfinderCorners } from "../insight/liveCameraUi";
import { NetworkStream, useStreamStatus } from "../insight/NetworkStream";
import { useLiveMonitor } from "../insight/useLiveMonitor";
import { KindIcon, StatusChip } from "./ui";
import type { RegistryCamera } from "./types";

type Cols = 1 | 2 | 3;
const COLS: Record<Cols, string> = { 1: "grid-cols-1", 2: "grid-cols-1 lg:grid-cols-2", 3: "grid-cols-1 md:grid-cols-2 2xl:grid-cols-3" };
const READS_PER_TILE = 3;

const isStreamed = (c: RegistryCamera) => c.protocol === "rtsp" || c.protocol === "rtsps";
const isLocal = (c: RegistryCamera) => c.protocol === "file";

export function LiveWall({ cameras, cityName, canLive, onOpen }: {
  cameras: RegistryCamera[];
  cityName: (id: string) => string;
  canLive: boolean;
  onOpen: (id: string) => void;
}) {
  const [cols, setCols] = useState<Cols>(() => (Number(readPref("wall.cols")) as Cols) || 2);
  const [startAll, setStartAll] = useState(0);
  const [stopAll, setStopAll] = useState(0);
  const reads = useRecentReads();
  const byCamera = useMemo(() => {
    const m = new Map<string, Read[]>();
    for (const r of reads.data ?? []) m.set(r.cameraId, [...(m.get(r.cameraId) ?? []), r]);
    return m;
  }, [reads.data]);
  // video tiles first (relayed, then local), then the rest; alphabetical inside each group
  const sorted = useMemo(() => [...cameras].sort((a, b) =>
    Number(isStreamed(b)) - Number(isStreamed(a)) || Number(isLocal(b)) - Number(isLocal(a)) || a.name.localeCompare(b.name)), [cameras]);
  const locals = cameras.filter(isLocal).length;
  const streamed = cameras.filter(isStreamed).length;

  const pick = (c: Cols) => { setCols(c); writePref("wall.cols", String(c)); };

  if (!cameras.length) return <EmptyState title="No camera to show">Add a camera, or pick another city, to fill the wall.</EmptyState>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span className="flex items-center gap-1.5"><LayoutGrid size={14} aria-hidden /> {cameras.length} camera{cameras.length === 1 ? "" : "s"}</span>
          <span className="flex items-center gap-1.5"><Radio size={14} aria-hidden /> {streamed} network video</span>
          <span className="flex items-center gap-1.5"><Webcam size={14} aria-hidden /> {locals} local</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {canLive && locals > 0 && (
            <>
              <Button size="sm" onClick={() => setStartAll((n) => n + 1)}><Play size={13} aria-hidden /> Start local cameras</Button>
              <Button size="sm" variant="ghost" onClick={() => setStopAll((n) => n + 1)}><Square size={12} aria-hidden /> Stop</Button>
            </>
          )}
          <div role="radiogroup" aria-label="Tiles per row" className="inline-flex rounded-full border border-border bg-surface/60 p-0.5">
            {([[1, Square], [2, Columns2], [3, Columns3]] as const).map(([n, Icon]) => (
              <button key={n} type="button" role="radio" aria-checked={cols === n} aria-label={`${n} per row`} onClick={() => pick(n)}
                className={cn("focus-ring grid size-8 place-items-center rounded-full transition-colors", cols === n ? "bg-accent-soft text-accent" : "text-muted hover:text-text")}>
                <Icon size={14} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      </div>

      <ul className={cn("grid gap-4", COLS[cols])} aria-label="Live cameras">
        {sorted.map((c, i) => (
          <motion.li key={c.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.04, duration: 0.35 }}>
            <Tile camera={c} city={cityName(c.cityId)} reads={byCamera.get(c.id) ?? []} canLive={canLive} onOpen={() => onOpen(c.id)}
              startSignal={startAll} stopSignal={stopAll} />
          </motion.li>
        ))}
      </ul>
      {!canLive && <p className="text-xs text-muted">Your role can see the cameras and their reads, not their live video.</p>}
    </div>
  );
}

function Tile({ camera, city, reads, canLive, onOpen, startSignal, stopSignal }: {
  camera: RegistryCamera;
  city: string;
  reads: Read[];
  canLive: boolean;
  onOpen: () => void;
  startSignal: number;
  stopSignal: number;
}) {
  const alerted = reads.slice(0, READS_PER_TILE).some((r) => r.alerts > 0);
  const where = [city, camera.district, camera.streetAddress].filter(Boolean).join(" · ");
  return (
    <article aria-label={camera.name} className={cn("card-surface flex h-full flex-col overflow-hidden rounded-lg shadow-1 transition-shadow",
      alerted && "ring-2 ring-danger shadow-[0_18px_40px_-20px_var(--danger)]")}>
      <div className="relative aspect-video bg-[var(--plate-ink)]">
        {!canLive ? <NoVideo icon={Cctv}>Live video is not part of your role.</NoVideo>
          : isStreamed(camera) ? <StreamedVideo camera={camera} />
          : isLocal(camera) ? <LocalVideo camera={camera} startSignal={startSignal} stopSignal={stopSignal} />
          : <NoVideo icon={Radio}>This camera sends plate reads only ({camera.protocol.toUpperCase()}). No video to relay.</NoVideo>}
        {camera.status === "maintenance" && (
          <span className="pointer-events-none absolute right-3 top-12 rounded-full bg-accent px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white">Maintenance</span>
        )}
        <ViewfinderCorners />
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-display text-base font-semibold">
              <KindIcon kind={camera.kind} size={15} className="shrink-0 text-muted" />
              <span className="truncate">{camera.name}</span>
            </p>
            <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted"><MapPin size={12} className="shrink-0" aria-hidden />{where || "—"}</p>
          </div>
          <StatusChip status={camera.status} className="shrink-0" />
        </div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <Fact label="Source">{isLocal(camera) ? "This PC" : camera.protocol.toUpperCase()}</Fact>
          <Fact label="Last read">{camera.lastFrameAt ? relativeTime(camera.lastFrameAt) : "never"}</Fact>
          <Fact label="Lane">{camera.lane ?? "—"}</Fact>
        </dl>

        <div className="min-h-[7.5rem] flex-1">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-faint"><ScanLine size={12} aria-hidden /> Latest plates</p>
          {!reads.length ? <p className="text-xs text-muted">No plate read yet.</p> : (
            <ul className="space-y-1" aria-live="polite">
              {reads.slice(0, READS_PER_TILE).map((r) => (
                <li key={r.detectionId} className={cn("rounded-md border px-2.5 py-2", r.alerts ? "border-danger bg-danger-soft/70" : "border-transparent bg-bg-subtle/50")}>
                  <ReadRow plate={r.plateMasked} confidence={r.plateConfidence} when={relativeTime(r.observedAt)} tone={r.alerts ? "watch" : r.plateValid ? "ok" : "weak"}
                    note={r.alerts ? <Link to="/alerts" className="inline-flex items-center gap-1 font-bold uppercase tracking-wide text-danger hover:underline"><Siren size={12} aria-hidden /> watchlist · review</Link> : undefined} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/70 pt-3">
          <Button size="sm" variant="ghost" onClick={onOpen}><Info size={13} aria-hidden /> Details</Button>
          <Link to={`/camera/${camera.id}`} className="focus-ring inline-flex h-8 items-center gap-1 rounded-sm px-3 text-xs font-medium text-accent hover:bg-accent-soft">
            Full view <ArrowUpRight size={13} aria-hidden />
          </Link>
        </div>
      </div>
    </article>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-sm bg-bg-subtle/60 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-[0.1em] text-faint">{label}</dt>
      <dd className="truncate font-medium">{children}</dd>
    </div>
  );
}

function NoVideo({ icon: Icon, children }: { icon: typeof Cctv; children: ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/75">
      <span className="flex max-w-xs flex-col items-center gap-2"><Icon size={22} aria-hidden />{children}</span>
    </div>
  );
}

function useClock() {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return clock;
}

function Hud({ name, live, right, bottom }: { name: string; live: boolean; right?: ReactNode; bottom?: ReactNode }) {
  const clock = useClock();
  if (!live) return null;
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 px-4 py-3">
        <HudChip className="max-w-[60%] truncate font-semibold uppercase tracking-[0.12em]"><LiveDot tone="danger" /> {name}</HudChip>
        <HudChip className="tabular">{clock.toLocaleTimeString()}</HudChip>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-1.5 px-4 py-3">
        <HudChip className="text-accent-2"><ScanLine size={11} aria-hidden /> ANPR</HudChip>
        {bottom}
        {right}
      </div>
    </>
  );
}

function StreamedVideo({ camera }: { camera: RegistryCamera }) {
  const status = useStreamStatus(camera.id);
  const s = status.data;
  return (
    <>
      <NetworkStream cameraId={camera.id} cameraName={camera.name} status={s} className="absolute inset-0" />
      <Hud name={camera.name} live={s?.state === "live"}
        bottom={<HudChip className="tabular">{s?.fps || "…"} fps</HudChip>}
        right={s?.width ? <HudChip className="tabular">{s.width}×{s.height}</HudChip> : undefined} />
    </>
  );
}

function LocalVideo({ camera, startSignal, stopSignal }: { camera: RegistryCamera; startSignal: number; stopSignal: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const device = readPref(`wall.device.${camera.id}`) ?? "";
  const m = useLiveMonitor({ cameraId: camera.id, cameraName: camera.name, video, overlay, initialDeviceId: device });
  const { start, stop } = m;

  // "Start local cameras" / "Stop" in the wall toolbar
  // (each signal is handled once, even when start/stop change identity, e.g. after a device switch)
  const handledStart = useRef(startSignal);
  const handledStop = useRef(stopSignal);
  useEffect(() => {
    if (startSignal === handledStart.current) return;
    handledStart.current = startSignal;
    void start();
  }, [startSignal, start]);
  useEffect(() => {
    if (stopSignal === handledStop.current) return;
    handledStop.current = stopSignal;
    stop();
  }, [stopSignal, stop]);

  const pickDevice = (id: string) => {
    m.setDeviceId(id);
    writePref(`wall.device.${camera.id}`, id);
    if (m.live) void start(id);
  };

  return (
    <>
      <video ref={video} autoPlay playsInline muted aria-label={`Live video from ${camera.name}`}
        className={cn("absolute inset-0 h-full w-full object-contain", !m.live && "opacity-0")} />
      <canvas ref={overlay} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />
      <Hud name={camera.name} live={m.live}
        bottom={<HudChip className="tabular">{m.stats.fps || "…"} fps</HudChip>}
        right={m.stats.ms ? <HudChip className="tabular">{Math.round(m.stats.ms)} ms</HudChip> : undefined} />
      {m.live && (
        <button type="button" onClick={stop} aria-label={`Stop ${camera.name}`}
          className="focus-ring absolute bottom-3 right-3 grid size-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-danger">
          <Square size={12} aria-hidden />
        </button>
      )}
      {m.alarm && (
        <Link to={`/alerts?id=${m.alarm.id}`} role="alert"
          className="absolute inset-x-3 top-12 flex items-center gap-2 rounded-md bg-danger px-3 py-2 text-xs font-semibold text-white shadow-2">
          <Siren size={14} aria-hidden /> {m.alarm.reason === "stolen" ? "Stolen vehicle" : "Watchlist plate"} · {m.alarm.listName} · review
        </Link>
      )}
      {!m.live && (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white/80">
          <span className="flex max-w-xs flex-col items-center gap-3">
            {m.state.kind === "error" ? <span>{m.state.message}</span> : <span className="flex items-center gap-2"><Webcam size={16} aria-hidden /> Local camera on this PC</span>}
            <span className="flex flex-wrap items-center justify-center gap-2">
              {m.devices.length > 1 && (
                <select value={m.deviceId} onChange={(e) => pickDevice(e.target.value)} aria-label={`Webcam for ${camera.name}`}
                  className="focus-ring h-8 max-w-[11rem] rounded-sm border border-white/20 bg-black/50 px-2 text-xs text-white">
                  <option value="">Default webcam</option>
                  {m.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              )}
              <Button size="sm" variant="primary" onClick={() => void start()} loading={m.state.kind === "starting"} disabled={!m.supported}>
                <Play size={13} aria-hidden /> Start
              </Button>
            </span>
          </span>
        </div>
      )}
      {m.modelNote && m.live && <p className="absolute inset-x-0 bottom-12 mx-4 rounded-sm bg-warn-soft px-2 py-1 text-[11px] text-warn">{m.modelNote}</p>}
    </>
  );
}
