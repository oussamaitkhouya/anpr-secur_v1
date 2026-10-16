import type { ReactNode } from "react";

/** Tooltip body shared by all Recharts charts, styled with tokens. */
export function ChartTooltip({ active, title, rows }: {
  active?: boolean;
  title?: ReactNode;
  rows: { label: string; value: string; color: string }[];
}) {
  if (!active || !rows.length) return null;
  return (
    <div className="min-w-36 glass rounded-sm px-3 py-2 text-xs shadow-3">
      {title && <p className="mb-1.5 font-medium text-text">{title}</p>}
      {rows.map((r) => (
        <p key={r.label} className="flex items-center justify-between gap-4 text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: r.color }} aria-hidden />
            {r.label}
          </span>
          <span className="font-mono tabular text-text">{r.value}</span>
        </p>
      ))}
    </div>
  );
}
