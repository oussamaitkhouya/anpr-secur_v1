/*
 * "Clear history": deletes plate reads, their alerts and evidence frames through
 * POST /admin/detections/purge. Admins only (server permission detections.purge). Alerts still
 * waiting for a decision are kept unless the admin ticks the box: a person decides every match.
 * The audit log is never cleared; the purge itself is written to it with the justification.
 */
import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eraser, ScrollText } from "lucide-react";
import { ApiError } from "../../api/errors";
import { v1 } from "../../api/v1";
import { useSession } from "../../app/session";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { MIN_JUSTIFICATION } from "./api";

interface PurgeResult { detections: number; alerts: number; evidenceFiles: number; keptPending: number }

export function ClearHistoryButton({ size = "md" }: { size?: "sm" | "md" }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  if (!can("history:clear")) return null;
  return (
    <>
      <Button size={size} variant="danger" onClick={() => setOpen(true)}><Eraser size={15} aria-hidden /> Clear history</Button>
      <ClearHistoryDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function ClearHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const id = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const [why, setWhy] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setWhy(""); setPending(false); setError(null); onClose(); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (why.trim().length < MIN_JUSTIFICATION) return setError(`Write a justification of at least ${MIN_JUSTIFICATION} characters.`);
    setBusy(true);
    try {
      const r = await v1.call<PurgeResult>("POST", "/admin/detections/purge", { justification: why.trim(), includePending: pending });
      void qc.invalidateQueries(); // every page that shows reads, alerts or counts refreshes
      toast({ tone: "success", title: "Detection history cleared",
        body: `${r.detections} reads, ${r.alerts} alerts and ${r.evidenceFiles} frames removed${r.keptPending ? `; ${r.keptPending} pending alerts kept` : ""}. Recorded in the audit log.` });
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The history could not be cleared.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} title="Clear the detection history?"
      description="Deletes plate reads, the alerts raised from them and their evidence frames. This cannot be undone.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <ul className="space-y-1.5 rounded-md border border-border bg-bg-subtle/50 px-4 py-3 text-sm text-muted">
          <li>Watchlists, cameras and users are not touched.</li>
          <li className="flex items-start gap-1.5"><ScrollText size={14} className="mt-0.5 shrink-0" aria-hidden />The audit log is never cleared; this action is added to it with your justification.</li>
        </ul>
        <label className={cn("flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3 text-sm transition-colors", pending ? "border-danger bg-danger-soft" : "border-border")}>
          <input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} className="mt-0.5 size-4 accent-[var(--danger)]" />
          <span>
            <span className="font-medium">Also delete alerts still waiting for review</span>
            <span className="block text-xs text-muted">Off by default: a person decides every watchlist match. Tick only to reset test data.</span>
          </span>
        </label>
        <div>
          <label htmlFor={`${id}-why`} className="mb-1.5 block text-sm font-medium">Justification</label>
          <textarea id={`${id}-why`} value={why} onChange={(e) => { setWhy(e.target.value); setError(null); }} rows={3} maxLength={1000}
            placeholder="e.g. Resetting the test data after the webcam demo session."
            className="focus-ring w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm" />
          <p className="mt-1 text-xs text-muted tabular">{why.trim().length}/{MIN_JUSTIFICATION} characters minimum</p>
        </div>
        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy}><Eraser size={15} aria-hidden /> Clear history</Button>
        </div>
      </form>
    </Dialog>
  );
}
