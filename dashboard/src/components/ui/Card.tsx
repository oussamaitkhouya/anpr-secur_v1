import type { MouseEvent, ReactNode } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { cn } from "../../lib/cn";
import { revealItem } from "./motion";

/** Staggers the page-load reveal of the <Card>s inside it. */
export function RevealGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.07 } } }}>
      {children}
    </motion.div>
  );
}

type CardProps = HTMLMotionProps<"section"> & {
  /** lift on hover, for clickable cards */
  interactive?: boolean;
  tone?: "default" | "glass" | "gold" | "danger";
};

/** Feeds the pointer position to the .card-surface spotlight without re-rendering. */
function trackSpotlight(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
}

export function Card({ className, interactive, tone = "default", children, onMouseMove, ...rest }: CardProps) {
  return (
    <motion.section
      variants={revealItem}
      whileHover={interactive ? { y: -4 } : undefined}
      transition={{ type: "spring", stiffness: 300, damping: 24 }}
      onMouseMove={(e) => {
        trackSpotlight(e);
        onMouseMove?.(e);
      }}
      className={cn(
        "relative rounded-lg shadow-2 transition-shadow duration-300",
        tone === "glass" ? "glass" : "card-surface",
        tone === "gold" && "border border-gold shadow-[0_0_0_1px_var(--gold),0_18px_48px_-18px_var(--gold)]",
        tone === "danger" && "border border-danger shadow-[0_0_0_1px_var(--danger),0_18px_48px_-18px_var(--danger)]",
        interactive && "hover:shadow-3",
        className,
      )}
      {...rest}
    >
      {children}
    </motion.section>
  );
}

export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-5">
      <div className="min-w-0">
        <h2 className="font-display text-[1.05rem] font-semibold leading-snug tracking-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
