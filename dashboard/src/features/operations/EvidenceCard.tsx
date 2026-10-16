/*
 * The camera frame that raised a watchlist alert, shown to the person who must decide it.
 *
 * Trust chain, visible on the card: the server hashes the stored JPEG and refuses it (409) if it
 * differs from the SHA-256 recorded at capture; the browser then hashes the bytes it received and
 * compares them with the same recorded value. Each view is written to the signed audit log, and the
 * frame carries a watermark with the viewer's name. Nothing is cached (no-store) or faked: if there
 * is no frame, the card says why.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Camera, Clock3, Expand, FileWarning, Gauge, ImageOff, MapPin, Navigation, ScanLine, ShieldAlert, ShieldCheck, Timer, X } from "lucide-react";
import { ApiError } from "../../api/errors";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Card } from "../../components/ui/Card";
import { PlateText } from "../../components/ui/PlateText";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { fetchEvidence, sha256Hex, shortId, type LiveAlert } from "./api";

type Frame =
  | { state: "loading" }
  | { state: "ready"; url: string; browserHash: "match" | "mismatch" | "unavailable"; bytes: number }
  | { state: "none" | "expired" | "tampered" | "forbidden" | "error"; message: string };

function useEvidenceFrame(alert: LiveAlert): Frame {
  const [frame, setFrame] = useState<Frame>({ state: "loading" });
  const { id, evidenceSha256: recorded } = alert;

  useEffect(() => {
    if (!recorded) {
      setFrame({ state: "none", message: "The camera did not keep a frame for this read." });
      return;
    }
    let alive = true;
    let url: string | null = null;
    setFrame({ state: "loading" });
    (async () => {
      try {
        const blob = await fetchEvidence(id);
        const hash = await sha256Hex(blob).catch(() => null);
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setFrame({ state: "ready", url, bytes: blob.size, browserHash: hash === null ? "unavailable" : hash === recorded ? "match" : "mismatch" });
      } catch (e) {
        if (!alive) return;
        const status = e instanceof ApiError ? e.status : 0;
        const message = e instanceof Error ? e.message : "The frame could not be loaded.";
        setFrame({ state: status === 409 ? "tampered" : status === 404 ? "expired" : status === 403 ? "forbidden" : "error", message });
      }
    })();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, recorded]);

  return frame;
}

export function EvidenceCard({ alert }: { alert: LiveAlert }) {
  const frame = useEvidenceFrame(alert);
  const { user } = useSession();
  const [zoom, setZoom] = useState(false);
  const tampered = frame.state === "tampered" || (frame.state === "ready" && frame.browserHash === "mismatch");
  const latencyMs = new Date(alert.receivedAt).getTime() - new Date(alert.observedAt).getTime();
  const watermark = `${user.username} · alert ${shortId(alert.id)} · ${formatDateTime(new Date().toISOString())}`;

  return (
    <Card tone={tampered ? "danger" : "default"} className="overflow-hidden">
      <div className="grid lg:grid-cols-[minmax(0,1.55fr)_minmax(260px,1fr)]">
        {/* ---- the frame ------------------------------------------------------------------- */}
        <div className="relative isolate aspect-video min-h-[220px] overflow-hidden bg-[#05060d] lg:aspect-auto lg:min-h-[380px]">
          {frame.state === "ready" && !tampered && (
            // decorative fill only: a blurred copy behind the uncropped evidence frame
            <img src={frame.url} alt="" aria-hidden className="absolute inset-0 -z-10 size-full scale-110 object-cover opacity-35 blur-2xl" />
          )}
          {frame.state === "loading" && <ScanningPlaceholder />}
          {frame.state === "ready" && !tampered && (
            <button type="button" onClick={() => setZoom(true)} className="group focus-ring absolute inset-0 cursor-zoom-in" aria-label="Open the evidence frame full size">
              <RadarStage url={frame.url} alert={alert} watermark={watermark} alt={`Camera frame from ${alert.cameraName} at ${formatDateTime(alert.observedAt)}`} />
              <span className="pointer-events-none absolute top-12 left-5 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white/85 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Expand size={12} aria-hidden /> Full size
              </span>
            </button>
          )}
          {frame.state !== "loading" && frame.state !== "ready" && <FrameProblem frame={frame} />}
          {frame.state === "ready" && tampered && <FrameProblem frame={{ state: "tampered", message: "The bytes received do not hash to the value recorded at capture." }} />}

          {/* viewfinder chrome */}
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.55),transparent_22%,transparent_70%,rgba(0,0,0,0.7))]" />
            {(["top-3 left-3 border-t-2 border-l-2", "top-3 right-3 border-t-2 border-r-2", "bottom-3 left-3 border-b-2 border-l-2", "right-3 bottom-3 border-r-2 border-b-2"] as const).map((pos) => (
              <span key={pos} className={cn("absolute size-6 rounded-[3px]", pos, tampered ? "border-danger" : "border-white/70")} />
            ))}
            <div className="absolute top-4 left-5 flex items-center gap-2 font-mono text-[11px] tracking-wider text-white/90">
              <span className={cn("relative grid size-2 place-items-center rounded-full", tampered ? "bg-danger" : "bg-[#ff3b5c]")}>
                <span className="absolute inset-0 rounded-full bg-inherit [animation:live-pulse_1.6s_ease-out_infinite]" />
              </span>
              CAPTURED {new Date(alert.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
            <div className="absolute top-4 right-5 flex items-center gap-1.5 text-[11px] text-white/80">
              <Camera size={12} /> {alert.cameraName}
            </div>
          </div>
        </div>

        {/* ---- the facts ------------------------------------------------------------------- */}
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium tracking-[0.18em] text-muted uppercase">Evidence at capture</p>
              <div className="mt-2"><PlateText value={alert.plate} size="md" /></div>
            </div>
            <ConfidenceRing value={alert.plateConfidence} />
          </div>

          <dl className="grid gap-3.5 text-sm">
            <Fact icon={Clock3} label="Captured">
              {formatDateTime(alert.observedAt)} <span className="text-muted">· {relativeTime(alert.observedAt)}</span>
            </Fact>
            <Fact icon={MapPin} label="Location">
              {alert.cameraAddress ? <>{alert.cameraAddress}, </> : null}{alert.cityName}
              {alert.cameraLatitude !== null && alert.cameraLongitude !== null && (
                <span className="block font-mono text-[12px] text-muted tabular">
                  {alert.cameraLatitude.toFixed(5)}°, {alert.cameraLongitude.toFixed(5)}°
                </span>
              )}
            </Fact>
            <Fact icon={Navigation} label="Camera">
              <span className="inline-flex items-center gap-2">
                {alert.cameraName}
                {alert.cameraViewDeg !== null && <Compass deg={alert.cameraViewDeg} />}
              </span>
            </Fact>
            <Fact icon={Timer} label="Delivered">
              {latencyMs < 0 ? "—" : latencyMs < 1 ? "On capture (read on the server)" : `${latencyMs < 1000 ? `${latencyMs} ms` : `${(latencyMs / 1000).toFixed(1)} s`} after capture`}
            </Fact>
          </dl>

          <Integrity frame={frame} recorded={alert.evidenceSha256} tampered={tampered} />
        </div>
      </div>

      <AnimatePresence>
        {zoom && frame.state === "ready" && !tampered && (
          <Lightbox onClose={() => setZoom(false)}>
            <RadarStage url={frame.url} alert={alert} watermark={watermark} alt={`Evidence frame, alert ${shortId(alert.id)}`} large />
          </Lightbox>
        )}
      </AnimatePresence>
    </Card>
  );
}

