import { Link, useLocation } from "react-router";
import { ArrowRight, PlugZap } from "lucide-react";
import { PageHeader } from "../components/ui/PageHeader";
import { navFor } from "./nav";

/** Shown instead of a page that has no real data source yet. No placeholder numbers, no samples. */
export function NotConnected() {
  const item = navFor(useLocation().pathname);
  return (
    <>
      <PageHeader eyebrow={item?.group} title={item?.label ?? "Page"} />
      <div className="card-surface relative flex flex-col items-center rounded-lg px-6 py-16 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent"><PlugZap size={24} aria-hidden /></span>
        <p className="mt-4 font-display text-xl font-semibold">Not connected yet</p>
        <p className="mt-2 max-w-lg text-sm text-muted">
          This page has no real data source on the PostgreSQL API yet. It stays empty rather than show anything that is not real.
        </p>
        <Link to="/admin/cameras" className="focus-ring mt-6 inline-flex h-10 items-center gap-2 rounded-sm px-4 text-sm font-medium btn-primary">
          Go to Cities &amp; Cameras <ArrowRight size={15} aria-hidden />
        </Link>
      </div>
    </>
  );
}
