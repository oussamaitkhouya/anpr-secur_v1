/*
 * /evidence: reads that carry an evidence frame hash. The frame itself stays where the camera
 * worker stored it; to check one, pick the file here: it is hashed in this browser (never
 * uploaded) and the server compares the hash with the one recorded at capture, then audits it.
 */
import { useRef, useState } from "react";
import { CheckCircle2, FileLock2, FileSearch, XCircle } from "lucide-react";
import { ApiError } from "../../api/errors";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { PageHeader } from "../../components/ui/PageHeader";
import { PlateText } from "../../components/ui/PlateText";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { formatDateTime } from "../../lib/format";
import { sha256Hex, useEvidence, verifyEvidence, type Read } from "./api";

type Check = { state: "checking" } | { state: "match" | "mismatch"; computed: string } | { state: "error"; message: string };

export default function EvidencePage() {
  const evidence = useEvidence();
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<Read | null>(null);

  const pick = (r: Read) => {
    target.current = r;
    input.current?.click();
  };
  const onFile = async (file?: File) => {
    const r = target.current;
    if (!file || !r) return;
    setChecks((c) => ({ ...c, [r.detectionId]: { state: "checking" } }));
    try {
      const computed = await sha256Hex(file);
      const out = await verifyEvidence(r.detectionId, computed);
      setChecks((c) => ({ ...c, [r.detectionId]: { state: out.match ? "match" : "mismatch", computed } }));
    } catch (e) {
      setChecks((c) => ({ ...c, [r.detectionId]: { state: "error", message: e instanceof ApiError ? e.message : "Could not check the file." } }));
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <PageHeader eyebrow="Assure" title="Evidence vault"
        description="Every reported read carries the SHA-256 of its frame, fixed at capture. Check a frame file against it: a single changed pixel changes the hash. Checks are recorded in the audit log." />
      <input ref={input} type="file" accept="image/jpeg,image/*" className="sr-only" aria-label="Evidence frame file" onChange={(e) => void onFile(e.target.files?.[0])} />
      {evidence.error ? <ErrorState error={evidence.error} onRetry={() => void evidence.refetch()} />
        : !evidence.data ? <div className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 rounded-md" />)}</div>
        : !evidence.data.length ? (
          <Card className="p-6"><EmptyState title="No evidence yet">Reads reported by the camera worker appear here with their frame hash. Frames are stored by the worker in var/evidence/.</EmptyState></Card>
        ) : (
          <div className="card-surface relative overflow-x-auto rounded-lg">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                <th className="py-3 pl-4 pr-3">Captured</th><th className="px-3 py-3">Plate</th><th className="px-3 py-3">Camera</th><th className="px-3 py-3">Frame SHA-256</th><th className="px-3 py-3">Check</th>
              </tr></thead>
              <tbody>
                {evidence.data.map((r) => {
                  const check = checks[r.detectionId];
                  return (
                    <tr key={r.detectionId} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pl-4 pr-3 text-xs tabular">{formatDateTime(r.observedAt)}</td>
                      <td className="px-3 py-2.5"><PlateText value={r.plateMasked} size="sm" /></td>
                      <td className="px-3 py-2.5 text-xs">{r.cameraName}<span className="block text-muted">{r.cityName}</span></td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-muted" title={r.evidenceSha256 ?? ""}>{r.evidenceSha256?.slice(0, 20)}…<span className="block text-faint">file: {r.evidenceSha256?.slice(0, 12)}….jpg</span></td>
                      <td className="px-3 py-2.5">
                        {!check ? <Button size="sm" onClick={() => pick(r)}><FileSearch size={13} aria-hidden /> Check a file</Button>
                          : check.state === "checking" ? <span className="text-xs text-muted">Hashing…</span>
                          : check.state === "match" ? <span className="flex items-center gap-1.5 text-xs font-semibold text-ok"><CheckCircle2 size={14} aria-hidden /> Matches the capture</span>
                          : check.state === "mismatch" ? <span className="flex items-center gap-1.5 text-xs font-semibold text-danger" title={`File hash ${check.computed}`}><XCircle size={14} aria-hidden /> Does NOT match</span>
                          : check.state === "error" ? <span className="text-xs text-danger">{check.message}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="flex items-center gap-1.5 border-t border-border px-4 py-2.5 text-xs text-muted"><FileLock2 size={13} className="text-accent" aria-hidden /> The file is hashed in your browser; it is never uploaded.</p>
          </div>
        )}
    </>
  );
}