function Fact({ icon: Icon, label, children }: { icon: typeof Clock3; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[28px_1fr] items-start gap-x-2">
      <span className="mt-0.5 grid size-7 place-items-center rounded-sm bg-accent-soft text-accent"><Icon size={14} aria-hidden /></span>
      <div className="min-w-0">
        <dt className="text-xs text-muted">{label}</dt>
        <dd className="mt-0.5 break-words">{children}</dd>
      </div>
    </div>
  );
}

function ConfidenceRing({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const r = 22;
  const c = 2 * Math.PI * r;
  const tone = value >= 0.9 ? "var(--ok)" : value >= 0.75 ? "var(--gold)" : "var(--danger)";
  return (
    <div className="relative grid size-16 shrink-0 place-items-center" role="img" aria-label={`OCR confidence ${pct} percent`}>
      <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="28" cy="28" r={r} fill="none" stroke="var(--border)" strokeWidth="5" />
        <motion.circle cx="28" cy="28" r={r} fill="none" stroke={tone} strokeWidth="5" strokeLinecap="round" strokeDasharray={c}
          initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - pct / 100) }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
      </svg>
      <span className="flex flex-col items-center leading-none">
        <span className="font-mono text-[15px] font-semibold tabular">{pct}%</span>
        <span className="mt-0.5 flex items-center gap-0.5 text-[9px] tracking-wider text-muted uppercase"><Gauge size={9} aria-hidden />OCR</span>
      </span>
    </div>
  );
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function Compass({ deg }: { deg: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted" title={`Looking ${deg}° from north`}>
      <Navigation size={11} className="text-accent" style={{ transform: `rotate(${deg - 45}deg)` }} aria-hidden />
      faces {POINTS[Math.round(deg / 45) % 8]}
    </span>
  );
}

