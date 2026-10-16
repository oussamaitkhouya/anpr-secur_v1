import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Eye, EyeOff, FileLock2, Lock, ScrollText, Search as SearchIcon, Siren, X } from "lucide-react";
import { api } from "../api/client";
import { useRequestContext } from "../api/useApi";
import type { PlateType, SearchFilters, SearchResult } from "../api/types";
import { useSession } from "../app/session";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, RevealGroup } from "../components/ui/Card";
import { DataTable } from "../components/ui/DataTable";
import { JustificationDialog } from "../components/ui/JustificationDialog";
import { PageHeader } from "../components/ui/PageHeader";
import { PlateText } from "../components/ui/PlateText";
import { LoadingBlock } from "../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../components/ui/States";
import { useToast } from "../components/ui/toast";
import { formatDateTime, formatNumber, formatPercent } from "../lib/format";
import { MIN_PLATE_QUERY, MIN_REASON_LENGTH, plateQueryLength, validateRevealReason } from "../lib/mask";
import { PLATE_TYPE_LABELS, PLATE_TYPES } from "../lib/plate";

type Range = "1h" | "24h" | "7d" | "custom";

const RANGES: { value: Range; label: string }[] = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 h" },
  { value: "7d", label: "Last 7 days" },
  { value: "custom", label: "Custom" },
];

/** Revealed plates are hidden again after this long; revealing again needs a new reason. */
const REVEAL_TTL_MS = 2 * 60_000;
const MAX_RESULTS = 500;

interface Form {
  plate: string;
  range: Range;
  from: string; // datetime-local
  to: string;
  cameraId: string;
  plateType: PlateType | "";
}

function toFilters(f: Form): SearchFilters {
  const now = Date.now();
  const span = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 } as const;
  const from = f.range === "custom" ? (f.from ? new Date(f.from).toISOString() : undefined) : new Date(now - span[f.range]).toISOString();
  const to = f.range === "custom" && f.to ? new Date(f.to).toISOString() : undefined;
  return { plate: f.plate.trim() || undefined, from, to, cameraId: f.cameraId || undefined, plateType: f.plateType || undefined };
}

const input = "focus-ring h-10 w-full rounded-sm border border-border bg-surface px-3 text-sm shadow-1";

