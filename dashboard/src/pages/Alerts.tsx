import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle, ArrowUpRight, Check, CheckCircle2, FileLock2, Flag, ScrollText, ShieldQuestion, UserCheck, X,
} from "lucide-react";
import { api } from "../api/client";
import { useApi, useRequestContext } from "../api/useApi";
import type { Alert, ReviewAction } from "../api/types";
import { MIN_JUSTIFICATION_LENGTH } from "../lib/review";
import { useSession } from "../app/session";
import { AlertCard } from "../components/ui/AlertCard";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardHeader, RevealGroup } from "../components/ui/Card";
import { ConfidenceBars, LOW_CONFIDENCE } from "../components/ui/ConfidenceBars";
import { JustificationDialog } from "../components/ui/JustificationDialog";
import { LiveDot } from "../components/ui/LiveDot";
import { PageHeader } from "../components/ui/PageHeader";
import { PlateCrop, SceneFrame } from "../components/ui/PlateArt";
import { PlateText } from "../components/ui/PlateText";
import { LoadingBlock } from "../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../components/ui/States";
import { useToast } from "../components/ui/toast";
import { ALERT_STATUS, PRIORITY_TONE } from "../components/ui/tones";
import { cn } from "../lib/cn";
import { formatDateTime, formatPercent, relativeTime } from "../lib/format";
import { PLATE_TYPE_LABELS } from "../lib/plate";
import { priorityOf, REASON_LABELS } from "../lib/watchlist";

type Filter = "pending" | "decided" | "all";

const ACTIONS: Record<ReviewAction, {
  label: string;
  icon: typeof Check;
  variant: "primary" | "danger" | "gold";
  title: string;
  description: string;
  placeholder: string;
  toast: string;
}> = {
  approve: {
    label: "Confirm match",
    icon: Check,
    variant: "primary",
    title: "Confirm this watchlist match",
    description: "You confirm that the plate in the image is the listed vehicle. Downstream procedures start only after this.",
    placeholder: "e.g. All characters legible on the crop; letter and region match the entry.",
    toast: "Match confirmed",
  },
  reject: {
    label: "Reject",
    icon: X,
    variant: "danger",
    title: "Reject as a false match",
    description: "The OCR text or the match is wrong. No action is taken on the vehicle.",
    placeholder: "e.g. The low-confidence digit is a 3 on the crop, not an 8.",
    toast: "Match rejected",
  },
  escalate: {
    label: "Escalate",
    icon: Flag,
    variant: "gold",
    title: "Escalate for a second reviewer",
    description: "You cannot decide with confidence. A supervisor reviews it next.",
    placeholder: "e.g. Plate matches, but vehicle colour differs from the case notes.",
    toast: "Escalated to supervisor",
  },
};

const PANEL_VARIANTS = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, staggerChildren: 0.05 } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
};

