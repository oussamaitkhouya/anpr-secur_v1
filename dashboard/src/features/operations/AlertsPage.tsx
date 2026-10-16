/*
 * /alerts: the human-in-the-loop review queue, on real PostgreSQL data. The system only suggests
 * a match; a person decides, with a written justification that is stored and audited. Analysts
 * (alerts.review) see the full OCR read; other roles see it masked and cannot decide.
 * The evidence frame (EvidenceCard) is the real capture, hash-checked by the server and again by
 * the browser; nothing is generated or faked.
 *
 * Keyboard: J / K move through the queue, / focuses search, and for reviewers A / R / E open the
 * confirm / reject / escalate dialog. A shortcut only opens the dialog; the written justification
 * is still required, so a stray key press can never decide an alert.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Check, CheckCircle2, Flag, Fingerprint, MapPin, Clock3, Car, ScrollText, Search, ShieldCheck, ShieldQuestion, UserCheck, X } from "lucide-react";
import { ApiError } from "../../api/errors";
import { useSession } from "../../app/session";
import { AlertCard } from "../../components/ui/AlertCard";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader, RevealGroup } from "../../components/ui/Card";
import { ConfidenceBars, LOW_CONFIDENCE } from "../../components/ui/ConfidenceBars";
import { JustificationDialog } from "../../components/ui/JustificationDialog";
import { LiveDot } from "../../components/ui/LiveDot";
import { PageHeader } from "../../components/ui/PageHeader";
import { PlateText } from "../../components/ui/PlateText";
import { PRIORITY_COLOR, PRIORITY_RANK } from "../../components/ui/priority";
import { LoadingBlock } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { useToast } from "../../components/ui/toast";
import { ALERT_STATUS, PRIORITY_TONE } from "../../components/ui/tones";
import type { Priority } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatDateTime, formatPercent, relativeTime } from "../../lib/format";
import { ClearHistoryButton } from "./ClearHistory";
import { EvidenceCard } from "./EvidenceCard";
import { formatWait, SLOW_WAIT_S, useNow, waitedSeconds } from "./alertTime";
import { Kbd, MatchRing, PlateHero, QueueStats } from "./alertsUi";
import { KIND_LABELS, MIN_JUSTIFICATION, POLL_MS, priorityOf, REASON_LABELS, shortId, useAlerts, useReview, type LiveAlert, type ReviewAction } from "./api";

type Filter = "pending" | "decided" | "all";

const PANEL = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1], staggerChildren: 0.05 } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.15 } },
} as const;
type PriorityFilter = Priority | "any";

const ACTIONS: Record<ReviewAction, { label: string; key: string; icon: typeof Check; variant: "primary" | "danger" | "gold"; title: string; description: string; placeholder: string; toast: string }> = {
  approve: {
    label: "Confirm match", key: "A", icon: Check, variant: "primary", title: "Confirm this watchlist match",
    description: "You confirm the plate read is the listed vehicle. Downstream procedures start only after this.",
    placeholder: "e.g. All characters legible on the evidence frame; letter and region match the entry.", toast: "Match confirmed",
  },
  reject: {
    label: "Reject", key: "R", icon: X, variant: "danger", title: "Reject as a false match",
    description: "The OCR read or the match is wrong. No action is taken on the vehicle.",
    placeholder: "e.g. The low-confidence digit is a 3 on the frame, not an 8.", toast: "Match rejected",
  },
  escalate: {
    label: "Escalate", key: "E", icon: Flag, variant: "gold", title: "Escalate for a second reviewer",
    description: "You cannot decide with confidence. A supervisor reviews it next.",
    placeholder: "e.g. Plate matches, but the vehicle colour differs from the case notes.", toast: "Escalated to supervisor",
  },
};

const TABS: { id: Filter; label: string }[] = [{ id: "pending", label: "To review" }, { id: "decided", label: "Decided" }, { id: "all", label: "All" }];
const PRIORITY_CHIPS: { id: PriorityFilter; label: string }[] = [
  { id: "any", label: "All" }, { id: "critical", label: "Critical" }, { id: "high", label: "High" }, { id: "medium", label: "Medium" },
];

/** True when a key press belongs to a text field or an open dialog, not to the page shortcuts. */
function typingOrModal(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return true;
  return document.querySelector('[aria-modal="true"]') !== null;
}