function Integrity({ frame, recorded, tampered }: { frame: Frame; recorded: string | null; tampered: boolean }) {
  if (!recorded) return null;
  const steps: { label: string; state: "ok" | "bad" | "wait" | "skip" }[] = [
    { label: "Hash recorded at capture", state: "ok" },
    { label: "Server re-hashed the stored file", state: frame.state === "ready" ? "ok" : frame.state === "tampered" ? "bad" : frame.state === "loading" ? "wait" : "skip" },
    { label: "Your browser re-hashed what it received", state: frame.state !== "ready" ? (frame.state === "loading" ? "wait" : "skip") : frame.browserHash === "match" ? "ok" : frame.browserHash === "mismatch" ? "bad" : "skip" },
  ];
  return (
    <div className={cn("mt-auto rounded-md border p-3.5", tampered ? "border-danger bg-danger-soft" : "border-border bg-bg-subtle/60")}>
      <p className={cn("flex items-center gap-1.5 text-xs font-medium", tampered ? "text-danger" : "text-text")}>
        {tampered ? <ShieldAlert size={14} aria-hidden /> : <ShieldCheck size={14} className="text-ok" aria-hidden />}
        {tampered ? "Integrity check failed: image withheld" : "Chain of custody"}
      </p>
      <ol className="mt-2.5 space-y-1.5">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[12px] text-muted">
            <span className={cn("size-1.5 shrink-0 rounded-full", s.state === "ok" ? "bg-ok" : s.state === "bad" ? "bg-danger" : s.state === "wait" ? "animate-pulse bg-accent" : "bg-border-strong")} />
            {s.label}
          </li>
        ))}
      </ol>
      <p className="mt-2.5 truncate font-mono text-[11px] text-faint" title={recorded}>SHA-256 {recorded}</p>
      <p className="mt-1 text-[11px] text-muted">Viewing this frame is recorded in the signed audit log.</p>
    </div>
  );
}

function ScanningPlaceholder() {
  return (
    <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Loading the evidence frame">
      <div className="absolute inset-0 bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.025)_0_1px,transparent_1px_4px)]" />
      <span className="absolute inset-x-6 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] shadow-[0_0_18px_2px_var(--accent)] [animation:scan_1.8s_ease-in-out_infinite]" />
      <span className="flex items-center gap-2 text-xs text-white/60"><ScanLine size={15} aria-hidden /> Verifying evidence frame…</span>
    </div>
  );
}

function FrameProblem({ frame }: { frame: Extract<Frame, { message: string }> }) {
  const cfg = {
    tampered: { icon: ShieldAlert, title: "Evidence integrity failure", tone: "text-danger" },
    expired: { icon: FileWarning, title: "Frame not available", tone: "text-gold" },
    none: { icon: ImageOff, title: "No frame kept", tone: "text-white/70" },
    forbidden: { icon: ShieldAlert, title: "Not visible to your role", tone: "text-white/70" },
    error: { icon: FileWarning, title: "Frame could not be loaded", tone: "text-gold" },
  }[frame.state];
  return (
    <div className={cn("absolute inset-0 grid place-items-center p-8 text-center", frame.state === "tampered" && "bg-[radial-gradient(circle_at_center,rgba(255,59,92,0.18),transparent_70%)]")}>
      <div className="max-w-sm">
        <cfg.icon size={30} className={cn("mx-auto", cfg.tone)} aria-hidden />
        <p className={cn("mt-3 font-medium", frame.state === "tampered" ? "text-danger" : "text-white/90")}>{cfg.title}</p>
        <p className="mt-1 text-sm text-white/60">{frame.message}</p>
        {frame.state === "tampered" && <Badge tone="danger" className="mt-3">Do not confirm this match on this evidence</Badge>}
      </div>
    </div>
  );
}

