import { useId } from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

/** Accessible multi-select as a list of checkboxes (used for allowed cities). */
export function CheckboxList({ legend, options, value, onChange, hint }: {
  legend: string;
  options: { id: string; label: string; detail?: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  hint?: string;
}) {
  const hintId = useId();
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <fieldset aria-describedby={hint ? hintId : undefined}>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      {hint && <p id={hintId} className="mb-2 text-xs text-muted">{hint}</p>}
      <div className="space-y-1.5">
        {options.map((o) => {
          const checked = value.includes(o.id);
          return (
            <label
              key={o.id}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-sm border px-3 py-2 text-sm transition-colors focus-within:shadow-[0_0_0_3px_var(--ring)]",
                checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-bg-subtle",
              )}
            >
              <input type="checkbox" checked={checked} onChange={() => toggle(o.id)} className="sr-only" />
              <span className={cn("grid size-4 shrink-0 place-items-center rounded-[4px] border", checked ? "border-accent bg-accent text-accent-fg" : "border-border-strong")} aria-hidden>
                {checked && <Check size={11} />}
              </span>
              <span className="flex-1">{o.label}</span>
              {o.detail && <span className="text-xs text-faint">{o.detail}</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
