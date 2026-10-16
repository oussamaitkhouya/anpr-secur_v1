const nf = new Intl.NumberFormat("en-GB");
const nf1 = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const formatNumber = (n: number) => nf.format(Math.round(n));
export const formatPercent = (ratio: number, digits = 1) => `${(ratio * 100).toFixed(digits)}%`;
export const formatMs = (ms: number) => `${formatNumber(ms)} ms`;
export const formatDecimal = (n: number) => nf1.format(n);

const dtf = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const tf = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const df = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });

export const formatDateTime = (iso: string) => dtf.format(new Date(iso));
export const formatTime = (iso: string) => tf.format(new Date(iso));
export const formatDate = (iso: string) => df.format(new Date(iso));

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return s <= 0 ? "just now" : "in a moment";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export const shortHash = (hash: string, n = 8) => (hash.length > n * 2 ? `${hash.slice(0, n)}…${hash.slice(-n)}` : hash);