function Lightbox({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Portal: a transformed ancestor (the panel's enter animation) would otherwise trap position:fixed.
  return createPortal(
    <motion.div role="dialog" aria-modal="true" aria-label="Evidence frame, full size" onClick={onClose}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4 backdrop-blur-sm sm:p-10">
      <motion.figure initial={{ scale: 0.94 }} animate={{ scale: 1 }} exit={{ scale: 0.96 }} className="relative h-[85vh] w-[92vw] max-w-[1600px]" onClick={(e) => e.stopPropagation()}>
        {children}
      </motion.figure>
      <button type="button" onClick={onClose} autoFocus className="focus-ring absolute top-4 right-4 grid size-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20" aria-label="Close">
        <X size={18} aria-hidden />
      </button>
    </motion.div>,
    document.body,
  );
}

// ---- radar view ------------------------------------------------------------------------------
// Everything below is drawn OVER the frame, never into it: the evidence bytes stay exactly what the
// camera captured, so their SHA-256 still matches the one recorded at capture.

type Rect = { left: number; top: number; width: number; height: number };

/** Where an object-contain image actually sits inside its box (letterboxing removed). */
function useContainedRect(ref: RefObject<HTMLDivElement | null>, natural: { w: number; h: number } | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !natural) return;
    const measure = () => {
      const bw = el.clientWidth, bh = el.clientHeight;
      if (!bw || !bh) return;
      const scale = Math.min(bw / natural.w, bh / natural.h);
      const width = natural.w * scale, height = natural.h * scale;
      setRect({ left: (bw - width) / 2, top: (bh - height) / 2, width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, natural]);
  return rect;
}

const pad = (n: number, l = 2) => String(n).padStart(l, "0");
/** 2026-10-09 18:48:11.693, local time, like a traffic camera's data stamp. */
function radarStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function RadarStage({ url, alert, watermark, alt, large = false }: { url: string; alert: LiveAlert; watermark: string; alt: string; large?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const rect = useContainedRect(boxRef, natural);
  const b = alert.plateBox;
  const box = b && b.length === 4 && b[2] > 0 && b[3] > 0 ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null;

  return (
    <div ref={boxRef} className="absolute inset-0">
      <motion.img src={url} alt={alt} draggable={false}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 16, h: e.currentTarget.naturalHeight || 9 })}
        initial={{ opacity: 0, filter: "blur(6px) saturate(0.4)" }} animate={{ opacity: 1, filter: "blur(0px) saturate(1)" }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="size-full object-contain" />
      {rect && (
        <div className="pointer-events-none absolute" style={rect} aria-hidden>
          {box && <TargetLock box={box} confidence={alert.plateConfidence} />}
          {box && natural && <PlateZoom url={url} box={box} natural={natural} large={large} />}
          <DataStrip alert={alert} watermark={watermark} large={large} />
        </div>
      )}
    </div>
  );
}

const RADAR = "#ffd23f";

function TargetLock({ box, confidence }: { box: { x: number; y: number; w: number; h: number }; confidence: number }) {
  const cx = (box.x + box.w / 2) * 100, cy = (box.y + box.h / 2) * 100;
  return (
    <>
      {/* crosshair through the plate */}
      <motion.span initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.5, delay: 0.3 }}
        className="absolute inset-x-0 h-px origin-center" style={{ top: `${cy}%`, background: `linear-gradient(90deg, transparent, ${RADAR}88 20%, ${RADAR}88 80%, transparent)` }} />
      <motion.span initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ duration: 0.5, delay: 0.3 }}
        className="absolute inset-y-0 w-px origin-center" style={{ left: `${cx}%`, background: `linear-gradient(180deg, transparent, ${RADAR}88 20%, ${RADAR}88 80%, transparent)` }} />
      {/* the lock: brackets close in on the plate */}
      <motion.div initial={{ scale: 2.2, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 180, damping: 16, delay: 0.15 }}
        className="absolute" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}>
        <span className="absolute -inset-1 rounded-[3px] [animation:live-pulse_1.8s_ease-out_infinite]" style={{ boxShadow: `0 0 0 2px ${RADAR}66` }} />
        {(["-top-1.5 -left-1.5 border-t-[3px] border-l-[3px]", "-top-1.5 -right-1.5 border-t-[3px] border-r-[3px]", "-bottom-1.5 -left-1.5 border-b-[3px] border-l-[3px]", "-right-1.5 -bottom-1.5 border-r-[3px] border-b-[3px]"] as const).map((pos) => (
          <span key={pos} className={cn("absolute size-3.5", pos)} style={{ borderColor: RADAR }} />
        ))}
        <span className="absolute -top-6 left-0 rounded-[2px] px-1.5 py-0.5 font-mono text-[10px] font-bold whitespace-nowrap text-black" style={{ background: RADAR }}>
          TARGET LOCK · {Math.round(confidence * 100)}%
        </span>
      </motion.div>
    </>
  );
}

