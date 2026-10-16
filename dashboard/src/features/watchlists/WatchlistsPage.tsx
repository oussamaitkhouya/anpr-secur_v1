/*
 * /admin/watchlists on real PostgreSQL data. Admins create lists, add or import plates, and
 * remove or expire entries with a written justification. Plates are validated here for fast
 * feedback and again by the server, which stores the canonical form cameras report.
 */
import { useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarClock, CheckCircle2, Download, FileSpreadsheet, ListChecks, Plus, Search, Trash2, Upload, XCircle } from "lucide-react";
import { ImportTimeline, ListCards, ListSummary, ReasonPill } from "./watchlistsUi";
import { ExpiryRadar, PlateWall, VaultHero, ViewToggle, type EntryView } from "./vault";
import { expiresSoon, REASON_STYLE } from "./reasons";
import { ApiError } from "../../api/errors";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { JustificationDialog } from "../../components/ui/JustificationDialog";
import { PlateText } from "../../components/ui/PlateText";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { formatDateTime, relativeTime } from "../../lib/format";
import { canonical, parsePlate } from "../../lib/plate";
import { MIN_JUSTIFICATION, templateCsv, useEntries, useImports, useWatchlistMutations, useWatchlists, type Entry, type EntryStatus, type ImportResult, type Reason, type Watchlist } from "./api";

const STATUS_TONE: Record<EntryStatus, "ok" | "neutral" | "warn"> = { active: "ok", expired: "warn", removed: "neutral" };
const VIEW_KEY = "anpr.watchlists.view";
/** Remembered per browser; storage can be unavailable (private mode), then the wall is the default. */
function readView(): EntryView {
  try { return localStorage.getItem(VIEW_KEY) === "table" ? "table" : "wall"; } catch { return "wall"; }
}
function writeView(v: EntryView) {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* not remembered */ }
}
const field = "focus-ring h-11 w-full rounded-sm border border-border bg-surface px-3 text-sm transition-colors focus:border-accent";

export default function WatchlistsPage() {
  const lists = useWatchlists();
  const [selected, setSelected] = useState<string | null>(null);
  const listId = selected ?? lists.data?.[0]?.id ?? null;
  const current = lists.data?.find((l) => l.id === listId) ?? null;
  const [dialog, setDialog] = useState<"list" | "entry" | "import" | null>(null);

  return (
    <>
      <VaultHero
        lists={lists.data}
        actions={
          <>
            <Button onClick={() => setDialog("list")}><ListChecks size={15} aria-hidden /> New watchlist</Button>
            {current && <Button onClick={() => setDialog("import")}><Upload size={15} aria-hidden /> Import CSV</Button>}
            {current && <Button variant="primary" onClick={() => setDialog("entry")}><Plus size={15} aria-hidden /> Add plate</Button>}
          </>
        }
      />
      {lists.error ? <ErrorState error={lists.error} onRetry={() => void lists.refetch()} />
        : !lists.data ? <div className="grid gap-6 lg:grid-cols-[280px_1fr]"><Skeleton className="h-60 rounded-lg" /><Skeleton className="h-96 rounded-lg" /></div>
        : !lists.data.length ? (
          <Card className="p-6"><EmptyState title="No watchlist yet" action={<Button variant="primary" onClick={() => setDialog("list")}>Create the first watchlist</Button>}>
            Create a list (for example "Stolen vehicles"), then add plates or import them from a CSV file.
          </EmptyState></Card>
        ) : (
          <>
            <ListCards lists={lists.data} selectedId={listId} onSelect={setSelected} />
            {current && <CurrentList key={current.id} list={current} onAdd={() => setDialog("entry")} />}
          </>
        )}
      <NewListDialog open={dialog === "list"} onClose={() => setDialog(null)} onCreated={(id) => setSelected(id)} />
      {current && <AddEntryDialog open={dialog === "entry"} onClose={() => setDialog(null)} listId={current.id} listName={current.name} />}
      {current && <ImportDialog open={dialog === "import"} onClose={() => setDialog(null)} listId={current.id} listName={current.name} />}
    </>
  );
}

