import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { shortHash } from "../../lib/format";

/** Shortened hash in mono with a copy button; the full value is in the title and the clipboard. */
export function HashText({ value, chars = 8, copy = true }: { value: string; chars?: number; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard blocked: the value is still selectable in the title tooltip
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-muted" title={value}>
      <span>{shortHash(value, chars)}</span>
      {copy && (
        <button type="button" onClick={onCopy} className="focus-ring rounded-xs p-0.5 text-faint hover:text-text" aria-label={copied ? "Copied" : "Copy full hash"}>
          {copied ? <Check size={12} className="text-ok" aria-hidden /> : <Copy size={12} aria-hidden />}
        </button>
      )}
    </span>
  );
}
