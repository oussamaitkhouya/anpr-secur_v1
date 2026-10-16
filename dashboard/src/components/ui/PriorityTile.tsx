import type { Priority } from "../../api/types";
import { PRIORITY_COLOR, PRIORITY_ICON } from "./priority";

/** Priority as an icon tile: the colour and the glyph both carry it, not colour alone. */
export function PriorityTile({ priority, size = "md", pulse }: { priority: Priority; size?: "sm" | "md" | "lg"; pulse?: boolean }) {
  const Icon = PRIORITY_ICON[priority];
  const c = PRIORITY_COLOR[priority];
  const px = { sm: 32, md: 40, lg: 52 }[size];
  return (
    <span className="relative grid shrink-0 place-items-center rounded-[12px]"
      style={{
        width: px, height: px, color: c,
        background: `color-mix(in oklab, ${c} 15%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 38%, transparent), 0 8px 22px -10px ${c}`,
      }}
      aria-hidden>
      {pulse && <span className="absolute inset-0 rounded-[12px] motion-safe:animate-[live-pulse_2.2s_var(--ease-out)_infinite]" style={{ boxShadow: `0 0 0 2px ${c}` }} />}
      <Icon size={px * 0.45} strokeWidth={2.1} />
    </span>
  );
}
