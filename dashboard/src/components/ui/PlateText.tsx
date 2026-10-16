import { isMasked } from "../../lib/mask";
import { cn } from "../../lib/cn";

/** The physical plate's separator, drawn as a hairline so it can't be mistaken for the letter أ. */
function Divider() {
  return <span className="h-[55%] w-px bg-border-strong" aria-hidden />;
}

/**
 * A plate in canonical form, laid out like the physical plate (number | letter | region),
 * in monospace. Masked plates get a muted mask and an accessible label saying so.
 */
export function PlateText({ value, size = "md", className }: { value: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const [number, letter, region] = value.split("|");
  const masked = isMasked(value);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[7px] border border-border-strong bg-surface-raised font-mono tabular shadow-[inset_0_1px_0_rgb(255_255_255/0.06),var(--shadow-1)]",
        size === "sm" && "h-6 gap-1.5 px-2 text-[12px]",
        size === "md" && "h-8 gap-2 px-2.5 text-[14px]",
        size === "lg" && "h-12 gap-3 px-4 text-[22px]",
        className,
      )}
      aria-label={masked ? `Masked plate, region ${region}` : `Plate ${number} ${letter} ${region}`}
      dir="ltr"
    >
      <span className={masked ? "tracking-[0.2em] text-faint" : "font-medium tracking-wide"}>{number}</span>
      <Divider />
      <span className="font-sans font-semibold" lang="ar">{letter}</span>
      <Divider />
      <span>{region}</span>
    </span>
  );
}
