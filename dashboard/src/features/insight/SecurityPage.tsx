/*
 * /security: posture computed live by the API (cameras, accounts, sign-in, integrity,
 * configuration), and recent security events from the audit log. No static claims.
 */
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { useSecurity, type SecurityCheck } from "./api";

const ICON = { ok: CheckCircle2, warn: AlertTriangle, fail: XCircle };
const COLOR = { ok: "text-ok", warn: "text-warn", fail: "text-danger" };

export default function SecurityPage() {
  const sec = useSecurity();
  const checks = sec.data?.checks ?? [];
  const areas = [...new Set(checks.map((c) => c.area))];
  const score = checks.length ? checks.filter((c) => c.status === "ok").length / checks.length : null;

  return (
    <>
      <PageHeader eyebrow="Assure" title="Security center"
        description="Live checks of the cameras, accounts, sign-in activity, audit integrity and configuration. Each line is a query run just now."
        actions={<Button onClick={() => void sec.refetch()} loading={sec.isFetching}><RefreshCw size={14} aria-hidden /> Re-run checks</Button>} />
      {sec.error ? <ErrorState error={sec.error} onRetry={() => void sec.refetch()} />
        : !sec.data ? <div className="grid gap-5 lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-48 rounded-lg" />)}</div>
        : (
          <div className="space-y-6">
            <Card className="flex flex-wrap items-center gap-6 p-6">
              <Score value={score} />
              <div className="flex flex-wrap gap-2">
                {(["fail", "warn", "ok"] as const).map((s) => (
                  <Badge key={s} tone={s === "ok" ? "ok" : s === "warn" ? "warn" : "danger"} dot>{checks.filter((c) => c.status === s).length} {s === "ok" ? "passing" : s === "warn" ? "to review" : "failing"}</Badge>
                ))}
              </div>
              <p className="ml-auto text-xs text-muted">Checked {relativeTime(sec.data.checkedAt)}</p>
            </Card>
            <div className="grid gap-5 lg:grid-cols-2">
              {areas.map((area) => (
                <Card key={area}>
                  <CardHeader title={area} />
                  <ul className="space-y-1 p-3">
                    {checks.filter((c) => c.area === area).map((c, i) => <CheckRow key={c.id} check={c} index={i} />)}
                  </ul>
                </Card>
              ))}
            </div>
            <Card>
              <CardHeader title="Recent security events" subtitle="Failed sign-ins, lockouts and token reuse, from the audit log" />
              {!sec.data.recentEvents.length ? <div className="p-6"><EmptyState title="Nothing to report">No failed sign-in, lockout or token reuse recorded.</EmptyState></div> : (
                <ul className="divide-y divide-border px-3 pb-3">
                  {sec.data.recentEvents.map((e) => (
                    <li key={e.seq} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                      <span className="flex items-center gap-2"><ShieldAlert size={14} className="text-danger" aria-hidden /><span className="font-mono text-xs">{e.action}</span><span className="text-xs text-muted">from {e.ip}</span></span>
                      <span className="text-xs text-muted tabular">#{e.seq} · {formatDateTime(e.ts)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
    </>
  );
}

function CheckRow({ check: c, index }: { check: SecurityCheck; index: number }) {
  const Icon = ICON[c.status];
  return (
    <motion.li initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0, transition: { delay: index * 0.04 } }}
      className={cn("flex items-start gap-3 rounded-md px-3 py-2.5", c.status === "fail" && "bg-danger-soft/50")}>
      <Icon size={18} className={cn("mt-0.5 shrink-0", COLOR[c.status])} aria-label={c.status} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{c.title}</span>
        <span className="block text-xs text-muted">{c.detail}</span>
      </span>
      {c.count !== null && c.status !== "ok" && <span className={cn("font-mono text-sm font-semibold tabular", COLOR[c.status])}>{c.count}</span>}
    </motion.li>
  );
}

function Score({ value }: { value: number | null }) {
  const size = 84;
  const r = 34;
  const c = 2 * Math.PI * r;
  const color = value === null ? "var(--text-faint)" : value >= 0.85 ? "var(--ok)" : value >= 0.6 ? "var(--warn)" : "var(--danger)";
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={7} style={{ stroke: "var(--border)" }} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={7} strokeLinecap="round" style={{ stroke: color }}
          strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - (value ?? 0)) }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }} />
      </svg>
      <span className="absolute font-display text-xl font-semibold tabular">{value === null ? "—" : `${Math.round(value * 100)}%`}</span>
      <span className="sr-only">{value === null ? "No checks" : `${Math.round(value * 100)} percent of checks passing`}</span>
    </div>
  );
}
