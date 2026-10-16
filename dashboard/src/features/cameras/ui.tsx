/* Small visual pieces shared by the registry views. Colours come from the design tokens only. */
import { motion } from "framer-motion";
import { Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { cn } from "../../lib/cn";
import { daysUntil, KIND_LABELS, PROTOCOL_LABELS, STATUS_LABELS, tlsState } from "./logic";
import { KIND_ICONS, STATUS_COLOR } from "./style";
import type { CameraKind, CameraProtocol, CameraStatus } from "./types";

export function KindIcon({ kind, size = 16, className }: { kind: CameraKind; size?: number; className?: string }) {
  const Icon = KIND_ICONS[kind];
  return <Icon size={size} className={className} aria-label={KIND_LABELS[kind]} role="img" />;
}

export function StatusChip({ status, className }: { status: CameraStatus; className?: string }) {
  const color = STATUS_COLOR[status];
  const pulse = status === "online" || status === "offline";
  return (
    <span
      className={cn("inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium", className)}
      style={{ color, background: `color-mix(in oklab, ${color} 14%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 30%, transparent)` }}
    >
      <span className="relative inline-flex size-1.5" aria-hidden>
        {pulse && <span className="absolute inset-0 rounded-full motion-safe:animate-[live-pulse_1.8s_var(--ease-out)_infinite]" style={{ background: color }} />}
        <span className="relative inline-flex size-1.5 rounded-full" style={{ background: color }} />
      </span>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function ProtocolBadge({ protocol }: { protocol: CameraProtocol }) {
  const secure = protocol === "rtsps";
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-[6px] border px-1.5 font-mono text-[10.5px] font-semibold tracking-wide",
        secure ? "border-ok/40 bg-ok-soft text-ok" : protocol === "rtsp" ? "border-warn/40 bg-warn-soft text-warn" : "border-border bg-bg-subtle text-muted",
      )}
      title={secure ? "Encrypted transport" : protocol === "rtsp" ? "Unencrypted transport: prefer RTSPS" : undefined}
    >
      {PROTOCOL_LABELS[protocol]}
    </span>
  );
}

export function TlsBadge({ tlsNotAfter, compact }: { tlsNotAfter: string | null; compact?: boolean }) {
  const state = tlsState(tlsNotAfter);
  if (state === "none") return compact ? <span className="text-xs text-faint">—</span> : null;
  const days = daysUntil(tlsNotAfter!);
  const conf = {
    ok: { Icon: ShieldCheck, cls: "text-ok", label: `TLS ${days} d` },
    expiring: { Icon: ShieldAlert, cls: "text-warn", label: `TLS expires in ${days} d` },
    expired: { Icon: ShieldX, cls: "text-danger", label: "TLS expired" },
  }[state];
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium tabular", conf.cls)} title={`Certificate valid until ${new Date(tlsNotAfter!).toLocaleDateString()}`}>
      <conf.Icon size={13} aria-hidden /> {compact && state === "ok" ? `${days} d` : conf.label}
    </span>
  );
}

export function CredentialsChip({ set, protocol }: { set: boolean; protocol: CameraProtocol }) {
  if (protocol === "webhook" || protocol === "file") return <span className="text-xs text-faint">n/a</span>;
  return set ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok" title="Stored encrypted (AES-GCM). Never shown again.">
      <Lock size={11} aria-hidden /> Credentials set
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-gold-soft px-2 py-0.5 text-[11px] font-medium text-gold-strong">
      <LockOpen size={11} aria-hidden /> Missing
    </span>
  );
}

/** Animated ring, 0..1. null = nothing to measure (all in maintenance or no cameras). */
export function HealthRing({ value, size = 40 }: { value: number | null; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const color = value === null ? "var(--text-faint)" : value >= 0.85 ? "var(--ok)" : value >= 0.5 ? "var(--warn)" : "var(--danger)";
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={4} />
        {value !== null && (
          <motion.circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round"
            strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - value) }}
            transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
      </svg>
      <span className="absolute font-mono text-[10px] font-semibold tabular">{value === null ? "—" : Math.round(value * 100)}</span>
      <span className="sr-only">{value === null ? "No health data" : `Health ${Math.round(value * 100)} percent`}</span>
    </span>
  );
}

/** Inline SVG illustration for empty states: a camera on a pole scanning a zellige star. */
export function EmptyArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 110" className={cn("h-28 w-40", className)} aria-hidden>
      <defs>
        <linearGradient id="ea-beam" x1="0" x2="1">
          <stop offset="0" stopColor="var(--accent-2)" stopOpacity="0.5" />
          <stop offset="1" stopColor="var(--accent-2)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="var(--border-strong)" strokeWidth="1.2">
        <rect x="104" y="44" width="30" height="30" />
        <rect x="104" y="44" width="30" height="30" transform="rotate(45 119 59)" />
      </g>
      <path d="M52 34 L118 46 L118 72 L52 46 Z" fill="url(#ea-beam)" />
      <rect x="22" y="30" width="34" height="18" rx="5" fill="var(--surface-raised)" stroke="var(--accent)" strokeWidth="1.6" />
      <circle cx="50" cy="39" r="4" fill="var(--accent)" />
      <path d="M30 48 L30 100 M18 100 L42 100" stroke="var(--border-strong)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
