import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Lock, RotateCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";

function StateBox({ icon: Icon, tone, title, children, action }: {
  icon: LucideIcon;
  tone: "neutral" | "danger";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-14 text-center">
      <span className={`mb-4 grid size-12 place-items-center rounded-full ${tone === "danger" ? "bg-danger-soft text-danger" : "bg-bg-subtle text-muted"}`}>
        <Icon size={22} aria-hidden />
      </span>
      <p className="font-display text-lg">{title}</p>
      {children && <p className="mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <StateBox icon={Inbox} tone="neutral" title={title} action={action}>{children}</StateBox>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert">
      <StateBox
        icon={AlertTriangle}
        tone="danger"
        title="Could not load this data"
        action={onRetry && (
          <button type="button" onClick={onRetry} className="focus-ring inline-flex h-9 items-center gap-2 rounded-sm border border-border bg-surface px-3 text-sm shadow-1 hover:bg-bg-subtle">
            <RotateCw size={14} aria-hidden /> Try again
          </button>
        )}
      >
        {message}
      </StateBox>
    </div>
  );
}

export function NoAccessState({ what }: { what: string }) {
  return (
    <div role="alert">
      <StateBox icon={Lock} tone="danger" title="Access denied">
        Your role cannot open {what}. Ask an Admin if you need access.
      </StateBox>
    </div>
  );
}
