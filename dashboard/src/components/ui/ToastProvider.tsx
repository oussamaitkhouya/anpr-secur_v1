import { useCallback, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertOctagon, CheckCircle2, Info, Siren, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { ToastContext, type ToastInput, type ToastTone } from "./toast";

interface Toast extends ToastInput {
  id: number;
}

const TONES: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CheckCircle2, className: "text-ok" },
  error: { icon: AlertOctagon, className: "text-danger" },
  info: { icon: Info, className: "text-accent" },
  critical: { icon: Siren, className: "text-gold-strong" },
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = nextId++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.tone === "error" || t.tone === "critical" ? 8000 : 5000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" aria-relevant="additions" className="pointer-events-none fixed bottom-6 right-6 z-[60] flex w-[min(380px,calc(100vw-3rem))] flex-col gap-3">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const tone = TONES[t.tone ?? "info"];
            return (
              <motion.div
                key={t.id}
                layout
                role={t.tone === "error" ? "alert" : "status"}
                initial={{ opacity: 0, y: 16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
                className={cn(
                  "pointer-events-auto flex items-start gap-3 rounded-md border bg-surface-raised p-4 shadow-3",
                  t.tone === "critical" ? "border-gold" : "border-border",
                )}
              >
                <tone.icon size={18} className={cn("mt-0.5 shrink-0", tone.className)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t.title}</p>
                  {t.body && <p className="mt-0.5 text-sm text-muted">{t.body}</p>}
                </div>
                <button type="button" onClick={() => dismiss(t.id)} className="focus-ring -m-1 rounded-xs p-1 text-faint hover:text-text" aria-label="Dismiss">
                  <X size={14} aria-hidden />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