function matchesSearch(a: LiveAlert, q: string) {
  if (!q) return true;
  const hay = [a.plate.replaceAll("|", ""), a.plate, a.cityName, a.cameraName, a.watchlistEntry.caseRef ?? "", a.watchlistEntry.listName, REASON_LABELS[a.watchlistEntry.reason]]
    .join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

export default function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>("pending");
  const [prio, setPrio] = useState<PriorityFilter>("any");
  const [query, setQuery] = useState("");
  const alerts = useAlerts();
  const toast = useToast();
  const now = useNow();
  const known = useRef<Set<string> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [freshIds, setFreshIds] = useState<string[]>([]);

  // A poll that brings ids we have not seen before: highlight them and say so.
  useEffect(() => {
    if (!alerts.data) return;
    const ids = new Set(alerts.data.map((a) => a.id));
    if (known.current) {
      const fresh = alerts.data.filter((a) => !known.current!.has(a.id) && a.status === "pending");
      if (fresh.length) {
        setFreshIds((xs) => [...xs, ...fresh.map((a) => a.id)]);
        toast({ tone: fresh.some((a) => priorityOf(a.watchlistEntry.reason) === "critical") ? "critical" : "info",
          title: fresh.length === 1 ? "New watchlist match" : `${fresh.length} new watchlist matches`, body: "Added to the review queue." });
      }
    }
    known.current = ids;
  }, [alerts.data, toast]);

  const list = useMemo(() => alerts.data ?? [], [alerts.data]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { pending: 0, decided: 0, all: list.length };
    for (const a of list) c[a.status === "pending" ? "pending" : "decided"]++;
    return c;
  }, [list]);
  // To review: most urgent first, then the one waiting longest. Other tabs keep the server's order.
  const visible = useMemo(() => {
    const xs = list.filter((a) =>
      (filter === "all" || (filter === "pending") === (a.status === "pending"))
      && (prio === "any" || priorityOf(a.watchlistEntry.reason) === prio)
      && matchesSearch(a, query.trim()));
    if (filter !== "pending") return xs;
    return [...xs].sort((a, b) =>
      PRIORITY_RANK[priorityOf(a.watchlistEntry.reason)] - PRIORITY_RANK[priorityOf(b.watchlistEntry.reason)]
      || a.observedAt.localeCompare(b.observedAt));
  }, [list, filter, prio, query]);
  const selectedId = params.get("id") ?? visible[0]?.id ?? null;
  const selected = list.find((a) => a.id === selectedId) ?? null;
  const select = (id: string) => setParams({ id }, { replace: true });

  // J / K through the visible queue, / to search.
  const nav = useRef({ visible, selectedId, select });
  nav.current = { visible, selectedId, select };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !typingOrModal(e)) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typingOrModal(e) || (e.key !== "j" && e.key !== "k")) return;
      const { visible: xs, selectedId: id, select: go } = nav.current;
      if (!xs.length) return;
      const i = xs.findIndex((a) => a.id === id);
      const next = xs[Math.min(xs.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))];
      if (next) go(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Human in the loop"
        title="Live alerts"
        description="The system only suggests a match. A person confirms every watchlist match before anything happens, and every decision is written to the signed audit log with its justification."
        actions={
          <>
          <ClearHistoryButton />
          <span className="glass flex items-center gap-2.5 rounded-full py-2 pl-3 pr-4 text-xs text-muted shadow-1">
            <LiveDot tone={alerts.error ? "danger" : "ok"} />
            <span className={cn("font-semibold uppercase tracking-[0.12em]", alerts.error ? "text-danger" : "text-ok")}>{alerts.error ? "Offline" : "Live"}</span>
            <span>
              every {POLL_MS / 1000} s{alerts.dataUpdatedAt ? ` · updated ${relativeTime(new Date(alerts.dataUpdatedAt).toISOString(), now)}` : ""}
              {alerts.isFetching && <span className="sr-only"> · refreshing</span>}
            </span>
          </span>
          </>
        }
      />
      {alerts.error ? (
        <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
      ) : !alerts.data ? (
        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          <LoadingBlock className="rounded-lg border border-border bg-surface" label="Loading queue" />
          <LoadingBlock className="h-[480px] rounded-lg border border-border bg-surface" label="Loading alert" />
        </div>
      ) : (
        <>
          <QueueStats alerts={list} now={now} />
          <RevealGroup className="grid items-start gap-6 lg:grid-cols-[minmax(320px,384px)_1fr]">
            <Card className="overflow-hidden lg:sticky lg:top-[calc(var(--topbar-h)+1.5rem)]">
              <div className="space-y-3 border-b border-border p-4">
                <div className="relative">
                  <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
                  <input ref={searchRef} type="search" aria-label="Search alerts" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Plate, city, camera, case…"
                    onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); } }}
                    className="focus-ring h-11 w-full rounded-sm border border-border bg-bg/60 pl-10 pr-10 text-sm text-text placeholder:text-faint transition-colors focus:border-accent" />
                  <Kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-faint">/</Kbd>
                </div>
                <div className="grid grid-cols-3 gap-1 rounded-md border border-border bg-bg/60 p-1" role="tablist" aria-label="Filter alerts">
                  {TABS.map(({ id, label }) => (
                    <button key={id} role="tab" type="button" aria-selected={filter === id} onClick={() => setFilter(id)}
                      className={cn("focus-ring relative flex min-h-9 items-center justify-center gap-1.5 rounded-sm text-[13px] transition-colors", filter === id ? "font-semibold text-text" : "text-muted hover:text-text")}>
                      {filter === id && (
                        <motion.span layoutId="alerts-tab" className="absolute inset-0 rounded-sm bg-surface-raised shadow-1 ring-1 ring-border"
                          transition={{ type: "spring", stiffness: 420, damping: 34 }} aria-hidden />
                      )}
                      <span className="relative">{label}</span>
                      <span className={cn("relative rounded-full px-1.5 font-mono text-[11px] tabular", id === "pending" && counts.pending ? "btn-primary" : "bg-bg-subtle text-muted")}>{counts[id]}</span>
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Priority">
                  {PRIORITY_CHIPS.map(({ id, label }) => (
                    <button key={id} type="button" aria-pressed={prio === id} onClick={() => setPrio(id)}
                      className={cn("focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                        prio === id ? "border-border-strong bg-surface-raised text-text shadow-1" : "border-border text-muted hover:text-text")}
                      style={prio === id && id !== "any" ? { borderColor: PRIORITY_COLOR[id] } : undefined}>
                      <span className="size-1.5 rounded-full" style={{ background: id === "any" ? "var(--text-faint)" : PRIORITY_COLOR[id] }} aria-hidden />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <Queue alerts={visible} selectedId={selectedId} freshIds={freshIds} onSelect={select} filter={filter} empty={list.length === 0}
                narrowed={prio !== "any" || query.trim() !== ""} now={now} />
              <p className="hidden items-center justify-center gap-3 border-t border-border px-4 py-2.5 text-[11px] text-faint lg:flex">
                <span className="flex items-center gap-1"><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
                <span className="flex items-center gap-1"><Kbd>/</Kbd> search</span>
                <span className="flex items-center gap-1"><Kbd>A</Kbd><Kbd>R</Kbd><Kbd>E</Kbd> decide</span>
              </p>
            </Card>
            <AnimatePresence mode="wait">
              {selected ? (
                /* Own "hidden" -> "show" run on every switch: the cards inside reveal through variants, and
                   without this they would inherit the page's one-time reveal and stay invisible. */
                <motion.div key={selected.id} initial="hidden" animate="show" exit="exit" variants={PANEL}>
                  <ReviewPanel alert={selected} now={now} onDecided={(updated) => {
                    const next = visible.find((a) => a.status === "pending" && a.id !== updated.id);
                    if (filter === "pending" && next) select(next.id);
                  }} />
                </motion.div>
              ) : (
                <Card key="none" className="p-6">
                  <EmptyState title={list.length ? "Nothing selected" : "No alerts yet"}>
                    {list.length ? "Pick an alert from the queue to review it." : "Alerts appear here when a camera reads a plate that is on an active watchlist."}
                  </EmptyState>
                </Card>
              )}
            </AnimatePresence>
          </RevealGroup>
        </>
      )}
    </>
  );
}

function Queue({ alerts, selectedId, freshIds, onSelect, filter, empty, narrowed, now }: {
  alerts: LiveAlert[]; selectedId: string | null; freshIds: string[]; onSelect: (id: string) => void; filter: Filter; empty: boolean; narrowed: boolean; now: number;
}) {
  if (!alerts.length) {
    return (
      <div className="p-6">
        <EmptyState title={empty ? "No alerts yet" : narrowed ? "No matching alerts" : filter === "pending" ? "Queue is clear" : "No alerts"}>
          {empty ? "Nothing has matched a watchlist in your cities." : narrowed ? "Nothing matches this search or priority." : filter === "pending" ? "Every match has been reviewed. New ones appear here automatically." : "Nothing matches this filter."}
        </EmptyState>
      </div>
    );
  }
  return (
    <ul className="max-h-[calc(100vh-22rem)] min-h-40 space-y-1.5 overflow-y-auto p-2.5" aria-label="Alert queue">
      <AnimatePresence initial={false}>
        {alerts.map((a, i) => (
          <motion.li key={a.id} layout initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0, transition: { delay: Math.min(i, 8) * 0.03 } }} exit={{ opacity: 0, height: 0 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}>
            <AlertCard
              plate={a.plate}
              priority={priorityOf(a.watchlistEntry.reason)}
              title={`${REASON_LABELS[a.watchlistEntry.reason]}${a.watchlistEntry.caseRef ? ` · ${a.watchlistEntry.caseRef}` : ""}`}
              meta={`${a.cityName} · ${a.cameraName}${a.status === "pending" ? "" : ` · ${relativeTime(a.observedAt, now)}`}`}
              trailing={a.status === "pending" ? undefined : <Badge tone={ALERT_STATUS[a.status].tone} className="h-5 px-2 text-[10px]">{ALERT_STATUS[a.status].label}</Badge>}
              waiting={a.status === "pending" ? formatWait(a.observedAt, now) : undefined}
              waitingSlow={a.status === "pending" && waitedSeconds(a.observedAt, now) > SLOW_WAIT_S}
              lowConfidence={a.chars.some((c) => c.confidence < LOW_CONFIDENCE)}
              active={a.id === selectedId}
              fresh={freshIds.includes(a.id)}
              onClick={() => onSelect(a.id)}
            />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function ReviewPanel({ alert, now, onDecided }: { alert: LiveAlert; now: number; onDecided: (a: LiveAlert) => void }) {
  const { can } = useSession();
  const toast = useToast();
  const review = useReview();
  const [action, setAction] = useState<ReviewAction | null>(null);
  const weak = alert.chars.filter((c) => c.confidence < LOW_CONFIDENCE);
  const status = ALERT_STATUS[alert.status];
  const priority = priorityOf(alert.watchlistEntry.reason);
  const vehicle = [alert.observedColor, alert.observedMake, alert.observedModel].filter(Boolean).join(" ");
  const listedVehicle = [alert.watchlistEntry.color, alert.watchlistEntry.make, alert.watchlistEntry.model].filter(Boolean).join(" ");
  const canDecide = !alert.decision && can("alerts:review") && !alert.plateMasked; // the server unmasks plates only for reviewers

  // A / R / E open the matching dialog. The justification is still required inside it.
  useEffect(() => {
    if (!canDecide) return;
    const keys: Record<string, ReviewAction> = { a: "approve", r: "reject", e: "escalate" };
    const onKey = (e: KeyboardEvent) => {
      const act = keys[e.key.toLowerCase()];
      if (!act || typingOrModal(e)) return;
      e.preventDefault();
      setAction(act);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canDecide]);

  const submit = async (justification: string) => {
    if (!action) return;
    try {
      const updated = await review.mutateAsync({ id: alert.id, action, justification });
      toast({ tone: "success", title: ACTIONS[action].toast, body: "Recorded in the signed audit log with your justification." });
      onDecided(updated);
    } catch (e) {
      // surfaced inside the dialog by JustificationDialog when it rethrows
      throw e instanceof ApiError ? e : new ApiError(0, "The decision could not be saved.");
    }
  };

  const tint = PRIORITY_COLOR[priority];
  return (
    <div className="space-y-6">
      <Card className="overflow-hidden" tone={priority === "critical" && alert.status === "pending" ? "gold" : "default"}>
        {/* priority-tinted light from the top-left corner */}
        <span className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-70"
          style={{ background: `radial-gradient(60% 90% at 0% 0%, color-mix(in oklab, ${tint} 16%, transparent), transparent 62%)` }} aria-hidden />
        <div className="relative flex flex-wrap items-center justify-between gap-6 p-6 sm:p-7">
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-muted" title={alert.id}>Alert {shortId(alert.id)}</span>
              <Badge tone={status.tone} dot>{status.label}</Badge>
              <Badge tone={PRIORITY_TONE[priority]} className="uppercase tracking-wide">{alert.watchlistEntry.reason}</Badge>
              <Badge tone="neutral">{KIND_LABELS[alert.kind]}</Badge>
            </div>
            <PlateHero value={alert.plate} />
            <p className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-muted">
              <span className="flex items-center gap-1.5"><MapPin size={14} aria-hidden />{alert.cityName} · {alert.cameraName}</span>
              <span className="flex items-center gap-1.5"><Clock3 size={14} aria-hidden />{formatDateTime(alert.observedAt)}
                {alert.status === "pending" && <span className="font-mono text-faint"> · waiting {formatWait(alert.observedAt, now)}</span>}
              </span>
              {vehicle && <span className="flex items-center gap-1.5"><Car size={14} aria-hidden />seen as <span className="text-text">{vehicle}</span></span>}
            </p>
          </div>
          <div className="flex items-center gap-5">
            <MatchRing score={alert.matchScore} priority={priority} />
            <div className="space-y-2.5 text-xs text-muted">
              <p className="flex items-center gap-2">
                <ShieldCheck size={15} className={alert.evidenceSha256 ? "text-ok" : "text-faint"} aria-hidden />
                {alert.evidenceSha256 ? "Evidence frame hashed" : "No evidence frame attached"}
              </p>
              {alert.evidenceSha256 && <p className="font-mono text-text" title={alert.evidenceSha256}>SHA-256 {alert.evidenceSha256.slice(0, 12)}…</p>}
              <p>Plate confidence {formatPercent(alert.plateConfidence, 0)}</p>
              <p className="max-w-[16rem] text-faint">Compare the frame below with the OCR read before deciding.</p>
            </div>
          </div>
        </div>
      </Card>

      <EvidenceCard alert={alert} />

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="OCR read" subtitle={alert.plateMasked ? "Masked for your role" : `Plate confidence ${formatPercent(alert.plateConfidence, 0)}. Gold = check carefully.`} />
          <div className="space-y-5 p-6 pt-4">
            <PlateText value={alert.plate} size="lg" />
            {alert.chars.length > 0 && <ConfidenceBars chars={alert.chars} />}
            {weak.length > 0 && (
              <p className="flex items-start gap-2 rounded-sm bg-gold-soft px-3 py-2.5 text-sm text-gold-strong">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>{weak.length === 1 ? "One character is" : `${weak.length} characters are`} below {formatPercent(LOW_CONFIDENCE, 0)} confidence ({weak.map((c) => c.char).join(", ")}). Compare with the evidence frame before deciding.</span>
              </p>
            )}
            {alert.plateMasked && (
              <p className="flex items-center gap-2 text-xs text-muted"><Fingerprint size={14} aria-hidden />Only reviewers see full plates. Revealing requires a reason and is audited.</p>
            )}
          </div>
        </Card>

        <Card tone={priority === "critical" ? "gold" : "default"}>
          <CardHeader title="Watchlist match" subtitle={`${alert.watchlistEntry.listName} · match score ${formatPercent(alert.matchScore, 0)}`} />
          <div className="space-y-5 p-6 pt-4">
            {!alert.plateMasked && <PlateCompare ocr={alert.plate} listed={alert.watchlistEntry.plate} />}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div className="col-span-2"><dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Reason</dt><dd className="font-medium">{REASON_LABELS[alert.watchlistEntry.reason]}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Case</dt><dd className="font-mono text-[13px]">{alert.watchlistEntry.caseRef ?? "—"}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Source</dt><dd className="text-[13px]">{alert.watchlistEntry.source ?? "—"}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Listed vehicle</dt><dd className="text-[13px]">{listedVehicle || "—"}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Added</dt><dd>{relativeTime(alert.watchlistEntry.addedAt, now)}</dd></div>
              {alert.watchlistEntry.expiresAt && <div className="col-span-2"><dt className="text-[11px] uppercase tracking-[0.1em] text-faint">Expires</dt><dd>{formatDateTime(alert.watchlistEntry.expiresAt)}</dd></div>}
            </dl>
          </div>
        </Card>
      </div>

      {/* the decision dock stays in reach at the bottom of the window while the evidence scrolls */}
      <div className={cn("rounded-lg shadow-3", canDecide && "sticky bottom-4 z-10")}>
        <Card tone="glass">
          {alert.decision ? (
            <div className="flex flex-wrap items-start gap-4 p-6">
              <span className={cn("grid size-10 shrink-0 place-items-center rounded-full", alert.status === "approved" ? "bg-ok-soft text-ok" : alert.status === "escalated" ? "bg-gold-soft text-gold-strong" : "bg-bg-subtle text-muted")}>
                {alert.status === "approved" ? <CheckCircle2 size={20} aria-hidden /> : alert.status === "escalated" ? <Flag size={18} aria-hidden /> : <X size={18} aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{status.label} by <span className="font-mono text-[14px]">{alert.decision.reviewer}</span> <span className="text-muted">· {formatDateTime(alert.decision.decidedAt)}</span></p>
                <blockquote className="mt-2 border-l-2 border-border-strong pl-3 text-sm text-muted">{alert.decision.justification}</blockquote>
                <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><ScrollText size={13} aria-hidden /> Recorded in the signed audit log.</p>
              </div>
            </div>
          ) : canDecide ? (
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div className="flex items-start gap-3">
                <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                  <span className="absolute inset-0 rounded-full ring-1 ring-accent motion-safe:animate-[live-pulse_2.4s_var(--ease-out)_infinite]" aria-hidden />
                  <UserCheck size={19} aria-hidden />
                </span>
                <div>
                  <p className="font-medium">Your decision is required</p>
                  <p className="text-sm text-muted">Nothing happens to this vehicle until a person decides. A written justification ({MIN_JUSTIFICATION}+ characters) is required.</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(["reject", "escalate", "approve"] as const).map((a) => {
                  const cfg = ACTIONS[a];
                  return <Button key={a} variant={cfg.variant} className="h-11 px-4" onClick={() => setAction(a)}><cfg.icon size={16} aria-hidden /> {cfg.label} <Kbd>{cfg.key}</Kbd></Button>;
                })}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-6 text-sm text-muted"><ShieldQuestion size={18} aria-hidden /> Your role can view alerts but not decide them.</div>
          )}
        </Card>
      </div>

      <JustificationDialog
        open={action !== null}
        onClose={() => setAction(null)}
        title={action ? ACTIONS[action].title : ""}
        description={action ? ACTIONS[action].description : undefined}
        label="Justification"
        placeholder={action ? ACTIONS[action].placeholder : undefined}
        confirmLabel={action ? ACTIONS[action].label : ""}
        variant={action ? ACTIONS[action].variant : "primary"}
        minLength={MIN_JUSTIFICATION}
        onSubmit={submit}
      />
    </div>
  );
}

/** OCR read vs listed plate, character by character, differences highlighted. */
function PlateCompare({ ocr, listed }: { ocr: string; listed: string }) {
  const a = ocr.split("");
  const b = listed.split("");
  const same = ocr === listed;
  const row = (label: string, chars: string[], other: string[]) => (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-muted">{label}</span>
      <span className="flex flex-wrap gap-1 font-mono text-[15px]" dir="ltr">
        {chars.map((c, i) => c === "|" ? <span key={i} className="mx-0.5 w-px self-stretch bg-border-strong" aria-hidden /> : (
          <span key={i} className={cn("grid h-8 w-7 place-items-center rounded-xs border", c !== other[i] ? "border-gold bg-gold-soft font-semibold text-gold-strong" : "border-border bg-surface-raised", !/\d/.test(c) && "font-sans")}>{c}</span>
        ))}
      </span>
    </div>
  );
  return (
    <div className="space-y-2">
      {row("OCR read", a, b)}
      {row("Watchlist", b, a)}
      <p className={cn("flex items-center gap-1.5 text-xs", same ? "text-ok" : "text-gold-strong")}>
        {same ? <Check size={13} aria-hidden /> : <AlertTriangle size={13} aria-hidden />}
        {same ? "Exact text match. Still confirm the evidence frame shows this plate." : "Near match: highlighted characters differ. Possibly an OCR misread."}
      </p>
    </div>
  );
}
