import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, ChevronDown, Command, LogOut, Moon, Search, Settings, Sun } from "lucide-react";
import { useSession } from "../../app/session";
import { ROLE_LABELS } from "../../lib/rbac";
import { useDismiss } from "../../lib/useDismiss";
import { Breadcrumbs } from "./Breadcrumbs";
import { LiveDot } from "../ui/LiveDot";
import { priorityOf, REASON_LABELS, useAlerts } from "../../features/operations/api";
import { relativeTime } from "../../lib/format";
import { useCameraActive } from "../../camera/activeStore";

const iconButton =
  "focus-ring relative grid size-10 place-items-center rounded-sm text-muted transition-colors hover:bg-bg-subtle hover:text-text";

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const cameraOn = useCameraActive();

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/search?q=${encodeURIComponent(q.trim())}`);
    setQ("");
  };

  return (
    <header className="sticky top-0 z-20 flex h-[var(--topbar-h)] items-center gap-4 border-b border-border/70 bg-glass px-6 backdrop-blur-2xl">
      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>

      {session.can("search:view") && (
        <form role="search" onSubmit={submitSearch} className="hidden md:block">
          <label className="flex h-10 w-64 items-center gap-2 rounded-full border border-border bg-surface/60 px-4 text-sm shadow-1 transition-[width,box-shadow,border-color] duration-300 focus-within:w-80 focus-within:border-accent focus-within:shadow-glow lg:w-72">
            <Search size={16} className="text-faint" aria-hidden />
            <span className="sr-only">Search plates</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search plates…"
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-faint"
            />
          </label>
        </form>
      )}

      <button
        type="button"
        onClick={onOpenPalette}
        className="focus-ring hidden h-10 items-center gap-2 rounded-full border border-border bg-surface/60 px-4 text-sm text-muted shadow-1 transition-colors hover:border-border-strong hover:text-text sm:flex"
        aria-keyshortcuts="Control+K"
      >
        <Command size={15} aria-hidden />
        <span>Commands</span>
        <kbd className="rounded-xs bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px]">Ctrl K</kbd>
      </button>

      {cameraOn && (
        <Link
          to="/camera"
          className="focus-ring flex h-8 shrink-0 items-center gap-2 rounded-full border border-danger bg-danger-soft px-3 text-xs font-semibold text-danger"
          aria-live="polite"
        >
          <LiveDot tone="danger" /> Camera is on
        </Link>
      )}

      <span className="hidden h-8 items-center gap-2 rounded-full border border-ok/30 bg-ok-soft px-3 text-xs font-semibold text-ok lg:flex">
        <LiveDot /> Live
      </span>

      <div className="flex items-center gap-1">
        <NotificationBell />
        <button
          type="button"
          onClick={session.toggleTheme}
          className={iconButton}
          aria-label={session.theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          {session.theme === "light" ? <Moon size={18} aria-hidden /> : <Sun size={18} aria-hidden />}
        </button>
        <UserMenu />
      </div>
    </header>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const { can } = useSession();
  const alerts = useAlerts(can("alerts:view"));
  const data = (alerts.data ?? []).filter((a) => a.status === "pending").slice(0, 50).map((a) => ({
    id: a.id,
    href: `/alerts?id=${a.id}`,
    title: "Watchlist match awaiting review",
    body: `${a.cityName} · ${a.cameraName} · ${REASON_LABELS[a.watchlistEntry.reason]}`,
    at: a.observedAt,
    severity: priorityOf(a.watchlistEntry.reason),
  }));
  const critical = data.some((n) => n.severity === "critical");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={iconButton}
        aria-label={`Notifications${data.length ? `, ${data.length} new` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={18} aria-hidden />
        {data.length > 0 && (
          <span
            className={`absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full px-1 font-mono text-[10px] font-semibold tabular ${critical ? "bg-gold text-plate-ink" : "bg-accent text-accent-fg"}`}
            aria-hidden
          >
            {data.length}
          </span>
        )}
      </button>
      <Popover open={open} className="w-[22rem]">
        <p className="border-b border-border px-4 py-3 text-sm font-medium">Notifications</p>
        {data.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">You're all caught up.</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto p-1.5">
            {data.map((n) => (
              <li key={n.id}>
                <Link to={n.href} onClick={close} className="focus-ring flex gap-3 rounded-sm px-3 py-2.5 hover:bg-bg-subtle">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.severity === "critical" ? "bg-gold" : n.severity === "high" ? "bg-danger" : "bg-warn"}`} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{n.title}</span>
                    <span className="block truncate text-xs text-muted">{n.body}</span>
                    <span className="block text-[11px] text-faint">{relativeTime(n.at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </div>
  );
}

function UserMenu() {
  const { user, role, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div ref={ref} className="relative ml-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="focus-ring flex h-10 items-center gap-2.5 rounded-sm pl-1 pr-2 hover:bg-bg-subtle"
      >
        <span className="bg-brand grid size-9 place-items-center rounded-full p-[2px] shadow-glow"><span className="grid size-full place-items-center rounded-full bg-surface-raised font-display text-[13px] font-bold text-accent">
          {user.name.replace(/^Demo /, "").split(/[\s·]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("")}
        </span></span>
        <span className="hidden text-left leading-tight xl:block">
          <span className="block text-sm font-medium">{user.name}</span>
          <span className="block text-xs text-muted">{ROLE_LABELS[role]}</span>
        </span>
        <ChevronDown size={14} className="text-faint" aria-hidden />
      </button>
      <Popover open={open} className="w-64">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-medium">{user.name}</p>
          <p className="font-mono text-xs text-muted">{user.username}</p>
          <span className="mt-2 inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
            Role: {ROLE_LABELS[role]}
          </span>
          <p className="mt-2 text-xs text-muted">
            {role === "admin" || role === "super_admin" ? "All cities" : role === "auditor" ? "No camera access" : `Cities: ${user.allowedCityIds.length}`}
          </p>
        </div>
        <div role="menu" className="p-1.5">
          <Link role="menuitem" to="/settings" onClick={close} className="focus-ring flex items-center gap-2.5 rounded-sm px-3 py-2 text-sm text-muted hover:bg-bg-subtle hover:text-text">
            <Settings size={16} aria-hidden /> Settings
          </Link>
          <button role="menuitem" type="button" onClick={() => { close(); void signOut(); }} className="focus-ring flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-sm text-muted hover:bg-bg-subtle hover:text-text">
            <LogOut size={16} aria-hidden /> Sign out
          </button>
        </div>
      </Popover>
    </div>
  );
}

function Popover({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -8, scale: 0.96, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -4, scale: 0.98, filter: "blur(4px)" }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className={`absolute right-0 top-12 z-40 origin-top-right overflow-hidden glass rounded-md shadow-3 ${className ?? ""}`}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
