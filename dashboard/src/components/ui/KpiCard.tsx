import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "./Card";
import { CountUp } from "./CountUp";
import { Sparkline } from "./Sparkline";

export function KpiCard({ label, value, format, icon: Icon, trend, caption, tone = "default", footer, onClick }: {
  label: string;
  value: number;
  format: (n: number) => string;
  icon: LucideIcon;
  trend?: number[];
  caption?: ReactNode;
  tone?: "default" | "gold" | "danger" | "ok";
  footer?: ReactNode;
  onClick?: () => void;
}) {
  const accent = { default: "var(--chart-1)", gold: "var(--gold)", danger: "var(--danger)", ok: "var(--ok)" }[tone];
  const body = (
    <>
      {/* tone-coloured glow in the corner, brighter on hover */}
      <span
        className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full opacity-25 blur-3xl transition-opacity duration-500 group-hover:opacity-50"
        style={{ background: accent }}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-3">
        <p className="pt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">{label}</p>
        <span
          className="grid size-10 place-items-center rounded-[12px] transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-110"
          style={{
            color: accent,
            background: `color-mix(in oklab, ${accent} 16%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${accent} 35%, transparent), 0 8px 24px -8px ${accent}`,
          }}
        >
          <Icon size={18} strokeWidth={2.1} aria-hidden />
        </span>
      </div>
      <div className="relative mt-4 flex items-end justify-between gap-3">
        <p className="font-display text-[2.35rem] font-semibold leading-none tracking-[-0.035em]">
          <CountUp value={value} format={format} />
        </p>
        {trend && <Sparkline values={trend} color={accent} width={108} height={38} />}
      </div>
      {caption && <p className="relative mt-4 text-xs leading-relaxed text-muted">{caption}</p>}
      {footer}
    </>
  );
  return (
    <Card interactive={!!onClick} tone={tone === "gold" ? "gold" : tone === "danger" ? "danger" : "default"} className="group overflow-hidden p-5">
      {onClick ? (
        <button type="button" onClick={onClick} className="focus-ring -m-5 block w-[calc(100%+2.5rem)] rounded-lg p-5 text-left">
          {body}
        </button>
      ) : (
        body
      )}
    </Card>
  );
}
