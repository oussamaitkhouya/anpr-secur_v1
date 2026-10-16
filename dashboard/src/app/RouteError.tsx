import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { AlertOctagon, RotateCw } from "lucide-react";

/**
 * Shown inside the app shell when a page throws while rendering, so one broken page never
 * takes down navigation. The message is the error's own text; no stack trace is displayed.
 */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : "Unknown error";
  return (
    <div role="alert" className="card-surface relative mx-auto mt-8 flex max-w-xl flex-col items-center rounded-lg px-6 py-14 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-danger-soft text-danger"><AlertOctagon size={24} aria-hidden /></span>
      <p className="mt-4 font-display text-xl font-semibold">This page ran into a problem</p>
      <p className="mt-2 text-sm text-muted">The rest of the app still works. Reload to try again; if it keeps happening, tell an admin what you were doing.</p>
      <code className="mt-4 max-w-full break-words rounded-sm bg-bg-subtle px-3 py-1.5 font-mono text-xs text-muted">{message}</code>
      <div className="mt-6 flex gap-2">
        <button type="button" onClick={() => window.location.reload()} className="focus-ring btn-primary inline-flex h-10 items-center gap-2 rounded-sm px-4 text-sm font-medium">
          <RotateCw size={15} aria-hidden /> Reload
        </button>
        <Link to="/" className="focus-ring inline-flex h-10 items-center rounded-sm border border-border px-4 text-sm font-medium hover:bg-bg-subtle">Back to Overview</Link>
      </div>
    </div>
  );
}
