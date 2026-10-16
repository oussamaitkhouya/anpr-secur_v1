/*
 * /models: the deployed models' own training scores (from their artifacts) and live read quality
 * (from real detections). Training scores are labelled for what they are; a sanity-check OCR
 * checkpoint is flagged so its 100% is not mistaken for field accuracy.
 */
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, Cpu, Info, ScanLine, Type } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { Card, CardHeader, RevealGroup } from "../../components/ui/Card";
import { ChartTooltip } from "../../components/charts/ChartTooltip";
import { PageHeader } from "../../components/ui/PageHeader";
import { Skeleton } from "../../components/ui/Skeleton";
import { ErrorState } from "../../components/ui/States";
import { formatPercent } from "../../lib/format";
import { useModels, type LiveQuality } from "./api";

const AXIS = { fill: "var(--text-faint)", fontSize: 11, fontFamily: "var(--font-mono)" };
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatPercent(v, 1));

export default function ModelsPage() {
  const models = useModels();
  const d = models.data?.detector;
  const o = models.data?.ocr;
  return (
    <>
      <PageHeader eyebrow="System" title="Model performance" description={models.data?.note ?? "Training scores of the deployed models and the quality of live reads."} />
      {models.error ? <ErrorState error={models.error} onRetry={() => void models.refetch()} />
        : !models.data || !d ? <div className="grid gap-5 lg:grid-cols-2"><Skeleton className="h-80 rounded-lg" /><Skeleton className="h-80 rounded-lg" /></div>
        : (
          <RevealGroup className="space-y-6">
            <div className="grid gap-5 lg:grid-cols-2">
              <Card>
                <CardHeader title={<span className="flex items-center gap-2"><ScanLine size={17} className="text-accent" aria-hidden /> Plate detector (YOLO)</span>}
                  subtitle={<span className="font-mono text-xs">{d.weights}</span>} actions={<Badge tone={d.available ? "ok" : "danger"} dot>{d.available ? "loaded file found" : "weights missing"}</Badge>} />
                <div className="space-y-4 p-6 pt-4">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Metric label="mAP@50" value={pct(d.final?.map50)} />
                    <Metric label="mAP@50-95" value={pct(d.final?.map5095)} />
                    <Metric label="Precision" value={pct(d.final?.precision)} />
                    <Metric label="Recall" value={pct(d.final?.recall)} />
                  </div>
                  <p className="text-xs text-muted">
                    Run <span className="font-mono">{d.run}</span> · epoch {d.final?.epoch ?? "—"}{d.plannedEpochs ? ` of ${d.plannedEpochs}` : ""}
                    {d.baseModel ? ` · from ${d.baseModel}` : ""}{d.imageSize ? ` · ${d.imageSize}px` : ""}
                  </p>
                  {d.plannedEpochs && d.final && d.final.epoch < d.plannedEpochs && (
                    <p className="flex items-start gap-2 rounded-sm bg-warn-soft px-3 py-2 text-xs text-warn"><AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />Training stopped at epoch {d.final.epoch} of {d.plannedEpochs} planned.</p>
                  )}
                  {d.epochs.length > 1 && (
                    <div className="h-48" role="img" aria-label={`mAP@50 over ${d.epochs.length} epochs, last ${pct(d.final?.map50)}`}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={d.epochs} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                          <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="2 6" />
                          <XAxis dataKey="epoch" tick={AXIS} axisLine={false} tickLine={false} />
                          <YAxis domain={[0, 1]} tick={AXIS} axisLine={false} tickLine={false} tickFormatter={(v) => `${Math.round(v * 100)}`} />
                          <Tooltip content={({ active, payload, label }) => (
                            <ChartTooltip active={active} title={`Epoch ${label}`} rows={(payload ?? []).map((p) => ({ label: String(p.name), value: pct(Number(p.value)), color: String(p.color) }))} />
                          )} />
                          <Line type="monotone" dataKey="map50" name="mAP@50" stroke="var(--chart-1)" strokeWidth={2.5} dot={false} />
                          <Line type="monotone" dataKey="map5095" name="mAP@50-95" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </Card>

              <Card tone={o?.sanityCheckOnly ? "gold" : "default"}>
                <CardHeader title={<span className="flex items-center gap-2"><Type size={17} className="text-accent" aria-hidden /> Plate reader (CRNN OCR)</span>}
                  subtitle={o ? <span className="font-mono text-xs">{o.weights}</span> : "ANPR_OCR_WEIGHTS is not set"}
                  actions={o && <Badge tone={o.available ? "ok" : "danger"} dot>{o.available ? "loaded file found" : "weights missing"}</Badge>} />
                <div className="space-y-4 p-6 pt-4">
                  {!o ? <p className="text-sm text-muted">Without OCR weights the worker finds plate boxes but reads no text, so nothing is matched.</p> : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <Metric label="Plate accuracy" value={pct(o.metrics?.plate_acc)} />
                        <Metric label="Character accuracy" value={pct(o.metrics?.char_acc)} />
                      </div>
                      <p className="text-xs text-muted">Epoch {o.epoch ?? "—"}{o.metrics?.val_loss !== undefined ? ` · validation loss ${o.metrics.val_loss}` : ""}</p>
                      {o.sanityCheckOnly && (
                        <p className="flex items-start gap-2 rounded-sm border border-gold bg-gold-soft px-3 py-2.5 text-sm text-gold-strong">
                          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                          <span>This is the <strong>overfit sanity-check</strong> checkpoint: it memorised a tiny set to prove the training loop works. Its scores do not measure real plate reading. Train the OCR on the full dataset before relying on reads.</span>
                        </p>
                      )}
                    </>
                  )}
                </div>
              </Card>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <LiveCard title="Live reads · last 24 hours" q={models.data.live.last24h} />
              <LiveCard title="Live reads · last 7 days" q={models.data.live.last7d} />
            </div>
            <p className="flex items-start gap-2 text-xs text-muted"><Info size={13} className="mt-px shrink-0" aria-hidden />"Confirmed by reviewers" is approved ÷ (approved + rejected) alerts: the closest measure of field precision without labelled ground truth.</p>
          </RevealGroup>
        )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-subtle/50 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="mt-1 font-display text-xl font-semibold tabular">{value}</p>
    </div>
  );
}

function LiveCard({ title, q }: { title: string; q: LiveQuality }) {
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Cpu size={16} className="text-accent" aria-hidden />{title}</span>} subtitle={`${q.reads} reads in your cities`} />
      <div className="grid grid-cols-2 gap-3 p-6 pt-4 sm:grid-cols-4">
        <Metric label="Valid plates" value={pct(q.validShare)} />
        <Metric label="Mean confidence" value={pct(q.meanConfidence)} />
        <Metric label="Low confidence" value={String(q.lowConfidenceReads)} />
        <Metric label="Confirmed by reviewers" value={pct(q.confirmedShare)} />
      </div>
    </Card>
  );
}
