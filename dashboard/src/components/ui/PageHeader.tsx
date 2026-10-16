import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { EASE_OUT } from "./motion";

/** Page title; its last word is set in italic serif with the brand gradient. */
export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  const words = title.split(" ");
  const head = words.slice(0, -1).join(" ");
  const last = words[words.length - 1];
  return (
    <motion.div
      className="mb-9 flex flex-wrap items-end justify-between gap-4"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_OUT }}
    >
      <div className="min-w-0 max-w-3xl">
        {eyebrow && (
          <p className="mb-3 flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            <span className="bg-brand h-px w-7 rounded-full" aria-hidden />
            {eyebrow}
          </p>
        )}
        <h1 className="text-[2.1rem] font-semibold leading-[1.05] tracking-[-0.035em] text-text md:text-[2.8rem]">
          {head && <>{head} </>}
          <span className="text-gradient pr-1 font-serif text-[1.08em] font-normal italic tracking-[-0.01em]">{last}</span>
        </h1>
        {description && <p className="mt-3 text-[15px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </motion.div>
  );
}
