/* Interactive pieces of the camera wizard: view-direction dial, test timeline, success check. */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, Circle, Globe, Loader2, Lock, Network, XCircle } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ConnectionTestResult } from "./types";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** 0..359 degree dial (0 = north, clockwise). Drag, click, or arrow keys (Shift = 15 degrees). */
export function DirectionDial({ value, onChange, label = "Direction of view" }: {
  value: number | null;
  onChange: (deg: number | null) => void;
  label?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const deg = value ?? 0;

  const fromPointer = (e: PointerEvent<SVGSVGElement>) => {
    const box = ref.current!.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2);
    const dy = e.clientY - (box.top + box.height / 2);
    onChange((Math.round((Math.atan2(dx, -dy) * 180) / Math.PI) + 360) % 360);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 1;
    const next = { ArrowRight: deg + step, ArrowUp: deg + step, ArrowLeft: deg - step, ArrowDown: deg - step, Home: 0 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onChange(((next % 360) + 360) % 360);
  };
  const rad = (deg * Math.PI) / 180;
  const hx = 60 + 44 * Math.sin(rad);
  const hy = 60 - 44 * Math.cos(rad);
  const coneL = ((deg - 30) * Math.PI) / 180;
  const coneR = ((deg + 30) * Math.PI) / 180;

  return (
    <div className="flex items-center gap-4">
      <svg
        ref={ref}
        viewBox="0 0 120 120"
        className="size-32 shrink-0 cursor-pointer touch-none select-none rounded-full focus-ring"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={value ?? undefined}
        aria-valuetext={value === null ? "Not set" : `${deg} degrees, ${COMPASS[Math.round(deg / 45) % 8]}`}
        onKeyDown={onKey}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e); }}
        onPointerMove={(e) => dragging.current && fromPointer(e)}
        onPointerUp={() => (dragging.current = false)}
      >
        <circle cx="60" cy="60" r="56" style={{ fill: "var(--bg-subtle)", stroke: "var(--border)" }} />
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i * 10 * Math.PI) / 180;
          const long = i % 9 === 0;
          return <line key={i} x1={60 + 50 * Math.sin(a)} y1={60 - 50 * Math.cos(a)} x2={60 + (long ? 42 : 46) * Math.sin(a)} y2={60 - (long ? 42 : 46) * Math.cos(a)} style={{ stroke: "var(--border-strong)", strokeWidth: long ? 1.6 : 0.8 }} />;
        })}
        {["N", "E", "S", "W"].map((t, i) => (
          <text key={t} x={60 + 33 * Math.sin((i * Math.PI) / 2)} y={64 - 33 * Math.cos((i * Math.PI) / 2)} textAnchor="middle" style={{ fill: "var(--text-faint)", font: "600 9px var(--font-mono)" }}>{t}</text>
        ))}
        {value !== null && (
          <>
            <path d={`M60 60 L${60 + 50 * Math.sin(coneL)} ${60 - 50 * Math.cos(coneL)} A50 50 0 0 1 ${60 + 50 * Math.sin(coneR)} ${60 - 50 * Math.cos(coneR)} Z`} style={{ fill: "var(--accent-2)", opacity: 0.22 }} />
            <line x1="60" y1="60" x2={hx} y2={hy} style={{ stroke: "var(--accent)", strokeWidth: 2.5, strokeLinecap: "round" }} />
            <circle cx={hx} cy={hy} r="7" style={{ fill: "var(--accent)", stroke: "var(--surface-raised)", strokeWidth: 2.5 }} />
          </>
        )}
        <circle cx="60" cy="60" r="3.5" style={{ fill: "var(--text)" }} />
      </svg>
      <div className="text-sm">
        <p className="font-mono text-2xl font-semibold tabular">{value === null ? "—" : `${deg}°`}</p>
        <p className="text-muted">{value === null ? "Not set" : `Facing ${COMPASS[Math.round(deg / 45) % 8]}`}</p>
        <p className="mt-1 text-xs text-faint">Drag the handle or use the arrow keys.</p>
        {value !== null && (
          <button type="button" onClick={() => onChange(null)} className="focus-ring mt-1 rounded-xs text-xs text-accent hover:underline">Clear direction</button>
        )}
      </div>
    </div>
  );
}

