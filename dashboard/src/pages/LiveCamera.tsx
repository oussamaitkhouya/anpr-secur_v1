import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import {
  Camera, CameraOff, EyeOff, Loader2, Lock, Play, ShieldAlert, Square, UserCheck, Video, VideoOff,
} from "lucide-react";
import { api } from "../api/client";
import { useApi, useRequestContext } from "../api/useApi";
import type { Camera as CameraInfo, Detection } from "../api/types";
import { useSession } from "../app/session";
import { setCameraActive } from "../camera/activeStore";
import { DEFAULT_FPS, FrameCapturer } from "../camera/frameCapture";
import { drawDetections } from "../camera/overlay";
import {
  cameraReducer, INITIAL_CAMERA_STATE, listCameras, requestCamera, stopStream, type CameraState,
} from "../camera/permission";
import { AlertCard } from "../components/ui/AlertCard";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardHeader, RevealGroup } from "../components/ui/Card";
import { LiveDot } from "../components/ui/LiveDot";
import { PageHeader } from "../components/ui/PageHeader";
import { PlateText } from "../components/ui/PlateText";
import { Switch } from "../components/ui/Switch";
import { LoadingBlock } from "../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../components/ui/States";
import { useToast } from "../components/ui/toast";
import { cn } from "../lib/cn";
import { formatNumber, formatTime } from "../lib/format";
import { readPref, writePref } from "../lib/storage";
import { priorityOf, REASON_LABELS } from "../lib/watchlist";

type Mode = "off" | "mock" | "model";

interface Recent {
  key: string;
  plate: string;
  confidence: number;
  at: string;
  match: Detection["watchlistMatch"];
  alertId: string | null;
}

const newSessionId = () => `cam-${crypto.randomUUID().slice(0, 8)}`;