/** Stable seed for the generated art of an alert. */
const seedOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export default function Alerts() {
  const session = useSession();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>("pending");
  const loaded = useApi((ctx) => api.getAlerts(ctx));
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [freshIds, setFreshIds] = useState<string[]>([]);

  useEffect(() => {
    if (loaded.data) setAlerts(loaded.data);
  }, [loaded.data]);

  useEffect(() => {
    return api.subscribeAlerts({ token: session.token }, (a) => {
      setAlerts((xs) => (xs.some((x) => x.id === a.id) ? xs : [a, ...xs]));
      setFreshIds((ids) => [...ids, a.id]);
      toast({ tone: priorityOf(a.watchlistEntry.reason) === "critical" ? "critical" : "info", title: "New watchlist match", body: `${a.cityName} · ${a.cameraName}. Added to your queue.` });
    });
  }, [session.token, toast]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { pending: 0, decided: 0, all: alerts.length };
    for (const a of alerts) c[a.status === "pending" ? "pending" : "decided"]++;
    return c;
  }, [alerts]);

  const visible = alerts.filter((a) => filter === "all" || (filter === "pending") === (a.status === "pending"));
  const selectedId = params.get("id") ?? visible[0]?.id ?? null;
  const selected = alerts.find((a) => a.id === selectedId) ?? null;

  const select = (id: string) => setParams({ id }, { replace: true });

  const onDecided = (updated: Alert) => {
    setAlerts((xs) => xs.map((x) => (x.id === updated.id ? updated : x)));
    const next = alerts.find((a) => a.status === "pending" && a.id !== updated.id);
    if (filter === "pending" && next) select(next.id);
  };

  return (
    <>
      <PageHeader
        eyebrow="Human in the loop"
        title="Live alerts"
        description="The system only suggests a match. A human confirms every watchlist match before anything happens, and every decision is written to the audit log with its justification."
        actions={<Badge tone="ok"><LiveDot className="mr-0.5" /> Listening for new matches</Badge>}
      />

      {loaded.error ? (
        <ErrorState error={loaded.error} onRetry={loaded.reload} />
      ) : !loaded.data ? (
        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <LoadingBlock className="rounded-lg border border-border bg-surface" label="Loading queue" />
          <LoadingBlock className="h-[560px] rounded-lg border border-border bg-surface" label="Loading alert" />
        </div>
      ) : (
        <RevealGroup className="grid items-start gap-6 lg:grid-cols-[minmax(300px,360px)_1fr]">
          <Card className="lg:sticky lg:top-[calc(var(--topbar-h)+1.5rem)]">
            <div className="flex gap-1 border-b border-border p-2" role="tablist" aria-label="Filter alerts">
              {(["pending", "decided", "all"] as const).map((f) => (
                <button
                  key={f}
                  role="tab"
                  type="button"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-sm py-2 text-sm capitalize transition-colors",
                    filter === f ? "bg-surface-raised font-medium shadow-1" : "text-muted hover:text-text",
                  )}
                >
                  {f === "pending" ? "To review" : f}
                  <span className={cn("rounded-full px-1.5 font-mono text-[11px] tabular", f === "pending" && counts.pending ? "bg-accent text-accent-fg" : "bg-bg-subtle text-muted")}>
                    {counts[f]}
                  </span>
                </button>
              ))}
            </div>
            <Queue alerts={visible} selectedId={selectedId} freshIds={freshIds} onSelect={select} filter={filter} />
          </Card>

          <AnimatePresence mode="wait">
            {selected ? (
              // variant labels (not inline values) so the Cards inside inherit "show" and stagger in
              <motion.div key={selected.id} initial="hidden" animate="show" exit="exit" variants={PANEL_VARIANTS}>
                <ReviewPanel alert={selected} onDecided={onDecided} />
              </motion.div>
            ) : (
              <Card key="none" className="p-6">
                <EmptyState title="Nothing selected">Pick an alert from the queue to review it.</EmptyState>
              </Card>
            )}
          </AnimatePresence>
        </RevealGroup>
      )}
    </>
  );
}

