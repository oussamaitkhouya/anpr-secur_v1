import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, LogOut, Moon, Search, Sun, type LucideIcon } from "lucide-react";
import { NAV } from "../../app/nav";
import { useSession } from "../../app/session";
import { cn } from "../../lib/cn";

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  keywords: string;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const session = useSession();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActive(0);
    } else {
      returnFocus.current?.focus();
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go = NAV.filter((n) => session.can(n.permission)).map<Command>((n) => ({
      id: `go:${n.path}`,
      label: n.label,
      hint: "Go to",
      icon: n.icon,
      keywords: `${n.label} ${n.keywords ?? ""}`,
      run: () => navigate(n.path),
    }));
    const signOut: Command = {
      id: "signout",
      label: "Sign out",
      hint: "Account",
      icon: LogOut,
      keywords: "sign out logout log out switch account user",
      run: () => void session.signOut(),
    };
    const theme: Command = {
      id: "theme",
      label: session.theme === "light" ? "Switch to dark mode" : "Switch to light mode",
      hint: "Appearance",
      icon: session.theme === "light" ? Moon : Sun,
      keywords: "theme dark light appearance",
      run: session.toggleTheme,
    };
    return [...go, theme, signOut];
  }, [navigate, session]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    const matched = q ? commands.filter((c) => c.keywords.toLowerCase().includes(q)) : commands;
    if (q && session.can("search:view")) {
      matched.push({
        id: "search",
        label: `Search plates for "${query.trim()}"`,
        hint: "Plate Search",
        icon: Search,
        keywords: "",
        run: () => navigate(`/search?q=${encodeURIComponent(query.trim())}`),
      });
    }
    return matched;
  }, [commands, q, query, navigate, session]);

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(results.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % Math.max(results.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault(); // focus stays in the dialog; arrows move the selection
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-overlay px-4 pt-[14vh] backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface-raised shadow-3"
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search size={18} className="text-faint" aria-hidden />
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Jump to a page, run an action, or search a plate…"
                className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
                role="combobox"
                aria-expanded="true"
                aria-controls="cmdk-list"
                aria-activedescendant={results[active] ? `cmdk-${results[active].id}` : undefined}
              />
              <kbd className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-[11px] text-faint">Esc</kbd>
            </div>
            <ul id="cmdk-list" role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto p-2">
              {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No matching commands.</li>}
              {results.map((c, i) => (
                <li
                  key={c.id}
                  id={`cmdk-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runAt(i)}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2.5 text-sm",
                    i === active ? "bg-accent-soft text-text" : "text-muted",
                  )}
                >
                  <c.icon size={16} className={i === active ? "text-accent" : "text-faint"} aria-hidden />
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-xs text-faint">{c.hint}</span>
                  {i === active && <CornerDownLeft size={14} className="text-faint" aria-hidden />}
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
