import { useId } from "react";
import { cn } from "../../lib/cn";

/** Accessible on/off switch (role="switch") with a visible label and optional hint. */
export function Switch({ checked, onChange, label, hint, disabled }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const hintId = useId();
  return (
    <span className="inline-flex items-center gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "focus-ring relative h-6 w-10 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-accent bg-accent" : "border-border-strong bg-bg-subtle",
        )}
      >
        <span className="sr-only">{label}</span>
        <span
          aria-hidden
          className={cn("absolute left-0 top-0.5 size-[18px] rounded-full bg-surface-raised shadow-1 transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")}
        />
      </button>
      <span className="text-sm" aria-hidden>{label}</span>
      {hint && <span id={hintId} className="sr-only">{hint}</span>}
    </span>
  );
}
