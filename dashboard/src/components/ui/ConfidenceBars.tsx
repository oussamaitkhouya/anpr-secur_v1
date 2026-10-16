import { motion } from "framer-motion";
import type { CharConfidence } from "../../api/types";
import { cn } from "../../lib/cn";

export const LOW_CONFIDENCE = 0.7;

/** One column per OCR character: the character in mono, a confidence bar, and the percentage. */
export function ConfidenceBars({ chars }: { chars: CharConfidence[] }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="OCR confidence per character" dir="ltr">
      {chars.map((c, i) => {
        const low = c.confidence < LOW_CONFIDENCE;
        return (
          <li
            key={i}
            className={cn(
              "flex w-11 flex-col items-center gap-1.5 rounded-sm border px-1 pb-1.5 pt-2",
              low ? "border-gold bg-gold-soft" : "border-border bg-surface-raised",
            )}
            aria-label={`Character ${c.char}: ${Math.round(c.confidence * 100)} percent${low ? ", low confidence, check the crop" : ""}`}
          >
            <span className={cn("font-mono text-lg font-medium leading-none", /\d/.test(c.char) ? "" : "font-sans")}>{c.char}</span>
            <span className="relative h-12 w-1.5 overflow-hidden rounded-full bg-bg-subtle" aria-hidden>
              <motion.span
                className={cn("absolute inset-x-0 bottom-0 rounded-full", low ? "bg-gold" : "bg-accent")}
                initial={{ height: 0 }}
                animate={{ height: `${c.confidence * 100}%` }}
                transition={{ delay: 0.15 + i * 0.04, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              />
            </span>
            <span className={cn("font-mono text-[10px] tabular", low ? "font-semibold text-gold-strong" : "text-muted")} aria-hidden>
              {Math.round(c.confidence * 100)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
