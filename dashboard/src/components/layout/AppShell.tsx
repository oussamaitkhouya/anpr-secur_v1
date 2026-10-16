import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { readPref, writePref } from "../../lib/storage";
import { CommandPalette } from "./CommandPalette";
import { DemoRibbon } from "./DemoRibbon";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

function initialCollapsed(): boolean {
  const saved = readPref("sidebar");
  if (saved === "collapsed" || saved === "expanded") return saved === "collapsed";
  return window.innerWidth < 1200; // tablets start with the icon rail
}

export function AppShell() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      writePref("sidebar", c ? "expanded" : "collapsed");
      return !c;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="focus-ring sr-only z-50 rounded-sm bg-accent px-4 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenPalette={() => setPaletteOpen(true)} />
        <AnimatePresence mode="wait">
          <motion.main
            id="main"
            key={location.pathname}
            tabIndex={-1}
            className="mx-auto w-full max-w-[1480px] flex-1 px-6 py-8 outline-none lg:px-10"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <DemoRibbon />
            <Outlet />
          </motion.main>
        </AnimatePresence>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
