import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { ScrollText } from "lucide-react";
import { ApiError } from "../../api/errors";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/**
 * Asks for a written reason before a sensitive action (review decision, plate reveal).
 * The text is sent to the API, which validates it again and writes it to the audit log.
 */
export function JustificationDialog({ open, onClose, title, description, label, placeholder, confirmLabel, variant = "primary", minLength, validate, onSubmit }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  variant?: "primary" | "danger" | "gold";
  minLength: number;
  /** extra client-side check; return an error message or null */
  validate?: (text: string) => string | null;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const hintId = useId();

  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);

  const length = text.trim().length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = length < minLength ? `Write at least ${minLength} characters.` : validate?.(text) ?? null;
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await onSubmit(text.trim());
      onClose();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? () => {} : onClose} title={title} description={description}>
      <form onSubmit={submit} noValidate>
        <label htmlFor={fieldId} className="text-sm font-medium">{label}</label>
        <textarea
          id={fieldId}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          rows={4}
          placeholder={placeholder}
          aria-invalid={!!error}
          aria-describedby={hintId}
          className="focus-ring mt-2 w-full resize-y rounded-sm border border-border bg-surface px-3 py-2.5 text-sm shadow-1 placeholder:text-faint aria-[invalid=true]:border-danger"
        />
        <div id={hintId} className="mt-2 flex items-start justify-between gap-4 text-xs">
          <span className={error ? "text-danger" : "flex items-center gap-1.5 text-muted"} role={error ? "alert" : undefined}>
            {error ?? (
              <>
                <ScrollText size={13} aria-hidden /> Saved to the audit log with your username, time and IP.
              </>
            )}
          </span>
          <span className={`shrink-0 font-mono tabular ${length >= minLength ? "text-ok" : "text-faint"}`}>
            {length}/{minLength}
          </span>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant={variant} loading={busy}>{confirmLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}
