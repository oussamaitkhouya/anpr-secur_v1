import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "gold";

const TONES: Record<Tone, string> = {
  neutral: "bg-bg-subtle text-muted border-border",
  accent: "bg-accent-soft text-accent border-transparent",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  gold: "bg-gold-soft text-gold-strong border-gold",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-faint", accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", gold: "bg-gold",
};

export function Badge({ tone = "neutral", dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium tracking-wide backdrop-blur-sm", TONES[tone], className)}>
      {dot && <span className={cn("size-1.5 rounded-full", DOTS[tone])} aria-hidden />}
      {children}
    </span>
  );
}