/** Live view of one browser-webcam camera. Keyed by camera id, so switching cameras remounts it. */
function LiveView({ camera }: { camera: CameraInfo }) {
  const ctx = useRequestContext();
  const cameraIdRef = useRef(camera.id);
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useSession();
  const [state, dispatch] = useReducer(cameraReducer, INITIAL_CAMERA_STATE);
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [mirrored, setMirrored] = useState(() => readPref("camera.mirror") !== "off");
  const [mode, setMode] = useState<Mode>("mock");
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [readout, setReadout] = useState({ width: 0, height: 0, fps: 0 });
  const [stats, setStats] = useState({ frames: 0, latencyMs: 0 });
  const [detections, setDetections] = useState<Detection[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturer = useRef(new FrameCapturer());
  const seenAlerts = useRef(new Set<string>());
  const sessionId = useRef(newSessionId());
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const live = state.status === "live";

  // ---- start / stop ------------------------------------------------------------------

  /** Release the stream and audit the stop, without touching the UI state. Safe to call twice. */
  const release = useCallback((reason: string) => {
    const stream = streamRef.current;
    capturer.current.stop();
    if (!stream) return;
    streamRef.current = null;
    stopStream(stream);
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setDetections([]);
    api.recordCameraEvent(ctxRef.current, cameraIdRef.current, "stop", reason).catch(() => {});
  }, []);

  const stop = useCallback((reason: string) => {
    release(reason);
    dispatch({ type: "STOP" });
  }, [release]);

  const start = useCallback(async (id: string = deviceId) => {
    dispatch({ type: "START" });
    const { event, stream } = await requestCamera(navigator.mediaDevices, { deviceId: id || null });
    if (!stream || event.type !== "GRANTED") {
      dispatch(event);
      return;
    }
    streamRef.current = stream;
    sessionId.current = newSessionId();
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      await video.play().catch(() => {});
    }
    const track = stream.getVideoTracks()[0];
    track.addEventListener("ended", () => {
      dispatch({ type: "ENDED", message: "The camera stopped (unplugged or access revoked)." });
      release("device disconnected");
    });
    dispatch(event);
    setCameraActive(true);
    setStats({ frames: 0, latencyMs: 0 });
    setDevices(await listCameras(navigator.mediaDevices)); // labels are available after the grant
    if (event.deviceId) setDeviceId(event.deviceId);
    try {
      await api.recordCameraEvent(ctxRef.current, cameraIdRef.current, "start", event.label);
    } catch (err) {
      // Auditing is a precondition for using the camera: no audit entry, no stream.
      stop("audit failed");
      toast({ tone: "error", title: "Camera stopped", body: err instanceof Error ? err.message : "The start could not be audited." });
    }
  }, [deviceId, release, stop, toast]);

  // stop on unmount, and whenever the page is hidden (tab switch, minimise, navigation)
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") stop("page hidden");
    };
    const onPageHide = () => stop("page closed");
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      stop("left the page");
    };
  }, [stop]);

  useEffect(() => {
    listCameras(navigator.mediaDevices).then(setDevices);
  }, []);

  // ---- frame capture -> (mock) detector ----------------------------------------------

  useEffect(() => {
    const video = videoRef.current;
    if (!live || mode === "off" || !video) {
      capturer.current.stop();
      setDetections([]);
      return;
    }
    const cap = capturer.current;
    cap.start(video, async (frame) => {
      const t0 = performance.now();
      try {
        await api.sendFrame(ctxRef.current, { ...frame, sessionId: sessionId.current, cameraId: cameraIdRef.current });
        const dets = await api.getDetections(ctxRef.current, sessionId.current);
        setDetections(dets);
        setStats((s) => ({ frames: s.frames + 1, latencyMs: Math.round(performance.now() - t0) }));
        setRecent((rs) => {
          let next = rs;
          for (const d of dets) {
            if (next.some((r) => r.key === d.id)) continue;
            next = [{ key: d.id, plate: d.plate, confidence: d.confidence, at: frame.capturedAt, match: d.watchlistMatch, alertId: d.alertId }, ...next];
            if (d.watchlistMatch && d.alertId && !seenAlerts.current.has(d.alertId)) {
              seenAlerts.current.add(d.alertId);
              toast({ tone: "critical", title: `Alert ${d.alertId}: needs human review`, body: `${REASON_LABELS[d.watchlistMatch.reason]} · ${d.watchlistMatch.caseRef}. Nothing happens until a person confirms it.` });
            }
          }
          return next.slice(0, 12);
        });
      } catch (err) {
        cap.stop();
        toast({ tone: "error", title: "Detection stopped", body: err instanceof Error ? err.message : "Frame could not be processed." });
      }
    }, { fps });
    return () => cap.stop();
  }, [live, mode, fps, toast]);

  // ---- overlay drawing + resolution / fps readout ------------------------------------

  const detectionsRef = useRef(detections);
  detectionsRef.current = detections;

  useEffect(() => {
    if (!live) return;
    let raf = 0;
    let frames = 0;
    let lastTime = -1;
    let windowStart = performance.now();
    const loop = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas) {
        if (video.currentTime !== lastTime) {
          frames++;
          lastTime = video.currentTime;
        }
        const now = performance.now();
        if (now - windowStart >= 1000) {
          setReadout({ width: video.videoWidth, height: video.videoHeight, fps: Math.round((frames * 1000) / (now - windowStart)) });
          frames = 0;
          windowStart = now;
        }
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const g = canvas.getContext("2d");
        if (g) drawDetections(g, detectionsRef.current, { width: w, height: h, dpr, mirrored });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [live, mirrored]);

  const switchDevice = (id: string) => {
    setDeviceId(id);
    if (live) {
      stop("switched device");
      void start(id);
    }
  };

  const aspect = readout.width && readout.height ? `${readout.width} / ${readout.height}` : "16 / 9";
  const raised = recent.filter((r) => r.match && r.alertId).filter((r, i, all) => all.findIndex((x) => x.alertId === r.alertId) === i).slice(0, 3);

  return (
    <>
      <PageHeader
        eyebrow={`${camera.cityName} · plate testing`}
        title={camera.name}
        description="Point a browser camera at a printed or on-screen test plate. Frames stay in this browser: they are never stored, uploaded or logged. No face recognition is performed."
        actions={live ? <Badge tone="danger"><LiveDot tone="danger" className="mr-0.5" /> LIVE</Badge> : <Badge tone="neutral">Camera off</Badge>}
      />

      <RevealGroup className="grid items-start gap-6 xl:grid-cols-[1fr_340px]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3.5">
            <label className="flex min-w-0 items-center gap-2 text-sm">
              <span className="text-muted">Device</span>
              <select
                value={deviceId}
                onChange={(e) => switchDevice(e.target.value)}
                className="focus-ring h-9 max-w-56 truncate rounded-sm border border-border bg-surface px-2 text-sm shadow-1"
              >
                <option value="">Default camera</option>
                {devices.map((d) => <option key={d.deviceId || d.label} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
            <ModeSwitch mode={mode} onChange={setMode} />
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Capture</span>
              <select value={fps} onChange={(e) => setFps(Number(e.target.value))} className="focus-ring h-9 rounded-sm border border-border bg-surface px-2 text-sm shadow-1">
                {[1, 2, 5].map((f) => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </label>
            <div className="ml-auto flex items-center gap-2">
              {live ? (
                <Button variant="danger" onClick={() => stop("stopped by user")}><Square size={14} aria-hidden /> Stop camera</Button>
              ) : (
                <Button variant="primary" onClick={() => start()} loading={state.status === "requesting"}><Play size={14} aria-hidden /> Start camera</Button>
              )}
            </div>
          </div>

          <div className="relative bg-plate-ink" style={{ aspectRatio: aspect }}>
            <video
              ref={videoRef}
              playsInline
              muted
              className={cn("absolute inset-0 size-full object-fill", !live && "invisible", mirrored && "-scale-x-100")}
              aria-label="Camera preview"
            />
            <canvas ref={canvasRef} className={cn("pointer-events-none absolute inset-0 size-full", (!live || mode === "off") && "invisible")} aria-hidden />
            {live && (
              <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2">
                <span className="flex items-center gap-2 rounded-full bg-danger px-3 py-1 font-mono text-[11px] font-semibold tracking-wider text-accent-fg">
                  <LiveDot tone="gold" /> LIVE
                </span>
                {mode === "mock" && <span className="rounded-full bg-gold-soft px-3 py-1 text-[11px] font-medium text-gold-strong">Mock detections: not from the video</span>}
              </div>
            )}
            {live && (
              <div className="pointer-events-none absolute bottom-4 right-4 rounded-sm bg-plate-ink/70 px-2.5 py-1 font-mono text-[11px] text-plate-bg tabular backdrop-blur" style={{ color: "var(--plate-bg)" }}>
                {readout.width}×{readout.height} · {readout.fps} fps
              </div>
            )}
            <AnimatePresence>{!live && <StateScreen state={state} onRetry={() => start()} />}</AnimatePresence>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3.5">
            <Switch checked={mirrored} onChange={(v) => { setMirrored(v); writePref("camera.mirror", v ? "on" : "off"); }} label="Mirror preview" />
            <Switch checked={false} onChange={() => {}} disabled label="Blur faces" hint="Placeholder. This build does no face processing at all." />
            <span className="text-xs text-faint">Blur faces is a placeholder: this build does no face processing.</span>
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Stream" />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-6 pt-4 text-sm">
              <div><dt className="text-xs text-muted">State</dt><dd><StateChip state={state} /></dd></div>
              <div><dt className="text-xs text-muted">Resolution</dt><dd className="font-mono tabular">{live && readout.width ? `${readout.width}×${readout.height}` : "—"}</dd></div>
              <div><dt className="text-xs text-muted">Preview rate</dt><dd className="font-mono tabular">{live ? `${readout.fps} fps` : "—"}</dd></div>
              <div><dt className="text-xs text-muted">Frames processed</dt><dd className="font-mono tabular">{formatNumber(stats.frames)}</dd></div>
              <div><dt className="text-xs text-muted">Detector latency</dt><dd className="font-mono tabular">{stats.frames ? `${stats.latencyMs} ms` : "—"}</dd></div>
              <div><dt className="text-xs text-muted">Detector</dt><dd>{mode === "mock" ? "Mock" : mode === "off" ? "Off" : "Model"}</dd></div>
              <div className="col-span-2">
                <dt className="text-xs text-muted">Integrity</dt>
                <dd className="mt-1">
                  <Badge tone="warn" dot>Local stream, frames not signed</Badge>
                  <p className="mt-1.5 text-xs text-muted">Browser frames are for testing. Signed capture and replay checks arrive with the backend stream.</p>
                </dd>
              </div>
            </dl>
          </Card>

          {raised.length > 0 && (
            <Card tone="gold">
              <CardHeader title="Watchlist matches" subtitle="Each one is a pending alert in Live Alerts" />
              <div className="space-y-2 p-4 pt-3">
                {raised.map((r) => (
                  <AlertCard
                    key={r.alertId}
                    plate={r.plate}
                    priority={priorityOf(r.match!.reason)}
                    title={`${REASON_LABELS[r.match!.reason]} · ${r.match!.caseRef}`}
                    meta={`${r.alertId} · ${formatTime(r.at)}`}
                    trailing={<Badge tone="accent" className="h-5 px-2 text-[10px]">Awaiting review</Badge>}
                    fresh
                    onClick={can("alerts:view") ? () => navigate(`/alerts?id=${r.alertId}`) : undefined}
                  />
                ))}
                <p className="flex items-start gap-2 px-1 pt-1 text-xs text-muted">
                  <UserCheck size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                  A person must approve or reject every match in <Link to="/alerts" className="text-accent hover:underline">Live Alerts</Link>. Mock detections are not from the video.
                </p>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Recent detections" subtitle={mode === "mock" ? "Mock data" : undefined} />
            {recent.length === 0 ? (
              <p className="px-6 pb-6 pt-3 text-sm text-muted">{live ? (mode === "off" ? "Detection is off." : "Waiting for the first frames…") : "Start the camera to see detections."}</p>
            ) : (
              <ul className="space-y-1 p-3 pt-2" aria-live="polite">
                <AnimatePresence initial={false}>
                  {recent.map((r) => (
                    <motion.li key={r.key} layout initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className={cn("flex items-center justify-between gap-2 rounded-sm px-3 py-2", r.match && "bg-gold-soft")}>
                      {r.plate ? <PlateText value={r.plate} size="sm" /> : <span className="text-xs font-mono text-muted">Unreadable plate</span>}
                      <span className="flex items-center gap-3 font-mono text-[11px] text-muted tabular">
                        <span>{Math.round(r.confidence * 100)}%</span>
                        <span>{formatTime(r.at)}</span>
                      </span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </Card>

          <Card tone="glass" className="p-5 text-xs leading-relaxed text-muted">
            <p className="mb-1.5 flex items-center gap-2 text-sm font-medium text-text"><EyeOff size={15} aria-hidden /> Privacy</p>
            Video only, never audio. Frames are processed in memory and dropped. Starting and stopping the camera is written to the audit log. Access requires the Admin or Analyst role.
          </Card>
        </div>
      </RevealGroup>
    </>
  );
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const options: { value: Mode; label: string }[] = [
    { value: "off", label: "Off" },
    { value: "mock", label: "Mock" },
    { value: "model", label: "Model" },
  ];
  return (
    <div role="radiogroup" aria-label="Detection mode" className="flex rounded-sm border border-border bg-bg-subtle p-0.5">
      {options.map((o) => (
        <span key={o.value} className="group relative">
          <button
            type="button"
            role="radio"
            aria-checked={mode === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "focus-ring h-8 rounded-[8px] px-3 text-sm hover:text-text",
              mode === o.value ? "bg-surface-raised font-medium shadow-1" : "text-muted",
            )}
          >
            {o.label}
          </button>
        </span>
      ))}
    </div>
  );
}

function StateChip({ state }: { state: CameraState }) {
  const map: Record<CameraState["status"], { tone: "neutral" | "accent" | "danger" | "warn" | "ok"; label: string }> = {
    idle: { tone: "neutral", label: "Idle" },
    requesting: { tone: "accent", label: "Requesting" },
    live: { tone: "ok", label: "Live" },
    denied: { tone: "danger", label: "Denied" },
    no_camera: { tone: "warn", label: "No camera" },
    error: { tone: "danger", label: "Error" },
  };
  const s = map[state.status];
  return <Badge tone={s.tone} dot>{s.label}</Badge>;
}

function StateScreen({ state, onRetry }: { state: CameraState; onRetry: () => void }) {
  const views: Record<Exclude<CameraState["status"], "live">, { icon: typeof Camera; title: string; body: string; action?: string }> = {
    idle: { icon: Video, title: "Camera is off", body: "Start the camera to test plate detection. Your browser will ask for permission.", action: "Start camera" },
    requesting: { icon: Loader2, title: "Waiting for permission…", body: "Answer the browser prompt to allow or block the camera." },
    denied: { icon: Lock, title: "Camera access blocked", body: "message", action: "Try again" },
    no_camera: { icon: CameraOff, title: "No camera found", body: "message", action: "Try again" },
    error: { icon: VideoOff, title: "Camera unavailable", body: "message", action: "Try again" },
  };
  if (state.status === "live") return null;
  const v = views[state.status];
  const body = "message" in state ? state.message : v.body;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 grid place-items-center p-6 text-center"
      role={state.status === "denied" || state.status === "error" ? "alert" : "status"}
      style={{ color: "var(--plate-bg)" }}
    >
      <div className="max-w-sm">
        <span className={cn("mx-auto mb-4 grid size-14 place-items-center rounded-full", state.status === "denied" || state.status === "error" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent")}>
          <v.icon size={24} className={state.status === "requesting" ? "animate-spin" : ""} aria-hidden />
        </span>
        <p className="font-display text-xl">{v.title}</p>
        <p className="mt-2 text-sm opacity-80">{body}</p>
        {v.action && (
          <Button variant="primary" className="mt-5" onClick={onRetry}>
            {state.status === "idle" ? <Play size={14} aria-hidden /> : <ShieldAlert size={14} aria-hidden />} {v.action}
          </Button>
        )}
      </div>
    </motion.div>
  );
}

/**
 * /camera            -> the first browser webcam you may use
 * /camera/:id        -> that camera's live view (404-style state if it is not in your cities)
 */
export default function LiveCamera() {
  const { id } = useParams();
  const cameras = useApi((ctx) => api.getCameras(ctx));
  if (cameras.error) return <ErrorState error={cameras.error} onRetry={cameras.reload} />;
  if (!cameras.data) return <LoadingBlock className="rounded-lg border border-border bg-surface" label="Loading camera" />;

  if (!id) {
    const webcam = cameras.data.find((c) => c.sourceType === "browser-webcam");
    if (webcam) return <Navigate to={`/camera/${webcam.id}`} replace />;
    return (
      <>
        <PageHeader eyebrow="Plate testing" title="Live camera" />
        <EmptyState title="No webcam camera in your cities" action={<Link to="/cameras" className="text-accent hover:underline">See your cameras</Link>}>
          An Admin can add a browser-webcam camera to one of your cities.
        </EmptyState>
      </>
    );
  }

  const camera = cameras.data.find((c) => c.id === id);
  if (!camera) {
    return (
      <>
        <PageHeader eyebrow="Plate testing" title="Live camera" />
        <EmptyState title="Camera not found" action={<Link to="/cameras" className="text-accent hover:underline">See your cameras</Link>}>
          It does not exist, or it is not in a city you are allowed to see.
        </EmptyState>
      </>
    );
  }
  if (camera.sourceType !== "browser-webcam") {
    return (
      <>
        <PageHeader eyebrow={camera.cityName} title={camera.name} description="Live view for this source arrives with the backend camera workers (stage 2, see docs/live_camera.md)." />
        <EmptyState title={`${camera.sourceType.toUpperCase()} live view: coming later`} action={<Link to="/cameras" className="text-accent hover:underline">Back to cameras</Link>}>
          Status: {camera.status}. Last frame: {camera.lastFrameAt ? formatTime(camera.lastFrameAt) : "never"}.
        </EmptyState>
      </>
    );
  }
  return <LiveView key={camera.id} camera={camera} />;
}
