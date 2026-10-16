import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ArrowRight, Check, Clock, FlaskConical, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { EvidenceDetail as Detail, EvidenceRecord } from "../api/types";
import { Badge } from "../components/ui/Badge";
import { Card, CardHeader, RevealGroup } from "../components/ui/Card";
import { HashText } from "../components/ui/HashText";
import { PageHeader } from "../components/ui/PageHeader";
import { PlateCrop, SceneFrame } from "../components/ui/PlateArt";
import { PlateText } from "../components/ui/PlateText";
import { LoadingBlock } from "../components/ui/Skeleton";
import { ErrorState } from "../components/ui/States";
import { canonicalJson, GENESIS, importPublicKey, linkHash, verifySignature } from "../lib/chain";
import { cn } from "../lib/cn";
import { formatDateTime, formatPercent } from "../lib/format";
import { PLATE_TYPE_LABELS } from "../lib/plate";

interface Check {
  recomputed: string;
  hashOk: boolean;
  linkOk: boolean;
  signatureOk: boolean | null;
}

export default function EvidenceDetail() {
  const { id = "" } = useParams();
  const detail = useApi((ctx) => api.getEvidenceDetail(ctx, id), [id]);
  const list = useApi((ctx) => api.getEvidence(ctx));
  const error = detail.error ?? list.error;

  return (
    <>
      <PageHeader
        eyebrow="Evidence vault"
        title={`Record ${id}`}
        description="The signed content of one capture, its place in the hash chain, and its chain of custody. Checks below run in your browser."
        actions={<Link to="/evidence" className="focus-ring inline-flex items-center gap-1.5 rounded-sm text-sm text-accent hover:underline"><ArrowLeft size={14} aria-hidden /> All evidence</Link>}
      />
      {error ? (
        <ErrorState error={error} onRetry={() => { detail.reload(); list.reload(); }} />
      ) : !detail.data || !list.data ? (
        <LoadingBlock className="rounded-lg border border-border bg-surface" label="Loading record" />
      ) : (
        <Body detail={detail.data} records={list.data.records} publicKey={list.data.publicKey} />
      )}
    </>
  );
}

