import { useReducedMotion } from "framer-motion";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { PlateType } from "../../api/types";
import { formatNumber, formatPercent } from "../../lib/format";
import { PLATE_TYPE_LABELS } from "../../lib/plate";
import { ChartTooltip } from "./ChartTooltip";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];

export function PlateTypeDonut({ data }: { data: { type: PlateType; count: number }[] }) {
  const reduce = useReducedMotion();
  const total = data.reduce((s, d) => s + d.count, 0) || 1;
  const rows = data.map((d, i) => ({ ...d, label: PLATE_TYPE_LABELS[d.type], color: COLORS[i % COLORS.length], share: d.count / total }));

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative size-48" role="img" aria-label={`Detections by plate type today: ${rows.map((r) => `${r.label} ${formatPercent(r.share, 0)}`).join(", ")}.`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="count"
              nameKey="label"
              innerRadius="70%"
              outerRadius="100%"
              paddingAngle={1.5}
              cornerRadius={4}
              stroke="none"
              startAngle={90}
              endAngle={-270}
              isAnimationActive={!reduce}
              animationDuration={1000}
            >
              {rows.map((r) => <Cell key={r.type} fill={r.color} />)}
            </Pie>
            <Tooltip
              content={({ active, payload }) => (
                <ChartTooltip
                  active={active}
                  rows={(payload ?? []).map((p) => ({ label: String(p.name), value: `${formatNumber(Number(p.value))} · ${formatPercent(Number(p.value) / total)}`, color: String(p.payload?.color ?? "") }))}
                />
              )}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
          <span className="font-display text-3xl font-medium tabular">{formatNumber(total)}</span>
          <span className="text-xs text-muted">reads today</span>
        </div>
      </div>
      <ul className="grid w-full grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {rows.map((r) => (
          <li key={r.type} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-muted">
              <span className="size-2.5 rounded-full" style={{ background: r.color }} aria-hidden />
              {r.label}
            </span>
            <span className="font-mono text-[12px] tabular">{formatPercent(r.share, r.share < 0.1 ? 1 : 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
