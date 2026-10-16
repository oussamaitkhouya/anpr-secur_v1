import { Link, useLocation } from "react-router";
import { ChevronRight } from "lucide-react";
import { navFor } from "../../app/nav";

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const section = navFor(pathname);
  const detail = section && pathname !== section.path ? decodeURIComponent(pathname.slice(section.path.length + 1)) : null;

  const crumbs = [{ label: "Overview", to: "/" }];
  if (section && section.path !== "/") crumbs.push({ label: section.label, to: section.path });
  if (detail) crumbs.push({ label: detail, to: pathname });

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${c.to}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight size={14} className="shrink-0 text-faint" aria-hidden />}
              {last ? (
                <span aria-current="page" className="truncate font-medium text-text">
                  {c.label}
                </span>
              ) : (
                <Link to={c.to} className="focus-ring truncate rounded-xs text-muted hover:text-text">
                  {c.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
