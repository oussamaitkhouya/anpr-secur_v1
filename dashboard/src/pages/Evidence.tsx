import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { createColumnHelper } from "@tanstack/react-table";
import { KeyRound, Link2, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { api } from "../api/client";
import { useApi, useRequestContext } from "../api/useApi";
import type { EvidenceRecord } from "../api/types";
import { useSession } from "../app/session";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardHeader, RevealGroup } from "../components/ui/Card";
import { DataTable } from "../components/ui/DataTable";
import { HashText } from "../components/ui/HashText";
import { PageHeader } from "../components/ui/PageHeader";
import { PlateText } from "../components/ui/PlateText";
import { LoadingBlock } from "../components/ui/Skeleton";
import { ErrorState } from "../components/ui/States";
import { useToast } from "../components/ui/toast";
import { verifyChain, type ChainResult, type LinkResult } from "../lib/chain";
import { cn } from "../lib/cn";
import { formatDateTime, formatNumber } from "../lib/format";

type LinkView = "unchecked" | "checking" | "ok" | "broken";

export default function Evidence() {
  const evidence = useApi((ctx) => api.getEvidence(ctx));
  const ctx = useRequestContext();
  const { can } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [checkedUpTo, setCheckedUpTo] = useState(0); // number of links revealed so far
  const [result, setResult] = useState<ChainResult | null>(null);
  const [running, setRunning] = useState(false);
  const cancel = useRef(false);

  const records = useMemo(() => [...(evidence.data?.records ?? [])].sort((a, b) => a.seq - b.seq), [evidence.data]);
  const bySeq = useMemo(() => new Map(result?.links.map((l) => [l.seq, l]) ?? []), [result]);

  const viewOf = (seq: number): LinkView => {
    if (!result) return running && seq === checkedUpTo + 1 ? "checking" : "unchecked";
    const index = records.findIndex((r) => r.seq === seq);
    if (index >= checkedUpTo) return index === checkedUpTo && running ? "checking" : "unchecked";
    return bySeq.get(seq)?.ok ? "ok" : "broken";
  };

  const verify = async () => {
    if (!evidence.data) return;
    setRunning(true);
    setResult(null);
    setCheckedUpTo(0);
    cancel.current = false;
    // The whole chain is verified for real first; the animation then walks through the results.
    const res = await verifyChain(records, evidence.data.publicKey);
    setResult(res);
    const step = reduce ? 0 : Math.max(25, Math.min(90, 2400 / records.length));
    for (let i = 1; i <= records.length; i++) {
      if (cancel.current) break;
      setCheckedUpTo(i);
      if (step) await new Promise((r) => setTimeout(r, step));
    }
    setRunning(false);
    try {
      const entry = await api.recordChainVerification(ctx, { checked: res.links.length, broken: res.broken });
      toast(
        res.ok
          ? { tone: "success", title: "Evidence chain verified", body: `${res.links.length} records intact. Logged as ${entry.id}.` }
          : { tone: "error", title: "Tamper detected", body: `${res.broken} record(s) failed verification. Logged as ${entry.id}.` },
      );
    } catch (err) {
      toast({ tone: "error", title: "Verification not logged", body: err instanceof Error ? err.message : "" });
    }
  };

  const done = result && !running;
  const head = records[records.length - 1];

  const columns = useMemo(() => {
    const col = createColumnHelper<EvidenceRecord>();
    return [
      col.accessor("seq", { header: "#", cell: (c) => <span className="font-mono text-[12px] tabular text-muted">{c.getValue()}</span> }),
      col.accessor("id", { header: "Record", cell: (c) => <span className="font-mono text-[12.5px]">{c.getValue()}</span> }),
      col.accessor((r) => r.payload.capturedAt, { id: "capturedAt", header: "Captured", cell: (c) => <span className="whitespace-nowrap font-mono text-[12px] tabular text-muted">{formatDateTime(c.getValue())}</span> }),
      col.accessor("cameraName", { header: "Camera", cell: (c) => <span className="whitespace-nowrap">{c.getValue()}</span> }),
      col.accessor("plateMasked", { header: "Plate", enableSorting: false, cell: (c) => <PlateText value={c.getValue()} size="sm" /> }),
      col.accessor("hash", { header: "SHA-256", enableSorting: false, cell: (c) => <HashText value={c.getValue()} chars={6} /> }),
      col.display({
        id: "status",
        header: "Verification",
        cell: ({ row: { original: r } }) => <LinkStatus view={viewOf(r.seq)} link={bySeq.get(r.seq)} hasSignature={!!r.signature} />,
      }),
    ];
    // viewOf reads checkedUpTo/result/running; listing them keeps the cells in sync
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySeq, checkedUpTo, running, result, records]);

  return (
    <>
      <PageHeader
        eyebrow="Assure"
        title="Evidence vault"
        description="Every capture is hashed into a chain and signed with Ed25519. Verification recomputes each hash and checks each signature here in your browser, using only the public key."
        actions={
          can("evidence:verify") ? (
            <Button variant="primary" onClick={verify} loading={running} disabled={!evidence.data}>
              <ShieldCheck size={16} aria-hidden /> Verify chain
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted"><ShieldQuestion size={16} aria-hidden /> Verification needs the Admin or Auditor role</span>
          )
        }
      />

      {evidence.error ? (
        <ErrorState error={evidence.error} onRetry={evidence.reload} />
      ) : !evidence.data ? (
        <LoadingBlock className="rounded-lg border border-border bg-surface" label="Loading evidence" />
      ) : (
        <RevealGroup className="space-y-6">
          <AnimatePresence>
            {done && (
              <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} role="status">
                <VerdictBanner result={result} records={records} onOpen={(id) => navigate(`/evidence/${id}`)} />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="min-w-0">
              <CardHeader title="Hash chain" subtitle={`${formatNumber(records.length)} signed records, oldest on the left`} />
              <ChainStrip records={records} viewOf={viewOf} onOpen={(id) => navigate(`/evidence/${id}`)} />
            </Card>
            <Card>
              <CardHeader title="Signing key" subtitle="Public half only. The private key never leaves the signer." />
              <dl className="space-y-3 p-6 pt-4 text-sm">
                <div><dt className="text-xs text-muted">Algorithm</dt><dd className="flex items-center gap-2"><KeyRound size={14} className="text-accent" aria-hidden /> {evidence.data.algorithm}</dd></div>
                <div><dt className="text-xs text-muted">Key ID</dt><dd className="font-mono text-[12.5px]">{evidence.data.keyId}</dd></div>
                <div>
                  <dt className="text-xs text-muted">Public key (raw, base64)</dt>
                  <dd>{evidence.data.publicKey ? <HashText value={evidence.data.publicKey} chars={10} /> : <span className="text-warn">This browser lacks Ed25519: signatures cannot be checked here.</span>}</dd>
                </div>
                <div><dt className="text-xs text-muted">Chain head</dt><dd>{head ? <HashText value={head.hash} chars={10} /> : "—"}</dd></div>
              </dl>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <DataTable
              label="Evidence records"
              data={records}
              columns={columns}
              getRowId={(r) => r.id}
              onRowClick={(r) => navigate(`/evidence/${r.id}`)}
              initialSort={[{ id: "seq", desc: true }]}
              pageSize={15}
            />
          </Card>
        </RevealGroup>
      )}
    </>
  );
}

function LinkStatus({ view, link, hasSignature }: { view: LinkView; link?: LinkResult; hasSignature: boolean }) {
  if (view === "unchecked") return <span className="text-xs text-faint">Not checked</span>;
  if (view === "checking") return <span className="flex items-center gap-1.5 text-xs text-accent"><Loader2 size={12} className="animate-spin" aria-hidden /> Checking</span>;
  if (view === "ok") {
    return <Badge tone="ok" dot>{hasSignature && link?.signatureOk ? "Hash + signature valid" : "Hash valid"}</Badge>;
  }
  const why = !link ? "Failed" : !link.hashOk ? "Content edited" : !link.linkOk ? "Broken link" : "Bad signature";
  return <Badge tone="danger" dot>{why}</Badge>;
}

const NODE_TONE: Record<LinkView, string> = {
  unchecked: "border-border-strong bg-surface-raised text-muted",
  checking: "border-accent bg-accent-soft text-accent",
  ok: "border-ok bg-ok-soft text-ok",
  broken: "border-danger bg-danger text-accent-fg",
};

function ChainStrip({ records, viewOf, onOpen }: { records: EvidenceRecord[]; viewOf: (seq: number) => LinkView; onOpen: (id: string) => void }) {
  return (
    <div className="overflow-x-auto px-6 pb-6 pt-5">
      <ol className="flex min-w-max items-center" aria-label="Evidence hash chain">
        {records.map((r, i) => {
          const view = viewOf(r.seq);
          return (
            <li key={r.id} className="flex items-center">
              {i > 0 && (
                <span className={cn("h-0.5 w-5 transition-colors duration-300", view === "ok" || view === "broken" ? (view === "broken" ? "bg-danger" : "bg-ok") : "bg-border-strong")} aria-hidden />
              )}
              <motion.button
                type="button"
                onClick={() => onOpen(r.id)}
                animate={view === "checking" ? { scale: 1.15 } : view === "broken" ? { scale: [1, 1.25, 1.1] } : { scale: 1 }}
                transition={{ duration: 0.25 }}
                className={cn("focus-ring grid size-9 shrink-0 place-items-center rounded-sm border font-mono text-[10px] tabular transition-colors duration-300", NODE_TONE[view])}
                aria-label={`Record ${r.seq}, ${view === "broken" ? "failed verification" : view === "ok" ? "verified" : "not checked yet"}`}
                title={`${r.id} · ${r.hash.slice(0, 12)}…`}
              >
                {view === "broken" ? <ShieldAlert size={14} aria-hidden /> : r.seq}
              </motion.button>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 flex items-center gap-2 text-xs text-muted">
        <Link2 size={13} aria-hidden /> Each record stores the hash of the one before it. Changing any record breaks its own hash; deleting one breaks the next link.
      </p>
    </div>
  );
}

function VerdictBanner({ result, records, onOpen }: { result: ChainResult; records: EvidenceRecord[]; onOpen: (id: string) => void }) {
  const signed = result.links.filter((l) => l.signatureOk).length;
  if (result.ok) {
    return (
      <div className="flex items-center gap-4 rounded-lg border border-ok bg-ok-soft px-6 py-5">
        <ShieldCheck size={28} className="shrink-0 text-ok" aria-hidden />
        <div>
          <p className="font-display text-xl text-ok">Chain verified</p>
          <p className="text-sm text-text">{result.links.length} records: every hash recomputes, every link points at its predecessor, {signed} signatures valid.</p>
        </div>
      </div>
    );
  }
  const broken = result.links.filter((l) => !l.ok);
  const first = records.find((r) => r.seq === result.firstBreakSeq);
  const firstLink = broken[0];
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-danger bg-danger-soft px-6 py-5">
      <ShieldAlert size={28} className="shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-display text-xl text-danger">Tamper detected</p>
        <p className="text-sm text-text">
          {broken.length} of {result.links.length} records failed. First failure: record #{result.firstBreakSeq}
          {firstLink && !firstLink.hashOk && firstLink.signatureOk
            ? ": its content no longer matches its hash, while the signature over the original hash is still valid. The record was edited after it was signed."
            : "."}
        </p>
      </div>
      {first && <Button variant="danger" onClick={() => onOpen(first.id)}>Inspect {first.id}</Button>}
    </div>
  );
}
