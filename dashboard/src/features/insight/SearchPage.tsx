/*
 * /search: find reads by plate fragment. Results are masked by the server; each search is
 * audited. Revealing one plate needs a written reason (analysts), is audited, and the revealed
 * plate is kept only in this page's memory until you leave or hide it.
 */
import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, Search as SearchIcon, ShieldCheck, Siren } from "lucide-react";
import { ApiError } from "../../api/errors";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { JustificationDialog } from "../../components/ui/JustificationDialog";
import { PageHeader } from "../../components/ui/PageHeader";
import { PlateText } from "../../components/ui/PlateText";
import { EmptyState } from "../../components/ui/States";
import { useToast } from "../../components/ui/toast";
import { formatDateTime, formatPercent } from "../../lib/format";
import { useCameras } from "../cameras/hooks";
import { revealPlate, searchPlates, type Read } from "./api";

const field = "focus-ring h-10 rounded-sm border border-border bg-surface px-3 text-sm";

export default function SearchPage() {
  const { can } = useSession();
  const cameras = useCameras();
  const toast = useToast();
  const [form, setForm] = useState({ q: "", since: "", until: "", cameraId: "" });
  const [results, setResults] = useState<Read[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealing, setRevealing] = useState<Read | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const digits = form.q.replace(/[\s|\-_/.]/g, "");
    if (digits.length < 3) return setError("Type at least 3 plate characters.");
    setBusy(true);
    setError(null);
    setRevealed({});
    try {
      setResults(await searchPlates({
        q: form.q, cameraId: form.cameraId || undefined,
        since: form.since ? new Date(`${form.since}T00:00:00`).toISOString() : undefined,
        until: form.until ? new Date(`${form.until}T23:59:59`).toISOString() : undefined,
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The search failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Operate" title="Plate search"
        description="Find plate reads in your cities. Results are masked; every search is recorded in the audit log, and revealing a full plate requires a reason." />
      <Card className="mb-6 p-5">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3" noValidate>
          <label className="min-w-56 flex-1"><span className="mb-1.5 block text-sm font-medium">Plate characters</span>
            <span className="relative block"><SearchIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
              <input value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} placeholder="e.g. 2345 or 12345 أ 6" dir="ltr" className={`${field} w-full pl-9 font-mono`} autoFocus /></span></label>
          <label><span className="mb-1.5 block text-sm font-medium">From</span><input type="date" value={form.since} onChange={(e) => setForm({ ...form, since: e.target.value })} className={field} /></label>
          <label><span className="mb-1.5 block text-sm font-medium">To</span><input type="date" value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} className={field} /></label>
          <label><span className="mb-1.5 block text-sm font-medium">Camera</span>
            <select value={form.cameraId} onChange={(e) => setForm({ ...form, cameraId: e.target.value })} className={field}>
              <option value="">All cameras</option>{(cameras.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          <Button type="submit" variant="primary" loading={busy}><SearchIcon size={15} aria-hidden /> Search</Button>
        </form>
        {error && <p role="alert" className="mt-3 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      </Card>

      {results === null ? (
        <Card className="p-6"><EmptyState title="Search plate reads">Type part of a plate. Matching reads in your cities appear here, masked.</EmptyState></Card>
      ) : !results.length ? (
        <Card className="p-6"><EmptyState title="No read matches">Nothing in your cities matches these characters and filters.</EmptyState></Card>
      ) : (
        <div className="card-surface relative overflow-x-auto rounded-lg">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              <th className="py-3 pl-4 pr-3">Plate</th><th className="px-3 py-3">Seen</th><th className="px-3 py-3">Camera</th><th className="px-3 py-3">Confidence</th><th className="px-3 py-3">Vehicle</th><th className="px-3 py-3" />
            </tr></thead>
            <motion.tbody initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.03 } } }}>
              {results.map((r) => (
                <motion.tr key={r.detectionId} variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }} className="border-b border-border/60 last:border-0">
                  <td className="py-2.5 pl-4 pr-3">
                    <span className="flex items-center gap-2">
                      <PlateText value={revealed[r.detectionId] ?? r.plateMasked} size="sm" />
                      {revealed[r.detectionId] && <Badge tone="gold" className="h-5 px-2 text-[10px]">revealed · audited</Badge>}
                      {r.alerts > 0 && <Siren size={13} className="text-gold-strong" aria-label="Watchlist match" />}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs tabular">{formatDateTime(r.observedAt)}</td>
                  <td className="px-3 py-2.5 text-xs">{r.cameraName}<span className="block text-muted">{r.cityName}</span></td>
                  <td className="px-3 py-2.5 text-xs tabular">{formatPercent(r.plateConfidence, 0)}{!r.plateValid && <span className="block text-muted">not a valid plate</span>}</td>
                  <td className="px-3 py-2.5 text-xs text-muted">{[r.observedColor, r.observedMake, r.observedModel].filter(Boolean).join(" ") || "—"}</td>
                  <td className="px-3 py-2.5 text-right">
                    {revealed[r.detectionId] ? (
                      <Button size="sm" variant="ghost" onClick={() => setRevealed((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== r.detectionId)))}><EyeOff size={13} aria-hidden /> Hide</Button>
                    ) : can("plates:reveal") && <Button size="sm" onClick={() => setRevealing(r)}><Eye size={13} aria-hidden /> Reveal</Button>}
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
          <p className="flex items-center gap-1.5 border-t border-border px-4 py-2.5 text-xs text-muted"><ShieldCheck size={13} className="text-accent" aria-hidden /> This search was recorded in the audit log.</p>
        </div>
      )}

      <JustificationDialog
        open={!!revealing} onClose={() => setRevealing(null)}
        title="Reveal the full plate" description="State why you need it. Your reason, your name and the read are written to the signed audit log."
        label="Reason" placeholder="e.g. Checking the read behind alert on case CASE-2026-114." confirmLabel="Reveal" variant="gold" minLength={20}
        onSubmit={async (reason) => {
          const r = await revealPlate(revealing!.detectionId, reason);
          setRevealed((x) => ({ ...x, [r.detectionId]: r.plateCanonical ?? r.plateRaw }));
          toast({ tone: "info", title: "Plate revealed", body: "Recorded in the audit log." });
        }}
      />
    </>
  );
}