const STEP_META = [
  { key: "dns", label: "DNS", Icon: Globe },
  { key: "tcp", label: "TCP connect", Icon: Network },
  { key: "tls", label: "TLS handshake", Icon: Lock },
] as const;

/**
 * DNS -> TCP -> TLS -> result, revealed one by one. While `running`, steps pulse in order;
 * when the result arrives each step settles to its real outcome. The verdict never claims more
 * than the server proved ("Network reachable, stream not verified").
 */
export function ConnectionTimeline({ running, result, error, tls }: {
  running: boolean;
  result: ConnectionTestResult | null;
  error: string | null;
  tls: boolean;
}) {
  const reduce = useReducedMotion();
  const steps = STEP_META.filter((s) => s.key !== "tls" || tls);
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    if (!result) {
      setRevealed(0);
      return;
    }
    if (reduce) {
      setRevealed(steps.length + 1);
      return;
    }
    setRevealed(0);
    const timers = Array.from({ length: steps.length + 1 }, (_, i) => window.setTimeout(() => setRevealed(i + 1), 260 * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [result, reduce, steps.length]);

  if (!running && !result && !error) return null;
  return (
    <ol className="relative mt-4 space-y-3 border-l border-border pl-6" aria-live="polite">
      {steps.map((s, i) => {
        const outcome = result?.steps.find((x) => x.name === s.key);
        const shown = result && i < revealed;
        const state = error ? "idle" : shown ? (outcome ? (outcome.ok ? "ok" : "fail") : "skipped") : running || result ? "pending" : "idle";
        return (
          <li key={s.key} className="relative">
            <span className="absolute -left-[33px] top-0 grid size-[18px] place-items-center rounded-full bg-surface">
              {state === "ok" ? <CheckCircle2 size={18} className="text-ok" aria-hidden />
                : state === "fail" ? <XCircle size={18} className="text-danger" aria-hidden />
                : state === "pending" ? <Loader2 size={16} className="animate-spin text-accent" aria-hidden />
                : <Circle size={14} className="text-faint" aria-hidden />}
            </span>
            <p className="flex items-center gap-2 text-sm font-medium"><s.Icon size={14} className="text-muted" aria-hidden /> {s.label}
              {shown && outcome?.ms != null && <span className="font-mono text-xs text-faint tabular">{outcome.ms} ms</span>}
            </p>
            <AnimatePresence>
              {shown && (
                <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-xs text-muted">
                  {outcome ? outcome.detail : "Not reached"}
                </motion.p>
              )}
            </AnimatePresence>
          </li>
        );
      })}
      <li className="relative">
        <span className="absolute -left-[33px] top-0.5 grid size-[18px] place-items-center rounded-full bg-surface">
          <Circle size={14} className={cn(result && revealed > steps.length ? (result.reachable ? "fill-ok text-ok" : "fill-danger text-danger") : "text-faint")} aria-hidden />
        </span>
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">{error}</p>
        ) : result && revealed > steps.length ? (
          <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}>
            <p className={cn("text-sm font-semibold", result.reachable ? "text-ok" : "text-danger")}>
              {result.verdict}{result.latencyMs != null && result.reachable ? ` · ${result.latencyMs} ms` : ""}
            </p>
            <p className="text-xs text-muted">The test opens a network connection only. It does not log in or decode video.</p>
          </motion.div>
        ) : (
          <p className="text-sm text-muted">Result</p>
        )}
      </li>
    </ol>
  );
}

/** Drawn-in check mark shown after a successful save. */
export function SuccessCheck({ label }: { label: string }) {
  return (
    <motion.div className="flex flex-col items-center gap-3 py-10 text-center" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} role="status">
      <svg viewBox="0 0 52 52" className="size-20" aria-hidden>
        <circle cx="26" cy="26" r="24" style={{ fill: "var(--ok-soft)", stroke: "var(--ok)", strokeWidth: 2 }} />
        <path d="M15 27 l7 7 l15 -16" style={{ fill: "none", stroke: "var(--ok)", strokeWidth: 3.5, strokeLinecap: "round", strokeLinejoin: "round", strokeDasharray: 30, animation: "draw-check 0.6s 0.15s var(--ease-out) both" }} />
      </svg>
      <p className="font-display text-lg font-semibold">{label}</p>
    </motion.div>
  );
}
