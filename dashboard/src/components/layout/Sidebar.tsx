import { NavLink } from "react-router";
import { motion } from "framer-motion";
import { PanelLeftClose, PanelLeftOpen, ScanLine } from "lucide-react";
import { NAV, NAV_GROUPS } from "../../app/nav";
import { useSession } from "../../app/session";
import { demoMode } from "../../api/client";
import { cn } from "../../lib/cn";

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { can } = useSession();
  const items = NAV.filter((n) => can(n.permission));

  return (
    <motion.aside
      aria-label="Main navigation"
      className="sticky top-0 z-30 flex h-screen shrink-0 flex-col border-r border-border/70 bg-glass backdrop-blur-2xl"
      animate={{ width: collapsed ? "var(--sidebar-w-collapsed)" : "var(--sidebar-w)" }}
      initial={false}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex h-[var(--topbar-h)] items-center gap-3 px-5">
        <span className="btn-primary relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-[11px]">
          <ScanLine size={18} strokeWidth={2.2} aria-hidden />
          <span className="scan-beam" aria-hidden />
        </span>
        {!collapsed && (
          <span className="truncate font-display text-[1.2rem] font-bold tracking-[-0.03em]">
            ANPR <span className="text-gradient font-serif text-[1.15em] font-normal italic tracking-normal">Secure</span>
          </span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => {
          const groupItems = items.filter((i) => i.group === group);
          if (!groupItems.length) return null;
          return (
            <div key={group} className="mt-4 first:mt-2">
              {collapsed ? (
                <div className="mx-3 mb-2 border-t border-border" aria-hidden />
              ) : (
                <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-faint">{group}</p>
              )}
              <ul className="space-y-0.5">
                {groupItems.map(({ path, label, icon: Icon, connected }) => (
                  <li key={path}>
                    <NavLink
                      to={path}
                      end={path === "/"}
                      title={collapsed ? label : undefined}
                      aria-label={collapsed ? label : undefined}
                      className={({ isActive }) =>
                        cn(
                          "focus-ring group relative flex h-10 items-center gap-3 rounded-sm px-3 text-sm transition-colors",
                          isActive ? "font-medium text-text" : "text-muted hover:bg-bg-subtle/70 hover:text-text",
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && (
                            <motion.span
                              layoutId="nav-active"
                              transition={{ type: "spring", stiffness: 380, damping: 32 }}
                              className="absolute inset-0 rounded-sm border border-border bg-[linear-gradient(90deg,var(--accent-soft),transparent)] shadow-1"
                              aria-hidden
                            >
                              <span className="bg-brand absolute inset-y-2 -left-px w-[3px] rounded-full shadow-[0_0_12px_var(--accent)]" />
                            </motion.span>
                          )}
                          <Icon
                            size={18}
                            className={cn("relative shrink-0 transition-transform duration-300 group-hover:scale-110", isActive && "text-accent drop-shadow-[0_0_8px_var(--accent)]")}
                            aria-hidden
                          />
                          {!collapsed && <span className="relative truncate">{label}</span>}
                          {!collapsed && !connected && !demoMode && (
                            <span className="relative ml-auto rounded-full border border-border px-1.5 text-[10px] font-medium text-faint" title="Not connected to the PostgreSQL API yet">soon</span>
                          )}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="focus-ring flex h-10 w-full items-center gap-3 rounded-sm px-3 text-sm text-muted hover:bg-bg-subtle hover:text-text"
        >
          {collapsed ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}
          <span className={collapsed ? "sr-only" : ""}>{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
        </button>
      </div>
    </motion.aside>
  );
}
