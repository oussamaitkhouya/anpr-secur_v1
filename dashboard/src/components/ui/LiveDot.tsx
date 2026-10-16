import { cn } from "../../lib/cn";

/** Pulsing "live" indicator. The pulse ring is decorative and stops under reduced motion. */
export function LiveDot({ tone = "ok", className }: { tone?: "ok" | "danger" | "gold"; className?: string }) {
  const bg = { ok: "bg-ok", danger: "bg-danger", gold: "bg-gold" }[tone];
  return (
    <span className={cn("relative inline-flex size-2", className)} aria-hidden>
      <span className={cn("absolute inset-0 rounded-full motion-safe:animate-[live-pulse_1.8s_var(--ease-out)_infinite]", bg)} />
      <span className={cn("relative inline-flex size-2 rounded-full", bg)} />
    </span>
  );
}
