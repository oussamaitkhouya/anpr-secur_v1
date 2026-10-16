import { useId } from "react";
import { useReducedMotion } from "framer-motion";
import { Area, Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatNumber, formatTime } from "../../lib/format";
import { ChartTooltip } from "./ChartTooltip";

const AXIS = { fill: "var(--text-faint)", fontSize: 11, fontFamily: "var(--font-mono)" };

/** Reads per hour (area, left axis) and watchlist hits (gold bars, right axis), last 24 h. */
export function HourlyReadsChart({ data }: { data: { hour: string; reads: number; hits: number }[] }) {
  const reduce = useReducedMotion();
  const gradient = useId().replace(/:/g, "");
  return (
    <div className="h-72 w-full" role="img" aria-label={`Plate reads per hour over the last 24 hours, peak ${formatNumber(Math.max(...data.map((d) => d.reads)))} reads per hour.`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${gradient}-line`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="var(--chart-1)" />
              <stop offset="100%" stopColor="var(--accent-2)" />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="2 6" />
          <XAxis dataKey="hour" tickFormatter={formatTime} tick={AXIS} axisLine={false} tickLine={false} interval={3} minTickGap={12} />
          <YAxis yAxisId="reads" tick={AXIS} axisLine={false} tickLine={false} width={44} />
          <YAxis yAxisId="hits" orientation="right" tick={AXIS} axisLine={false} tickLine={false} width={24} allowDecimals={false} />
          <Tooltip
            cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }}
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                title={label ? `${formatTime(String(label))}–${formatTime(new Date(Date.parse(String(label)) + 3_600_000).toISOString())}` : undefined}
                rows={(payload ?? []).map((p) => ({
                  label: p.dataKey === "reads" ? "Plate reads" : "Watchlist hits",
                  value: formatNumber(Number(p.value)),
                  color: p.dataKey === "reads" ? "var(--chart-1)" : "var(--gold)",
                }))}
              />
            )}
          />
          <Area
            yAxisId="reads"
            dataKey="reads"
            type="monotone"
            stroke={`url(#${gradient}-line)`}
            strokeWidth={2.5}
            fill={`url(#${gradient})`}
            isAnimationActive={!reduce}
            animationDuration={1200}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-raised)" }}
          />
          <Bar yAxisId="hits" dataKey="hits" fill="var(--gold)" radius={[3, 3, 0, 0]} barSize={6} isAnimationActive={!reduce} animationDuration={900} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