function PlateZoom({ url, box, natural, large }: { url: string; box: { x: number; y: number; w: number; h: number }; natural: { w: number; h: number }; large: boolean }) {
  const ratio = Math.min(8, Math.max(1.5, (box.w * natural.w) / (box.h * natural.h)));
  const fx = box.w < 1 ? (box.x / (1 - box.w)) * 100 : 0;
  const fy = box.h < 1 ? (box.y / (1 - box.h)) * 100 : 0;
  const plateOnRight = box.x + box.w / 2 > 0.5; // put the zoom on the other side, never over the target
  return (
    <motion.div initial={{ opacity: 0, x: plateOnRight ? -16 : 16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.55, duration: 0.4 }}
      className={cn("absolute overflow-hidden", plateOnRight ? "left-3" : "right-3", "rounded-[4px] border-2 shadow-[0_8px_30px_rgba(0,0,0,0.6)]", large ? "top-14 w-[min(34%,420px)]" : "top-11 w-[min(40%,220px)]")}
      style={{ borderColor: RADAR }}>
      <div style={{ aspectRatio: String(ratio), backgroundImage: `url(${url})`, backgroundSize: `${100 / box.w}% ${100 / box.h}%`, backgroundPosition: `${fx}% ${fy}%` }} />
      <span className="absolute top-0 left-0 px-1.5 py-px font-mono text-[9px] font-bold text-black" style={{ background: RADAR }}>
        PLATE ×{(1 / box.w).toFixed(1)}
      </span>
    </motion.div>
  );
}

function DataStrip({ alert, watermark, large }: { alert: LiveAlert; watermark: string; large: boolean }) {
  const lat = alert.cameraLatitude, lon = alert.cameraLongitude;
  const gps = lat !== null && lon !== null ? `${Math.abs(lat).toFixed(5)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(5)}°${lon >= 0 ? "E" : "W"}` : null;
  const fields: [string, ReactNode][] = [
    ["", radarStamp(alert.observedAt)],
    ["LOC", [alert.cameraAddress, alert.cityName].filter(Boolean).join(", ").toUpperCase()],
    ...(gps ? [["GPS", gps] as [string, ReactNode]] : []),
    ["CAM", `${alert.cameraName.toUpperCase()}${alert.cameraViewDeg !== null ? ` ${POINTS[Math.round(alert.cameraViewDeg / 45) % 8]}` : ""}`],
    // <bdi> + left-to-right marks around each "|": the Arabic letter must not reorder the plate's
    // segments (number | letter | region) or pull the percentage into it
    ["PLATE", <><bdi dir="ltr">{alert.plate.replace(/\|/g, "‎|‎")}</bdi> {Math.round(alert.plateConfidence * 100)}%</>],
    ...(alert.speedKmh !== null && alert.speedKmh !== undefined ? [["SPEED", `${Math.round(alert.speedKmh)} KM/H`] as [string, ReactNode]] : []),
  ];
  return (
    <div className={cn("absolute inset-x-0 bottom-0 bg-black/80 font-mono tracking-wide backdrop-blur-[2px]", large ? "px-4 py-2.5 text-[13px]" : "px-3 py-1.5 text-[10px]")} style={{ color: RADAR }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="relative grid size-3.5 shrink-0 place-items-center overflow-hidden rounded-full border" style={{ borderColor: `${RADAR}aa` }}>
          <span className="absolute inset-0 animate-spin rounded-full [animation-duration:2.4s]" style={{ background: `conic-gradient(from 0deg, ${RADAR}cc, transparent 30%)` }} />
        </span>
        {fields.map(([k, v]) => (
          <span key={k || "time"} className="whitespace-nowrap">
            {k && <span className="opacity-60">{k} </span>}{v}
          </span>
        ))}
        <span className="rounded-[2px] bg-[#ff3b5c] px-1.5 font-bold text-white">⚠ {alert.watchlistEntry.reason.toUpperCase()}</span>
      </div>
      <div className={cn("mt-0.5 truncate opacity-45", large ? "text-[11px]" : "text-[9px]")}>VIEWED BY {watermark.toUpperCase()}</div>
    </div>
  );
}