function Body({ detail, records, publicKey }: { detail: Detail; records: EvidenceRecord[]; publicKey: string | null }) {
  const r = detail.record;
  const prev = records.find((x) => x.seq === r.seq - 1);
  const next = records.find((x) => x.seq === r.seq + 1);
  const [check, setCheck] = useState<Check | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const recomputed = await linkHash(r.prevHash, r.payload);
      const key = publicKey ? await importPublicKey(publicKey).catch(() => null) : null;
      const signatureOk = key && r.signature ? await verifySignature(key, r.hash, r.signature) : null;
      if (live) setCheck({ recomputed, hashOk: recomputed === r.hash, linkOk: r.prevHash === (prev?.hash ?? GENESIS), signatureOk });
    })();
    return () => {
      live = false;
    };
  }, [r, prev, publicKey]);

  const ok = check && check.hashOk && check.linkOk && check.signatureOk !== false;

  return (
    <RevealGroup className="space-y-6">
      {r.demoNote && (
        <Card tone="gold" className="flex items-start gap-3 px-6 py-4">
          <FlaskConical size={18} className="mt-0.5 shrink-0 text-gold-strong" aria-hidden />
          <p className="text-sm"><span className="font-medium text-gold-strong">Deliberately tampered demo record. </span>{r.demoNote}</p>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.25fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader
            title="Capture"
            subtitle={`${r.cameraName} · ${formatDateTime(r.payload.capturedAt)} · ${detail.condition} · ${PLATE_TYPE_LABELS[detail.plateType]}`}
            actions={<PlateText value={r.plateMasked} size="sm" />}
          />
          <div className="grid gap-4 p-6 pt-4">
            <SceneFrame
              text={r.plateMasked}
              condition={detail.condition}
              seed={detail.artSeed}
              cameraId={r.payload.cameraId}
              capturedAt={r.payload.capturedAt}
              confidence={detail.confidence}
              label="Generated placeholder of the full frame, plate masked"
            />
            <div className="grid items-center gap-4 sm:grid-cols-[1fr_auto]">
              <PlateCrop text={r.plateMasked} condition={detail.condition} seed={detail.artSeed} label="Generated placeholder of the plate crop, masked" />
              <p className="text-xs text-muted sm:max-w-44">Generated placeholders. The evidence stores a frame hash and a plate digest, not the plate text.</p>
            </div>
          </div>
        </Card>

        <Card tone={check ? (ok ? "default" : "danger") : "default"}>
          <CardHeader
            title="Integrity"
            subtitle={`Position #${r.seq} of ${records.length} in the chain`}
            actions={check ? (ok ? <Badge tone="ok" dot>Verified</Badge> : <Badge tone="danger" dot>Failed</Badge>) : <Badge>Checking…</Badge>}
          />
          <ul className="space-y-3 p-6 pt-4">
            <CheckRow label="Content matches its hash" ok={check?.hashOk} detail="SHA-256 of the previous hash and the canonical payload is recomputed." />
            <CheckRow label="Linked to the previous record" ok={check?.linkOk} detail={r.seq === 1 ? "First record: links to the genesis value." : `prevHash equals the hash of record #${r.seq - 1}.`} />
            <CheckRow
              label="Ed25519 signature valid"
              ok={check?.signatureOk ?? undefined}
              detail={check?.signatureOk === null ? "No public key or signature available in this browser." : `Signature over the stored hash, key ${r.keyId}.`}
            />
          </ul>
          {check && !check.hashOk && (
            <div className="mx-6 mb-6 space-y-2 rounded-md border border-danger bg-danger-soft p-4 text-xs">
              <p className="font-medium text-danger">Stored and recomputed hashes differ</p>
              <p className="flex flex-wrap items-center gap-2"><span className="w-20 text-muted">Stored</span><HashText value={r.hash} chars={12} /></p>
              <p className="flex flex-wrap items-center gap-2"><span className="w-20 text-muted">Recomputed</span><HashText value={check.recomputed} chars={12} /></p>
              {check.signatureOk && <p className="text-text">The signature still matches the stored hash, so the record was valid when signed and its content was changed afterwards.</p>}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Signed content" subtitle="Canonical JSON (sorted keys). This exact text is hashed." />
          <pre className="mx-6 mb-6 mt-4 overflow-x-auto rounded-md border border-border bg-bg-subtle p-4 font-mono text-[12px] leading-relaxed">
            {JSON.stringify(JSON.parse(canonicalJson(r.payload)), null, 2)}
          </pre>
          <dl className="grid gap-3 px-6 pb-6 text-sm">
            <div><dt className="text-xs text-muted">Previous hash</dt><dd><HashText value={r.prevHash} chars={12} /></dd></div>
            <div><dt className="text-xs text-muted">This hash</dt><dd><HashText value={r.hash} chars={12} /></dd></div>
            <div><dt className="text-xs text-muted">Signature</dt><dd>{r.signature ? <HashText value={r.signature} chars={12} /> : <span className="text-faint">none</span>}</dd></div>
            <div><dt className="text-xs text-muted">OCR confidence</dt><dd className="font-mono tabular">{formatPercent(detail.confidence)}</dd></div>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Chain of custody" subtitle="Who handled this capture, in order" />
          <ol className="relative space-y-5 p-6 pt-5">
            <span className="absolute bottom-8 left-[33px] top-8 w-px bg-border" aria-hidden />
            {detail.custody.map((c, i) => (
              <li key={i} className="relative flex gap-4">
                <span className="z-10 grid size-5 shrink-0 place-items-center rounded-full border border-accent bg-surface"><Clock size={11} className="text-accent" aria-hidden /></span>
                <div className="min-w-0">
                  <p className="text-sm">{c.action}</p>
                  <p className="font-mono text-[11.5px] text-muted">{c.actor} · {formatDateTime(c.at)}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="flex justify-between border-t border-border px-6 py-4 text-sm">
            {prev ? <Link to={`/evidence/${prev.id}`} className="focus-ring inline-flex items-center gap-1 rounded-xs text-accent hover:underline"><ArrowLeft size={14} aria-hidden /> {prev.id}</Link> : <span />}
            {next ? <Link to={`/evidence/${next.id}`} className="focus-ring inline-flex items-center gap-1 rounded-xs text-accent hover:underline">{next.id} <ArrowRight size={14} aria-hidden /></Link> : <span />}
          </div>
        </Card>
      </div>
    </RevealGroup>
  );
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean | undefined; detail: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full", ok === undefined ? "bg-bg-subtle text-faint" : ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger")}>
        {ok === undefined ? <ShieldCheck size={13} aria-hidden /> : ok ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
      </span>
      <div>
        <p className="text-sm font-medium">{label}{ok === false && <ShieldAlert size={13} className="ml-1.5 inline text-danger" aria-hidden />}</p>
        <p className="text-xs text-muted">{detail}</p>
      </div>
    </li>
  );
}