export default function Search() {
  const ctx = useRequestContext();
  const { can } = useSession();
  const toast = useToast();
  const [params] = useSearchParams();
  const [form, setForm] = useState<Form>({ plate: params.get("q") ?? "", range: "24h", from: "", to: "", cameraId: "", plateType: "" });
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [cameras, setCameras] = useState<Map<string, string>>(new Map());
  const [revealed, setRevealed] = useState<Record<string, { plate: string; auditId: string; until: number }>>({});
  const [revealTarget, setRevealTarget] = useState<SearchResult | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const formRef = useRef(form);
  formRef.current = form;

  const run = useCallback(async (f: Form) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.searchPlates(ctxRef.current, toFilters(f));
      setResults(rows);
      // Camera options come from results, so the Auditor role (no camera access) can still filter.
      setCameras((m) => {
        const next = new Map(m);
        rows.forEach((r) => next.set(r.cameraId, r.cameraName));
        return next.size === m.size ? m : next;
      });
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  // initial search, and again when the top-bar search sends a new ?q=
  const q = params.get("q") ?? "";
  useEffect(() => {
    const next = { ...formRef.current, plate: q };
    setForm(next);
    void run(next);
  }, [q, run]);

  // re-mask revealed plates when their time is up
  useEffect(() => {
    const ids = Object.keys(revealed);
    if (!ids.length) return;
    const nextExpiry = Math.min(...ids.map((id) => revealed[id].until));
    const t = window.setTimeout(() => {
      const now = Date.now();
      setRevealed((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v.until > now)));
    }, Math.max(0, nextExpiry - Date.now()) + 50);
    return () => window.clearTimeout(t);
  }, [revealed]);

  const tooShort = form.plate.trim() !== "" && plateQueryLength(form.plate) < MIN_PLATE_QUERY;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!tooShort) void run(form);
  };

  const reset = () => {
    const f: Form = { plate: "", range: "24h", from: "", to: "", cameraId: "", plateType: "" };
    setForm(f);
    void run(f);
  };

  const hide = (readId: string) => setRevealed((r) => Object.fromEntries(Object.entries(r).filter(([id]) => id !== readId)));

  const reveal = async (reason: string) => {
    if (!revealTarget) return;
    const res = await api.revealPlate(ctx, revealTarget.readId, reason);
    setRevealed((r) => ({ ...r, [res.readId]: { plate: res.plate, auditId: res.auditId, until: Date.now() + REVEAL_TTL_MS } }));
    toast({ tone: "success", title: "Plate revealed for 2 minutes", body: `Your reason was logged as ${res.auditId}.` });
  };

  const canReveal = can("plates:reveal");
  const canEvidence = can("evidence:view");
  const columns = useMemo(() => {
    const col = createColumnHelper<SearchResult>();
    return [
      col.accessor("capturedAt", {
        header: "Time",
        cell: (c) => <span className="whitespace-nowrap font-mono text-[12.5px] tabular text-muted">{formatDateTime(c.getValue())}</span>,
      }),
      col.display({
        id: "plate",
        header: "Plate",
        cell: ({ row: { original: r } }) => {
          const shown = revealed[r.readId];
          return (
            <span className="flex items-center gap-2 whitespace-nowrap">
              <PlateText value={shown?.plate ?? r.plateMasked} size="sm" className={shown ? "border-gold" : undefined} />
              {shown ? (
                <button type="button" onClick={() => hide(r.readId)} className="focus-ring inline-flex items-center gap-1 rounded-xs text-xs text-muted hover:text-text" title={`Revealed, audit ${shown.auditId}`}>
                  <EyeOff size={13} aria-hidden /> Hide
                </button>
              ) : canReveal ? (
                <button type="button" onClick={() => setRevealTarget(r)} className="focus-ring inline-flex items-center gap-1 rounded-xs text-xs text-accent hover:underline" aria-label={`Reveal plate for read ${r.readId}`}>
                  <Eye size={13} aria-hidden /> Reveal
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-faint" title="Your role cannot unmask plates">
                  <Lock size={12} aria-hidden /> Masked
                </span>
              )}
            </span>
          );
        },
      }),
      col.accessor("plateType", { header: "Type", cell: (c) => PLATE_TYPE_LABELS[c.getValue()] }),
      col.accessor("cameraName", {
        header: "Camera",
        cell: ({ row: { original: r } }) => (
          <span className="whitespace-nowrap">{r.cameraName} <span className="font-mono text-[11px] text-faint">{r.cameraId}</span></span>
        ),
      }),
      col.accessor("confidence", {
        header: "Confidence",
        cell: (c) => (
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-14 overflow-hidden rounded-full bg-bg-subtle" aria-hidden>
              <span className="block h-full rounded-full bg-accent" style={{ width: `${c.getValue() * 100}%` }} />
            </span>
            <span className="font-mono text-[12px] tabular">{formatPercent(c.getValue(), 0)}</span>
          </span>
        ),
      }),
      col.accessor("condition", { header: "Condition", cell: (c) => <span className="capitalize text-muted">{c.getValue()}</span> }),
      col.accessor("watchlistHit", {
        header: "Watchlist",
        cell: (c) => (c.getValue() ? <Badge tone="gold"><Siren size={11} aria-hidden /> Hit</Badge> : <span className="text-faint">—</span>),
      }),
      col.accessor("evidenceId", {
        header: "Evidence",
        enableSorting: false,
        cell: (c) =>
          c.getValue() && canEvidence ? (
            <Link to={`/evidence/${c.getValue()}`} className="focus-ring inline-flex items-center gap-1 rounded-xs font-mono text-[12px] text-accent hover:underline">
              <FileLock2 size={12} aria-hidden /> {c.getValue()}
            </Link>
          ) : c.getValue() ? (
            <span className="font-mono text-[12px] text-muted">{c.getValue()}</span>
          ) : (
            <span className="text-faint">—</span>
          ),
      }),
    ];
  }, [revealed, canReveal, canEvidence]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Plate search"
        description="Plates are masked by default. Revealing one requires a reason and is written to the audit log, as is every search."
      />

      <RevealGroup className="space-y-6">
        <Card className="p-5">
          <form onSubmit={submit} className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1.4fr_1fr_1fr_1fr_auto]" role="search" aria-label="Plate search filters">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Plate</span>
              <span className="relative block">
                <SearchIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
                <input
                  value={form.plate}
                  onChange={(e) => set("plate", e.target.value)}
                  placeholder="Number, e.g. 48213, or a full plate"
                  className={`${input} pl-9 font-mono placeholder:font-sans`}
                  dir="ltr"
                  aria-invalid={tooShort}
                  aria-describedby="plate-hint"
                />
              </span>
              <span id="plate-hint" className={`mt-1 block text-[11px] ${tooShort ? "text-danger" : "text-faint"}`}>
                At least {MIN_PLATE_QUERY} characters, so masked plates cannot be guessed digit by digit.
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Time</span>
              <select value={form.range} onChange={(e) => set("range", e.target.value as Range)} className={input}>
                {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Camera</span>
              <select value={form.cameraId} onChange={(e) => set("cameraId", e.target.value)} className={input}>
                <option value="">All cameras</option>
                {[...cameras].sort(([a], [b]) => a.localeCompare(b)).map(([id, name]) => <option key={id} value={id}>{name} ({id})</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Plate type</span>
              <select value={form.plateType} onChange={(e) => set("plateType", e.target.value as PlateType | "")} className={input}>
                <option value="">All types</option>
                {PLATE_TYPES.map((t) => <option key={t} value={t}>{PLATE_TYPE_LABELS[t]}</option>)}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <Button type="submit" variant="primary" loading={loading} className="flex-1 xl:flex-none"><SearchIcon size={15} aria-hidden /> Search</Button>
              <Button variant="ghost" onClick={reset} aria-label="Reset filters"><X size={15} aria-hidden /></Button>
            </div>
            {form.range === "custom" && (
              <div className="grid gap-4 sm:grid-cols-2 md:col-span-2 xl:col-span-5 xl:max-w-xl">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted">From</span>
                  <input type="datetime-local" value={form.from} onChange={(e) => set("from", e.target.value)} className={input} />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted">To</span>
                  <input type="datetime-local" value={form.to} onChange={(e) => set("to", e.target.value)} className={input} />
                </label>
              </div>
            )}
          </form>
        </Card>

        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
            <p className="text-sm" aria-live="polite">
              {results ? (
                <>
                  <span className="font-medium tabular">{formatNumber(results.length)}</span> reads
                  {results.length >= MAX_RESULTS && <span className="text-muted"> (newest {MAX_RESULTS} shown, narrow the filters)</span>}
                </>
              ) : "Searching…"}
            </p>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <ScrollText size={13} aria-hidden /> This search was written to the audit log.
            </p>
          </div>
          {error ? (
            <div className="p-6"><ErrorState error={error} onRetry={() => run(form)} /></div>
          ) : !results ? (
            <LoadingBlock label="Searching" />
          ) : (
            <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <DataTable
                label="Plate reads"
                data={results}
                columns={columns}
                getRowId={(r) => r.readId}
                initialSort={[{ id: "capturedAt", desc: true }]}
                pageSize={20}
                empty={<EmptyState title="No reads match">Try a wider time range or fewer filters.</EmptyState>}
              />
            </div>
          )}
        </Card>
      </RevealGroup>

      <JustificationDialog
        open={revealTarget !== null}
        onClose={() => setRevealTarget(null)}
        title="Reveal this plate"
        description={revealTarget ? `Read ${revealTarget.readId} at ${revealTarget.cameraName}. The full plate is shown for 2 minutes, then masked again.` : undefined}
        label="Reason"
        placeholder="e.g. Security desk request: vehicle blocking the fire lane at P1."
        confirmLabel="Reveal plate"
        variant="gold"
        minLength={MIN_REASON_LENGTH}
        validate={validateRevealReason}
        onSubmit={reveal}
      />
    </>
  );
}
