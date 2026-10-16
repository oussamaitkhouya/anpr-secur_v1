import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import type { Priority } from "../../api/types";
import { PriorityTile } from "./PriorityTile";
import { cn } from "../../lib/cn";
import { PlateText } from "./PlateText";

/** The alert card used in the Alerts queue and on the Live Camera page. */
export function AlertCard({ plate, priority, title, meta, trailing, lowConfidence, active, fresh, waiting, waitingSlow, onClick }: {
  plate: string;
  priority: Priority;
  title: string;
  meta: ReactNode;
  /** right side of the meta row, e.g. a status badge */
  trailing?: ReactNode;
  lowConfidence?: boolean;
  active?: boolean;
  fresh?: boolean;
  /** time waiting for a decision, shown top right ("3:18") */
  waiting?: string;
  /** waiting long enough to need attention */
  waitingSlow?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <PriorityTile priority={priority} pulse={fresh} />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-center justify-between gap-2">
          <PlateText value={plate} size="sm" />
          {waiting ? (
            <span className={cn("font-mono text-[11px] font-medium tabular", waitingSlow ? "text-warn" : "text-faint")} title="Waiting for a decision">{waiting}</span>
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: `var(--${priority === "critical" ? "gold-strong" : priority === "high" ? "danger" : "warn"})` }}>{priority}</span>
          )}
        </span>
        <span className="block truncate text-sm">{title}</span>
        <span className="flex items-center justify-between gap-2 text-xs text-muted">
          <span className="truncate">{meta}</span>
          {trailing ?? (lowConfidence ? <span className="flex shrink-0 items-center gap-1 font-medium text-gold-strong"><AlertTriangle size={12} aria-hidden /> Check</span> : null)}
        </span>
      </span>
    </>
  );
  const className = cn(
    "flex w-full items-start gap-3 rounded-md border p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-200",
    active ? "border-accent bg-accent-soft shadow-glow" : fresh ? "border-gold bg-gold-soft" : "border-transparent",
    onClick && !active && "hover:-translate-y-px hover:bg-bg-subtle",
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-current={active ? "true" : undefined} className={cn("focus-ring", className)}>
      <span className="sr-only">{priority} priority. </span>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}