function CurrentList({ list, onAdd }: { list: Watchlist; onAdd: () => void }) {
  const entries = useEntries(list.id);
  const imports = useImports(list.id);
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
      <ListSummary list={list} entries={entries.data} lastImport={imports.data?.[0]} />
      {entries.data && <ExpiryRadar entries={entries.data} />}
      <Entries listId={list.id} listName={list.name} onAdd={onAdd} />
    </motion.div>
  );
}

function Entries({ listId, listName, onAdd }: { listId: string; listName: string; onAdd: () => void }) {
  const entries = useEntries(listId);
  const imports = useImports(listId);
  const m = useWatchlistMutations(listId);
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<EntryStatus | "all">("active");
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [expiring, setExpiring] = useState<Entry | null>(null);
  const [view, setViewState] = useState<EntryView>(readView);
  const setView = (v: EntryView) => { setViewState(v); writeView(v); };

  const shown = useMemo(() => (entries.data ?? []).filter((e) =>
    (status === "all" || e.status === status)
    && (!q.trim() || `${e.plateCanonical} ${e.caseRef ?? ""} ${e.source ?? ""} ${e.make ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))), [entries.data, status, q]);
  const counts = useMemo(() => {
    const c: Record<EntryStatus | "all", number> = { active: 0, expired: 0, removed: 0, all: entries.data?.length ?? 0 };
    for (const e of entries.data ?? []) c[e.status]++;
    return c;
  }, [entries.data]);

  return (
    <section aria-label={`Entries of ${listName}`} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex h-11 min-w-48 flex-1 items-center gap-2 rounded-sm border border-border bg-surface/60 px-3.5 text-sm shadow-1 backdrop-blur transition-colors focus-within:border-accent sm:max-w-sm">
          <Search size={14} className="text-faint" aria-hidden /><span className="sr-only">Search entries</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Plate, case, source…" className="min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:font-sans placeholder:text-faint" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
        <ViewToggle view={view} onChange={setView} />
        <div role="tablist" aria-label="Entry status" className="inline-flex rounded-sm border border-border bg-surface/60 p-1 shadow-1 backdrop-blur">
          {(["active", "expired", "removed", "all"] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
              className={cn("focus-ring relative flex h-9 items-center gap-1.5 rounded-xs px-3.5 text-[13px] font-medium capitalize transition-colors", status === s ? "text-text" : "text-muted hover:text-text")}>
              {status === s && <motion.span layoutId="wl-status" className="absolute inset-0 rounded-xs bg-surface-raised shadow-1 ring-1 ring-border" transition={{ type: "spring", stiffness: 420, damping: 34 }} aria-hidden />}
              <span className="relative">{s}</span><span className="relative font-mono tabular">{counts[s]}</span>
            </button>
          ))}
        </div>
        </div>
      </div>

      {entries.error ? <ErrorState error={entries.error} onRetry={() => void entries.refetch()} />
        : !entries.data ? <div className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 rounded-md" />)}</div>
        : !shown.length ? (
          <Card className="p-6"><EmptyState title={entries.data.length ? "No entry matches" : "This list is empty"} action={!entries.data.length && <Button variant="primary" onClick={onAdd}>Add a plate</Button>}>
            {entries.data.length ? "Change the search or the status filter." : "Add plates one by one or import a CSV file."}
          </EmptyState></Card>
        ) : view === "wall" ? (
          <PlateWall entries={shown} query={q} onExpire={setExpiring} onRemove={setRemoving} />
        ) : (
          <div className="card-surface relative overflow-x-auto rounded-lg shadow-2">
            <table className="w-full min-w-[820px] text-sm">
              <thead><tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
                <th className="py-3.5 pl-5 pr-3">Plate</th><th className="px-3 py-3">Reason</th><th className="px-3 py-3">Case</th><th className="px-3 py-3">Vehicle</th>
                <th className="px-3 py-3">Added</th><th className="px-3 py-3">Expires</th><th className="px-3 py-3">Status</th><th className="px-3 py-3"><span className="sr-only">Actions</span></th>
              </tr></thead>
              <motion.tbody initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.02 } } }}>
                {shown.map((e) => (
                  <motion.tr key={e.id} variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }} className="group border-b border-border/60 transition-colors last:border-0 hover:bg-bg-subtle/50">
                    <td className="py-3 pl-5 pr-3"><PlateText value={e.plateCanonical} size="md" /></td>
                    <td className="px-3 py-3"><ReasonPill reason={e.reason} /></td>
                    <td className="px-3 py-2.5 font-mono text-xs">{e.caseRef ?? "—"}<span className="block font-sans text-[11px] text-muted">{e.source ?? ""}</span></td>
                    <td className="px-3 py-2.5 text-xs text-muted">{[e.color, e.make, e.model].filter(Boolean).join(" ") || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted tabular" title={formatDateTime(e.addedAt)}>{relativeTime(e.addedAt)}{e.importId && <span className="block text-[11px] text-faint">from CSV</span>}</td>
                    <td className="px-3 py-2.5 text-xs tabular">{e.expiresAt
                      ? expiresSoon(e) ? <span className="inline-flex items-center gap-1 rounded-full bg-gold-soft px-2 py-1 font-medium text-gold-strong" title={formatDateTime(e.expiresAt)}><CalendarClock size={12} aria-hidden />{relativeTime(e.expiresAt)}</span>
                      : formatDateTime(e.expiresAt) : <span className="text-faint">never</span>}</td>
                    <td className="px-3 py-2.5"><Badge tone={STATUS_TONE[e.status]} dot>{e.status}</Badge></td>
                    <td className="px-3 py-2.5 text-right">
                      {e.status !== "removed" && (
                        <span className="flex justify-end gap-1">
                          <button type="button" onClick={() => setExpiring(e)} title="Set expiry" className="focus-ring grid size-9 place-items-center rounded-sm border border-border text-muted transition-colors hover:border-border-strong hover:bg-bg-subtle hover:text-text" aria-label={`Set expiry for ${e.plateCanonical}`}><CalendarClock size={15} aria-hidden /></button>
                          <button type="button" onClick={() => setRemoving(e)} title="Remove" className="focus-ring grid size-9 place-items-center rounded-sm border border-border text-muted transition-colors hover:border-danger hover:bg-danger-soft hover:text-danger" aria-label={`Remove ${e.plateCanonical}`}><Trash2 size={15} aria-hidden /></button>
                        </span>
                      )}
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        )}

      {!!imports.data?.length && (
        <Card className="p-6">
          <h3 className="mb-5 flex items-center gap-2 font-display text-base font-semibold"><FileSpreadsheet size={16} className="text-accent" aria-hidden /> Import history</h3>
          <ImportTimeline imports={imports.data} />
        </Card>
      )}

      <JustificationDialog
        open={!!removing} onClose={() => setRemoving(null)}
        title={`Remove ${removing?.plateCanonical ?? ""} from ${listName}?`}
        description="It stops raising alerts immediately. The entry stays in the history; the audit log records who removed it and why."
        label="Justification" placeholder="e.g. Vehicle recovered by its owner; case closed." confirmLabel="Remove" variant="danger" minLength={MIN_JUSTIFICATION}
        onSubmit={async (justification) => {
          await m.removeEntry.mutateAsync({ entryId: removing!.id, justification });
          toast({ tone: "success", title: "Plate removed from the watchlist" });
        }}
      />
      <ExpireDialog entry={expiring} onClose={() => setExpiring(null)} onSubmit={async (expiresAt, justification) => {
        await m.expireEntry.mutateAsync({ entryId: expiring!.id, expiresAt, justification });
        toast({ tone: "success", title: "Expiry set" });
      }} />
    </section>
  );
}

function ExpireDialog({ entry, onClose, onSubmit }: { entry: Entry | null; onClose: () => void; onSubmit: (expiresAt: string, justification: string) => Promise<void> }) {
  const base = useId();
  const [date, setDate] = useState("");
  const [why, setWhy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setDate(""); setWhy(""); setError(null); onClose(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!date) return setError("Choose the date the entry stops raising alerts.");
    if (why.trim().length < MIN_JUSTIFICATION) return setError(`Write a justification of at least ${MIN_JUSTIFICATION} characters.`);
    setBusy(true);
    try {
      await onSubmit(new Date(`${date}T23:59:59`).toISOString(), why.trim());
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Saving failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!entry} onClose={close} title={`Set expiry · ${entry?.plateCanonical ?? ""}`} description="After this date the plate no longer raises alerts. A date in the past expires it now.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div><label htmlFor={`${base}-d`} className="mb-1.5 block text-sm font-medium">Expires at the end of</label><input id={`${base}-d`} type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} /></div>
        <div><label htmlFor={`${base}-j`} className="mb-1.5 block text-sm font-medium">Justification</label><textarea id={`${base}-j`} value={why} onChange={(e) => setWhy(e.target.value)} rows={3} maxLength={1000} className={cn(field, "h-auto py-2")} /></div>
        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={close}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Set expiry</Button></div>
      </form>
    </Dialog>
  );
}

function NewListDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const base = useId();
  const m = useWatchlistMutations(null);
  const toast = useToast();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => { setName(""); setSource(""); setError(null); onClose(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !source.trim()) return setError("Enter the list name and where its plates come from.");
    try {
      const wl = await m.createList.mutateAsync({ name: name.trim(), source: source.trim() });
      toast({ tone: "success", title: "Watchlist created", body: wl.name });
      onCreated(wl.id);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Saving failed.");
    }
  };
  return (
    <Dialog open={open} onClose={close} title="New watchlist">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div><label htmlFor={`${base}-n`} className="mb-1.5 block text-sm font-medium">Name</label><input id={`${base}-n`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Stolen vehicles" className={field} /></div>
        <div><label htmlFor={`${base}-s`} className="mb-1.5 block text-sm font-medium">Source</label><input id={`${base}-s`} value={source} onChange={(e) => setSource(e.target.value)} maxLength={120} placeholder="e.g. DGSN national stolen-vehicle file" className={field} /></div>
        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={close}>Cancel</Button><Button type="submit" variant="primary" loading={m.createList.isPending}>Create</Button></div>
      </form>
    </Dialog>
  );
}

function AddEntryDialog({ open, onClose, listId, listName }: { open: boolean; onClose: () => void; listId: string; listName: string }) {
  const base = useId();
  const m = useWatchlistMutations(listId);
  const toast = useToast();
  const [f, setF] = useState({ plate: "", reason: "stolen" as Reason, caseRef: "", source: "", color: "", make: "", model: "", expires: "" });
  const [error, setError] = useState<string | null>(null);
  const parsed = f.plate.trim() ? parsePlate(f.plate) : null;
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setError(null); };
  const close = () => { setF({ plate: "", reason: "stolen", caseRef: "", source: "", color: "", make: "", model: "", expires: "" }); setError(null); onClose(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed) return setError("Enter a valid Moroccan plate: number, letter, region (e.g. 12345 أ 6).");
    const opt = (v: string) => v.trim() || undefined;
    try {
      await m.addEntry.mutateAsync({
        plate: canonical(parsed), reason: f.reason, caseRef: opt(f.caseRef), source: opt(f.source), color: opt(f.color), make: opt(f.make),
        model: opt(f.model), expiresAt: f.expires ? new Date(`${f.expires}T23:59:59`).toISOString() : undefined,
      });
      toast({ tone: "success", title: "Plate added", body: `${canonical(parsed)} · ${listName}` });
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Saving failed.");
    }
  };
  return (
    <Dialog open={open} onClose={close} width="max-w-xl" title={`Add a plate · ${listName}`} description="It raises an alert the next time a camera reads it. A person still decides every alert.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor={`${base}-p`} className="mb-1.5 block text-sm font-medium">Plate</label>
          <input id={`${base}-p`} value={f.plate} onChange={(e) => set("plate", e.target.value)} placeholder="12345 أ 6" dir="ltr" className={cn(field, "font-mono text-base")} autoComplete="off" />
          <p className="mt-1.5 flex items-center gap-2 text-xs" aria-live="polite">
            {!f.plate.trim() ? <span className="text-muted">Number, Arabic letter, region. Spaces, dashes or | all work.</span>
              : parsed ? <><CheckCircle2 size={13} className="text-ok" aria-hidden /><span className="text-ok">Stored as</span> <motion.span key={canonical(parsed)} initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}><PlateText value={canonical(parsed)} size="md" /></motion.span></>
              : <><XCircle size={13} className="text-danger" aria-hidden /><span className="text-danger">Not a valid Moroccan plate yet.</span></>}
          </p>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Reason</legend>
          <div className="flex gap-2">
            {(Object.keys(REASON_STYLE) as Reason[]).map((r) => {
              const st = REASON_STYLE[r];
              const on = f.reason === r;
              return (
                <label key={r} className={cn("focus-within:shadow-[0_0_0_3px_var(--ring)] flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-sm border text-sm font-medium transition-colors", on ? "text-text shadow-1" : "border-border text-muted hover:text-text")}
                  style={on ? { borderColor: st.color, background: `color-mix(in oklab, ${st.color} 12%, transparent)` } : undefined}>
                  <input type="radio" name={`${base}-r`} className="sr-only" checked={on} onChange={() => set("reason", r)} />
                  <st.icon size={15} style={{ color: st.color }} aria-hidden />{st.label}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor={`${base}-c`} className="mb-1.5 block text-sm font-medium">Case reference</label><input id={`${base}-c`} value={f.caseRef} onChange={(e) => set("caseRef", e.target.value)} maxLength={60} className={cn(field, "font-mono")} /></div>
          <div><label htmlFor={`${base}-s`} className="mb-1.5 block text-sm font-medium">Source</label><input id={`${base}-s`} value={f.source} onChange={(e) => set("source", e.target.value)} maxLength={120} className={field} /></div>
          <div><label htmlFor={`${base}-col`} className="mb-1.5 block text-sm font-medium">Colour</label><input id={`${base}-col`} value={f.color} onChange={(e) => set("color", e.target.value)} maxLength={30} className={field} /></div>
          <div><label htmlFor={`${base}-mk`} className="mb-1.5 block text-sm font-medium">Make and model</label>
            <span className="flex gap-2"><input aria-label="Make" value={f.make} onChange={(e) => set("make", e.target.value)} maxLength={40} placeholder="Make" className={field} /><input aria-label="Model" value={f.model} onChange={(e) => set("model", e.target.value)} maxLength={40} placeholder="Model" className={field} /></span></div>
          <div><label htmlFor={`${base}-e`} className="mb-1.5 block text-sm font-medium">Expires (optional)</label><input id={`${base}-e`} type="date" value={f.expires} onChange={(e) => set("expires", e.target.value)} className={field} /></div>
        </div>
        <p className="text-xs text-muted">Colour, make and model help spot cloned plates: a listed plate on a different vehicle is flagged for the reviewer.</p>
        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={close}>Cancel</Button><Button type="submit" variant="primary" loading={m.addEntry.isPending}>Add plate</Button></div>
      </form>
    </Dialog>
  );
}

function ImportDialog({ open, onClose, listId, listName }: { open: boolean; onClose: () => void; listId: string; listName: string }) {
  const m = useWatchlistMutations(listId);
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const reset = () => { setFile(null); setPreview(null); setError(null); };
  const close = () => { reset(); onClose(); };
  const choose = async (f?: File) => {
    if (!f) return;
    reset();
    if (!f.name.toLowerCase().endsWith(".csv")) return setError("Choose a .csv file.");
    setFile(f);
    try {
      setPreview(await m.importCsv.mutateAsync({ file: f, mode: "preview" }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The file could not be checked.");
    }
  };
  const confirm = async () => {
    try {
      const r = await m.importCsv.mutateAsync({ file: file!, mode: "confirm" });
      toast({ tone: "success", title: `${r.rowsAccepted} plate${r.rowsAccepted === 1 ? "" : "s"} imported`, body: `Version ${r.version} · SHA-256 recorded in the audit log.` });
      close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Import failed.");
    }
  };
  const download = async () => {
    const url = URL.createObjectURL(new Blob([await templateCsv(listId)], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: "watchlist_template.csv" }).click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog open={open} onClose={close} width="max-w-3xl" title={`Import plates · ${listName}`} description="Check first, then confirm. Bad rows are listed with the reason and never block the good ones. The same file cannot be imported twice.">
      <div className="space-y-4">
        {!preview && (
          <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e: DragEvent) => { e.preventDefault(); setOver(false); void choose(e.dataTransfer.files[0]); }}
            className={cn("flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors", over ? "border-accent bg-accent-soft/60" : "border-border-strong")}>
            <span className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent"><Upload size={24} aria-hidden /></span>
            <p className="font-medium">Drop a CSV file here</p>
            <Button onClick={() => input.current?.click()} loading={m.importCsv.isPending}><FileSpreadsheet size={14} aria-hidden /> Choose a file</Button>
            <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => void choose(e.target.files?.[0])} />
          </div>
        )}
        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <AnimatePresence>
          {preview && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3" data-testid="wl-preview">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium">{preview.fileName}</span>
                <span className="flex items-center gap-1 text-ok"><CheckCircle2 size={14} aria-hidden />{preview.rowsAccepted} accepted</span>
                <span className={cn("flex items-center gap-1", preview.rowsRejected ? "text-danger" : "text-muted")}><XCircle size={14} aria-hidden />{preview.rowsRejected} rejected</span>
              </div>
              <div className="max-h-72 overflow-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-raised text-left text-[11px] uppercase tracking-[0.12em] text-muted"><tr><th className="px-3 py-2">Line</th><th className="px-3 py-2">Plate</th><th className="px-3 py-2">Result</th></tr></thead>
                  <tbody>
                    {preview.rejected.map((r) => (
                      <tr key={`r${r.line}`} className="border-t border-border bg-danger-soft/40"><td className="px-3 py-2 font-mono text-xs">{r.line}</td><td className="px-3 py-2 font-mono text-xs">{r.plate || "—"}</td>
                        <td className="px-3 py-2 text-xs text-danger"><ul className="list-disc pl-4">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul></td></tr>
                    ))}
                    {preview.accepted.map((r) => (
                      <tr key={`a${r.line}`} className="border-t border-border"><td className="px-3 py-2 font-mono text-xs">{r.line}</td><td className="px-3 py-2"><PlateText value={r.plateCanonical} size="sm" /></td>
                        <td className="px-3 py-2 text-xs text-ok">Will be added · {REASON_STYLE[r.reason].label}{r.caseRef ? ` · ${r.caseRef}` : ""}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => void download()}><Download size={14} aria-hidden /> Download template</Button>
          <div className="flex gap-2">
            {preview && <Button onClick={reset}>Choose another file</Button>}
            {preview && <Button variant="primary" onClick={confirm} loading={m.importCsv.isPending} disabled={!preview.rowsAccepted}>Import {preview.rowsAccepted} plate{preview.rowsAccepted === 1 ? "" : "s"}</Button>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
