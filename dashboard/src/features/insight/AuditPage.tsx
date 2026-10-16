/*
 * /audit: the signed, hash-chained audit log. Filter, verify the whole chain on the server, page
 * back through older entries, and export what is shown to CSV (the export itself is recorded in
 * the log; cells are made safe to open in a spreadsheet).
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Download, Link2, ShieldAlert, ShieldCheck } from "lucide-react";
import { ApiError } from "../../api/errors";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { csvCell, fetchAudit, recordExport, verifyAudit, type AuditRow, type Integrity } from "./api";

const GROUPS: [string, string][] = [
  ["", "All actions"], ["auth.", "Sign-in and sessions"], ["alert.", "Alert decisions"], ["plates.", "Plate search and reveal"],
  ["camera.", "Cameras"], ["city.", "Cities"], ["watchlist.", "Watchlists"], ["user.", "Accounts"], ["evidence.", "Evidence checks"], ["audit.", "Audit exports"],
];
const field = "focus-ring h-10 rounded-sm border border-border bg-surface px-3 text-sm";

function tone(action: string): "danger" | "gold" | "accent" | "neutral" | "ok" {
  if (/failure|blocked|lockout|reuse|MISMATCH/.test(action)) return "danger";
  if (action.startsWith("alert.") || action === "plates.reveal") return "gold";
  if (action.startsWith("auth.")) return "neutral";
  if (action.endsWith(".create") || action.endsWith(".add")) return "ok";
  return "accent";
}

export default function AuditPage() {
  const { can } = useSession();
  const toast = useToast();
  const [filters, setFilters] = useState({ action: "", actorId: "", since: "", until: "" });
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(true);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [verifying, setVerifying] = useState(false);

  const params = (beforeSeq?: number) => ({
    action: filters.action || undefined, actorId: filters.actorId.trim() || undefined, beforeSeq,
    since: filters.since ? new Date(`${filters.since}T00:00:00`).toISOString() : undefined,
    until: filters.until ? new Date(`${filters.until}T23:59:59`).toISOString() : undefined,
  });

  const load = async (append = false) => {
    setError(null);
    try {
      const page = await fetchAudit(params(append && rows?.length ? rows[rows.length - 1].seq : undefined));
      setRows((r) => (append && r ? [...r, ...page] : page));
      setMore(page.length === 200);
    } catch (e) {
      setError(e);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the filters change
  useEffect(() => { setRows(null); void load(); }, [filters.action, filters.actorId, filters.since, filters.until]);

  const verify = async () => {
    setVerifying(true);
    try {
      setIntegrity(await verifyAudit());
    } catch (e) {
      toast({ tone: "error", title: "Verification failed to run", body: e instanceof ApiError ? e.message : undefined });
    } finally {
      setVerifying(false);
    }
  };

  const exportCsv = async () => {
    if (!rows?.length) return;
    const head = ["seq", "time", "actor_role", "actor_id", "action", "target_type", "target_id", "justification", "ip", "prev_hash", "hash", "signature"];
    const body = rows.map((r) => [r.seq, r.ts, r.actorRole, r.actorId, r.action, r.targetType, r.targetId, r.justification, r.ip, r.prevHash, r.hash, r.signature].map(csvCell).join(","));
    const desc = Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
    try {
      await recordExport(rows.length, desc);
    } catch (e) {
      return toast({ tone: "error", title: "Export not recorded, so not downloaded", body: e instanceof ApiError ? e.message : undefined });
    }
    const url = URL.createObjectURL(new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `audit-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
    toast({ tone: "success", title: `${rows.length} entries exported`, body: "The export is recorded in the audit log." });
  };

  return (
    <>
      <PageHeader eyebrow="Assure" title="Audit log"
        description="Every action, in order, each entry chained to the previous by SHA-256 and signed with Ed25519. Rewriting history breaks the chain, and verification shows where."
        actions={
          <>
            {can("audit:export") && <Button onClick={() => void exportCsv()} disabled={!rows?.length}><Download size={15} aria-hidden /> Export CSV</Button>}
            <Button variant="primary" onClick={() => void verify()} loading={verifying}><ShieldCheck size={15} aria-hidden /> Verify chain</Button>
          </>
        } />
      {integrity && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} role="status"
          className={cn("mb-5 flex items-start gap-3 rounded-md border px-4 py-3 text-sm", integrity.ok ? "border-ok/40 bg-ok-soft text-ok" : "border-danger bg-danger-soft text-danger")}>
          {integrity.ok ? <ShieldCheck size={18} className="mt-px shrink-0" aria-hidden /> : <ShieldAlert size={18} className="mt-px shrink-0" aria-hidden />}
          {integrity.ok ? <span><strong>Chain intact.</strong> All {integrity.entries} entries verified: hash links and signatures.</span>
            : <span><strong>Tampering detected</strong> at entry #{integrity.firstBadSeq}: {integrity.reason}.</span>}
        </motion.div>
      )}
      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label><span className="mb-1.5 block text-xs font-medium text-muted">Action</span>
            <select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} className={field}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label><span className="mb-1.5 block text-xs font-medium text-muted">Actor id</span>
            <input value={filters.actorId} onChange={(e) => setFilters({ ...filters, actorId: e.target.value })} placeholder="user id or service:detections" className={`${field} w-72 font-mono`} /></label>
          <label><span className="mb-1.5 block text-xs font-medium text-muted">From</span><input type="date" value={filters.since} onChange={(e) => setFilters({ ...filters, since: e.target.value })} className={field} /></label>
          <label><span className="mb-1.5 block text-xs font-medium text-muted">To</span><input type="date" value={filters.until} onChange={(e) => setFilters({ ...filters, until: e.target.value })} className={field} /></label>
        </div>
      </Card>
      {error ? <ErrorState error={error} onRetry={() => void load()} />
        : !rows ? <div className="space-y-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-11 rounded-md" />)}</div>
        : !rows.length ? <Card className="p-6"><EmptyState title="No entries">Nothing matches these filters.</EmptyState></Card>
        : (
          <div className="card-surface relative overflow-x-auto rounded-lg">
            <table className="w-full min-w-[900px] text-sm">
              <thead><tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                <th className="py-3 pl-4 pr-3">#</th><th className="px-3 py-3">Time</th><th className="px-3 py-3">Actor</th><th className="px-3 py-3">Action</th><th className="px-3 py-3">Target</th><th className="px-3 py-3">Details</th><th className="px-3 py-3">Hash</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.seq} className="border-b border-border/60 align-top last:border-0 hover:bg-bg-subtle/40">
                    <td className="py-2.5 pl-4 pr-3 font-mono text-xs tabular">{r.seq}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular">{formatDateTime(r.ts)}</td>
                    <td className="px-3 py-2.5 text-xs"><span className="font-medium">{r.actorRole}</span><span className="block max-w-40 truncate font-mono text-[11px] text-muted" title={r.actorId}>{r.actorId}</span><span className="block font-mono text-[11px] text-faint">{r.ip}</span></td>
                    <td className="px-3 py-2.5"><Badge tone={tone(r.action)} className="font-mono text-[11px]">{r.action}</Badge></td>
                    <td className="px-3 py-2.5 text-xs">{r.targetType}<span className="block max-w-36 truncate font-mono text-[11px] text-muted" title={r.targetId ?? ""}>{r.targetId ?? ""}</span></td>
                    <td className="max-w-sm px-3 py-2.5 text-xs text-muted">{r.justification ?? "—"}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-faint" title={`hash ${r.hash}\nprev ${r.prevHash}\nsignature ${r.signature}`}><span className="flex items-center gap-1"><Link2 size={11} aria-hidden />{r.hash.slice(0, 10)}…</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {more && <div className="border-t border-border p-3 text-center"><Button size="sm" onClick={() => void load(true)}>Load older entries</Button></div>}
          </div>
        )}
    </>
  );
}