function Queue({ alerts, selectedId, freshIds, onSelect, filter }: {
  alerts: Alert[];
  selectedId: string | null;
  freshIds: string[];
  onSelect: (id: string) => void;
  filter: Filter;
}) {
  if (!alerts.length) {
    return (
      <div className="p-6">
        <EmptyState title={filter === "pending" ? "Queue is clear" : "No alerts"}>
          {filter === "pending" ? "Every match has been reviewed. New ones appear here automatically." : "Nothing matches this filter."}
        </EmptyState>
      </div>
    );
  }
  return (
    <ul className="max-h-[calc(100vh-15rem)] space-y-1 overflow-y-auto p-2" aria-label="Alert queue">
      <AnimatePresence initial={false}>
        {alerts.map((a) => {
          const active = a.id === selectedId;
          const status = ALERT_STATUS[a.status];
          const low = a.chars.some((c) => c.confidence < LOW_CONFIDENCE);
          return (
            <motion.li key={a.id} layout initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}>
              <AlertCard
                plate={a.plate}
                priority={priorityOf(a.watchlistEntry.reason)}
                title={`${REASON_LABELS[a.watchlistEntry.reason]} · ${a.watchlistEntry.caseRef}`}
                meta={`${a.cityName} · ${a.cameraName} · ${relativeTime(a.capturedAt)}`}
                trailing={a.status === "pending" ? undefined : <Badge tone={status.tone} className="h-5 px-2 text-[10px]">{status.label}</Badge>}
                lowConfidence={low}
                active={active}
                fresh={freshIds.includes(a.id)}
                onClick={() => onSelect(a.id)}
              />
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

function ReviewPanel({ alert, onDecided }: { alert: Alert; onDecided: (a: Alert) => void }) {
  const { can } = useSession();
  const ctx = useRequestContext();
  const toast = useToast();
  const [action, setAction] = useState<ReviewAction | null>(null);
  const seed = seedOf(alert.id);
  const weak = alert.chars.filter((c) => c.confidence < LOW_CONFIDENCE);
  const status = ALERT_STATUS[alert.status];

  const submit = async (justification: string) => {
    if (!action) return;
    const updated = await api.reviewAlert(ctx, alert.id, action, justification);
    toast({ tone: "success", title: ACTIONS[action].toast, body: `Logged to the audit trail as ${updated.decision?.auditId}.` });
    onDecided(updated);
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-muted">{alert.id}</span>
              <Badge tone={status.tone} dot>{status.label}</Badge>
              <Badge tone={PRIORITY_TONE[priorityOf(alert.watchlistEntry.reason)]} className="uppercase tracking-wide">{alert.watchlistEntry.reason}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted">
              {alert.cityName} · {alert.cameraName} <span className="font-mono">({alert.cameraId})</span> · {formatDateTime(alert.capturedAt)} · {alert.condition} · {PLATE_TYPE_LABELS[alert.plateType]}
            </p>
          </div>
          {can("evidence:view") ? (
            <Link to={`/evidence/${alert.evidenceId}`} className="focus-ring inline-flex items-center gap-1.5 rounded-sm text-sm text-accent hover:underline">
              <FileLock2 size={15} aria-hidden /> Signed evidence {alert.evidenceId} <ArrowUpRight size={14} aria-hidden />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted"><FileLock2 size={15} aria-hidden /> Signed evidence {alert.evidenceId}</span>
          )}
        </div>

        <div className="grid gap-5 p-6 xl:grid-cols-[1fr_1.35fr]">
          <figure>
            <figcaption className="mb-2 text-xs font-medium uppercase tracking-[0.1em] text-faint">Plate crop (what the OCR read)</figcaption>
            <PlateCrop text={alert.plate} condition={alert.condition} seed={seed} label={`Generated plate crop showing ${alert.plate.replace(/\|/g, " ")}`} />
            <p className="mt-2 text-[11px] text-faint">Generated placeholder image. No real photos are used in this demo.</p>
          </figure>
          <figure>
            <figcaption className="mb-2 text-xs font-medium uppercase tracking-[0.1em] text-faint">Full frame</figcaption>
            <SceneFrame
              text={alert.plate}
              condition={alert.condition}
              seed={seed}
              cameraId={alert.cameraId}
              capturedAt={alert.capturedAt}
              confidence={alert.chars.reduce((s, c) => s + c.confidence, 0) / alert.chars.length}
              label={`Generated camera frame from ${alert.cameraName} with the detected plate boxed`}
            />
          </figure>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="OCR result" subtitle="Per-character confidence. Gold means check it against the crop." />
          <div className="space-y-5 p-6 pt-4">
            <PlateText value={alert.plate} size="lg" />
            <ConfidenceBars chars={alert.chars} />
            {weak.length > 0 && (
              <p className="flex items-start gap-2 rounded-sm bg-gold-soft px-3 py-2.5 text-sm text-gold-strong">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  {weak.length === 1 ? "One character is" : `${weak.length} characters are`} below {formatPercent(LOW_CONFIDENCE, 0)} confidence
                  ({weak.map((c) => c.char).join(", ")}). Compare with the crop before deciding.
                </span>
              </p>
            )}
          </div>
        </Card>

        <Card tone={priorityOf(alert.watchlistEntry.reason) === "critical" ? "gold" : "default"}>
          <CardHeader title="Watchlist match" subtitle={`Match score ${formatPercent(alert.matchScore, 0)}`} />
          <div className="space-y-5 p-6 pt-4">
            <PlateCompare ocr={alert.plate} listed={alert.watchlistEntry.plate} />
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div className="col-span-2"><dt className="text-xs text-muted">Reason</dt><dd className="font-medium">{REASON_LABELS[alert.watchlistEntry.reason]}</dd></div>
              <div><dt className="text-xs text-muted">Case</dt><dd className="font-mono text-[13px]">{alert.watchlistEntry.caseRef}</dd></div>
              <div><dt className="text-xs text-muted">Entry</dt><dd className="font-mono text-[13px]">{alert.watchlistEntry.id}</dd></div>
              <div><dt className="text-xs text-muted">Source</dt><dd className="text-[13px]">{alert.watchlistEntry.source}</dd></div>
              <div><dt className="text-xs text-muted">Added</dt><dd>{relativeTime(alert.watchlistEntry.addedAt)}</dd></div>
              {alert.watchlistEntry.expiresAt && <div className="col-span-2"><dt className="text-xs text-muted">Expires</dt><dd>{formatDateTime(alert.watchlistEntry.expiresAt)}</dd></div>}
            </dl>
          </div>
        </Card>
      </div>

      <Card tone="glass">
        {alert.decision ? (
          <div className="flex flex-wrap items-start gap-4 p-6">
            <span className={cn("grid size-10 shrink-0 place-items-center rounded-full", alert.status === "approved" ? "bg-ok-soft text-ok" : alert.status === "escalated" ? "bg-gold-soft text-gold-strong" : "bg-bg-subtle text-muted")}>
              {alert.status === "approved" ? <CheckCircle2 size={20} aria-hidden /> : alert.status === "escalated" ? <Flag size={18} aria-hidden /> : <X size={18} aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {status.label} by <span className="font-mono text-[14px]">{alert.decision.reviewer}</span>{" "}
                <span className="text-muted">· {formatDateTime(alert.decision.decidedAt)}</span>
              </p>
              <blockquote className="mt-2 border-l-2 border-border-strong pl-3 text-sm text-muted">{alert.decision.justification}</blockquote>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
                <ScrollText size={13} aria-hidden /> Audit entry{" "}
                {can("audit:view") ? (
                  <Link to={`/audit?q=${alert.decision.auditId}`} className="font-mono text-accent hover:underline">{alert.decision.auditId}</Link>
                ) : (
                  <span className="font-mono">{alert.decision.auditId}</span>
                )}
              </p>
            </div>
          </div>
        ) : can("alerts:review") ? (
          <div className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><UserCheck size={19} aria-hidden /></span>
                <div>
                  <p className="font-medium">Your decision is required</p>
                  <p className="text-sm text-muted">Nothing happens to this vehicle until a human decides. A written justification is required.</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["reject", "escalate", "approve"] as const).map((a) => {
                  const cfg = ACTIONS[a];
                  return (
                    <Button key={a} variant={cfg.variant} onClick={() => setAction(a)}>
                      <cfg.icon size={16} aria-hidden /> {cfg.label}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 p-6 text-sm text-muted">
            <ShieldQuestion size={18} aria-hidden /> Your role can view alerts but not decide them.
          </div>
        )}
      </Card>

      <JustificationDialog
        open={action !== null}
        onClose={() => setAction(null)}
        title={action ? ACTIONS[action].title : ""}
        description={action ? ACTIONS[action].description : undefined}
        label="Justification"
        placeholder={action ? ACTIONS[action].placeholder : undefined}
        confirmLabel={action ? ACTIONS[action].label : ""}
        variant={action ? ACTIONS[action].variant : "primary"}
        minLength={MIN_JUSTIFICATION_LENGTH}
        onSubmit={submit}
      />
    </div>
  );
}

/** OCR text vs the listed plate, character by character, with differences highlighted. */
function PlateCompare({ ocr, listed }: { ocr: string; listed: string }) {
  const a = ocr.split("");
  const b = listed.split("");
  const same = ocr === listed;
  const row = (label: string, chars: string[], other: string[]) => (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-muted">{label}</span>
      <span className="flex flex-wrap gap-1 font-mono text-[15px]" dir="ltr">
        {chars.map((c, i) =>
          c === "|" ? (
            <span key={i} className="mx-0.5 w-px self-stretch bg-border-strong" aria-hidden />
          ) : (
            <span
              key={i}
              className={cn(
                "grid h-8 w-7 place-items-center rounded-xs border",
                c !== other[i] ? "border-gold bg-gold-soft font-semibold text-gold-strong" : "border-border bg-surface-raised",
                !/\d/.test(c) && "font-sans",
              )}
            >
              {c}
            </span>
          ),
        )}
      </span>
    </div>
  );
  return (
    <div className="space-y-2">
      {row("OCR read", a, b)}
      {row("Watchlist", b, a)}
      <p className={cn("flex items-center gap-1.5 text-xs", same ? "text-ok" : "text-gold-strong")}>
        {same ? <Check size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}
        {same ? "Exact text match. Still confirm the image shows this plate." : "Near match: the highlighted characters differ. Likely an OCR misread; check the crop."}
      </p>
      <span className="sr-only">{same ? "OCR text and watchlist plate are identical." : `OCR read ${ocr.replace(/\|/g, " ")}, watchlist plate is ${listed.replace(/\|/g, " ")}.`}</span>
    </div>
  );
}
