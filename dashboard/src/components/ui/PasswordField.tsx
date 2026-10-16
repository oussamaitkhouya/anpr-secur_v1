import { useId, useState } from "react";
import { Check, Eye, EyeOff, Sparkles, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { generatePassword, passwordChecks } from "../../lib/passwordPolicy";

/**
 * New-password input with the policy checklist, a generator, and a confirmation field.
 * Write-only: nothing ever fills it from the server.
 */
export function PasswordField({ value, confirm, onChange, onConfirmChange, username, label = "Password" }: {
  value: string;
  confirm: string;
  onChange: (v: string) => void;
  onConfirmChange: (v: string) => void;
  username: string;
  label?: string;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  const confirmId = useId();
  const checksId = useId();
  const checks = passwordChecks(value, username);
  const mismatch = confirm.length > 0 && confirm !== value;
  const input = "focus-ring h-10 w-full rounded-sm border border-border bg-surface px-3 font-mono text-sm shadow-1";

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor={id} className="text-sm font-medium">{label}</label>
          <button
            type="button"
            onClick={() => {
              const p = generatePassword();
              onChange(p);
              onConfirmChange(p);
              setShow(true);
            }}
            className="focus-ring inline-flex items-center gap-1 rounded-xs text-xs text-accent hover:underline"
          >
            <Sparkles size={12} aria-hidden /> Generate strong password
          </button>
        </div>
        <span className="relative block">
          <input
            id={id}
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            aria-describedby={checksId}
            className={`${input} pr-10`}
          />
          <button type="button" onClick={() => setShow((s) => !s)} className="focus-ring absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-xs text-faint hover:text-text" aria-label={show ? "Hide password" : "Show password"}>
            {show ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
          </button>
        </span>
      </div>
      <ul id={checksId} className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {checks.map((c) => (
          <li key={c.label} className={cn("flex items-center gap-1.5", value ? (c.ok ? "text-ok" : "text-danger") : "text-faint")}>
            {value && c.ok ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
            {c.label}
            <span className="sr-only">{c.ok ? "(met)" : "(not met)"}</span>
          </li>
        ))}
      </ul>
      <div>
        <label htmlFor={confirmId} className="mb-1.5 block text-sm font-medium">Repeat password</label>
        <input
          id={confirmId}
          type={show ? "text" : "password"}
          value={confirm}
          onChange={(e) => onConfirmChange(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          aria-invalid={mismatch}
          className={cn(input, mismatch && "border-danger")}
        />
        {mismatch && <p className="mt-1 text-xs text-danger" role="alert">The passwords do not match.</p>}
      </div>
    </div>
  );
}
