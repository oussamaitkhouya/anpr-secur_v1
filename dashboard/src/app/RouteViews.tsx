import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { EmptyState, NoAccessState } from "../components/ui/States";
import { PageHeader } from "../components/ui/PageHeader";
import type { Permission } from "../lib/rbac";
import { navFor } from "./nav";
import { useSession } from "./session";

/** Renders children only if the current role has `permission`. */
export function Guard({ permission, what, children }: { permission: Permission; what: string; children: ReactNode }) {
  const { can } = useSession();
  return can(permission) ? children : <NoAccessState what={what} />;
}

/** Temporary page body until each page is built. */
export function Placeholder() {
  const item = navFor(useLocation().pathname);
  return (
    <>
      <PageHeader eyebrow={item?.group} title={item?.label ?? "Page"} />
      <EmptyState title="Coming next">This page is built in a later step.</EmptyState>
    </>
  );
}

export function NotFound() {
  return (
    <EmptyState title="Page not found" action={<Link to="/" className="text-accent underline-offset-4 hover:underline">Back to Overview</Link>}>
      Nothing lives at this address.
    </EmptyState>
  );
}
