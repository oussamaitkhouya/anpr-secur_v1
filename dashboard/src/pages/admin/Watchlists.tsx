import { useMemo, useState, useRef, type FormEvent } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { Upload, Trash2, Ban, ShieldAlert, FileText, CheckCircle2, Plus } from "lucide-react";
import { api } from "../../api/client";
import { useApi, useRequestContext } from "../../api/useApi";
import type { WatchlistList, WatchlistEntry, WatchlistImport } from "../../api/types";
import { useSession } from "../../app/session";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, RevealGroup } from "../../components/ui/Card";
import { DataTable } from "../../components/ui/DataTable";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader } from "../../components/ui/PageHeader";
import { LoadingBlock } from "../../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../../components/ui/States";
import { useToast } from "../../components/ui/toast";
import { formatDate } from "../../lib/format";
import { ApiError } from "../../api/errors";

const REASON_COLORS: Record<string, "gold" | "danger" | "neutral"> = {
  stolen: "danger",
  wanted: "gold",
  other: "neutral",
};

export default function Watchlists() {
  const watchlists = useApi((ctx) => api.getWatchlists(ctx));
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [importing, setImporting] = useState<WatchlistList | null>(null);
  const [managing, setManaging] = useState<WatchlistEntry | null>(null);
  const [adding, setAdding] = useState<WatchlistList | null>(null);

  const activeListId = selectedListId ?? watchlists.data?.lists[0]?.id;
  const activeList = watchlists.data?.lists.find((l) => l.id === activeListId);
  
  const entries = useMemo(() => {
    return watchlists.data?.entries.filter((e) => e.listId === activeListId) ?? [];
  }, [watchlists.data, activeListId]);

  const columns = useMemo(() => {
    const col = createColumnHelper<WatchlistEntry>();
    return [
      col.accessor("plate", {
        header: "Plate",
        cell: (c) => <span className="font-mono text-lg font-bold uppercase tracking-wider">{c.getValue()}</span>,
      }),
      col.accessor("reason", {
        header: "Reason",
        cell: (c) => <Badge tone={REASON_COLORS[c.getValue()] || "neutral"}>{c.getValue()}</Badge>,
      }),
      col.accessor("caseRef", {
        header: "Case Ref",
        cell: (c) => <span className="text-sm font-medium">{c.getValue() || "—"}</span>,
      }),
      col.accessor("source", {
        header: "Source",
        cell: (c) => <span className="text-sm text-muted">{c.getValue() || "—"}</span>,
      }),
      col.accessor("status", {
        header: "Status",
        cell: (c) => (
          c.getValue() === "active" ? <Badge tone="ok" dot>Active</Badge> :
          c.getValue() === "expired" ? <Badge tone="warn">Expired</Badge> :
          <Badge tone="neutral">Removed</Badge>
        ),
      }),
      col.accessor("addedAt", {
        header: "Added",
        cell: (c) => <span className="whitespace-nowrap text-xs text-muted">{formatDate(c.getValue())}</span>,
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row: { original: e } }) => (
          e.status === "active" ? (
            <span className="flex justify-end gap-1">
              <button onClick={() => setManaging(e)} className="focus-ring flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium text-danger hover:bg-danger-soft">
                Manage
              </button>
            </span>
          ) : null
        ),
      }),
    ];
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Watchlists"
        description="Manage stolen and wanted vehicles. Imported watchlists are automatically matched against ANPR detections to generate alerts."
      />

      {watchlists.error ? (
        <ErrorState error={watchlists.error} onRetry={watchlists.reload} />
      ) : !watchlists.data ? (
        <LoadingBlock className="rounded-lg border border-border bg-surface" label="Loading watchlists" />
      ) : watchlists.data.lists.length === 0 ? (
        <EmptyState title="No watchlists found">Contact your system administrator to configure lists.</EmptyState>
      ) : (
        <RevealGroup className="space-y-6">
          <div className="flex flex-wrap gap-2">
            {watchlists.data.lists.map((l) => (
              <button
                key={l.id}
                onClick={() => setSelectedListId(l.id)}
                className={`focus-ring rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                  l.id === activeListId ? "border-accent bg-accent text-white" : "border-border bg-surface text-muted hover:bg-bg-subtle hover:text-text"
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
          
          {activeList && (
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-border bg-bg-subtle p-4">
                <div>
                  <h3 className="font-medium">{activeList.name}</h3>
                  <p className="text-xs text-muted">
                    {entries.length} total entries • {entries.filter(e => e.status === 'active').length} active
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setAdding(activeList)}>
                    <Plus size={16} className="mr-1.5" /> Add Manually
                  </Button>
                  <Button variant="primary" onClick={() => setImporting(activeList)}>
                    <Upload size={16} className="mr-1.5" /> Import CSV/TXT
                  </Button>
                </div>
              </div>
              <DataTable
                label={`Entries in ${activeList.name}`}
                data={entries}
                columns={columns}
                getRowId={(e) => e.id}
                pageSize={20}
                empty={<EmptyState title="No entries">Upload a CSV to populate this list.</EmptyState>}
              />
            </Card>
          )}
        </RevealGroup>
      )}
      
      {importing && <ImportDialog list={importing} onClose={() => setImporting(null)} onDone={() => { setImporting(null); watchlists.reload(); }} />}
      {managing && <ManageEntryDialog entry={managing} onClose={() => setManaging(null)} onDone={() => { setManaging(null); watchlists.reload(); }} />}
      {adding && <AddEntryDialog list={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); watchlists.reload(); }} />}
    </>
  );
}

function ImportDialog({ list, onClose, onDone }: { list: WatchlistList; onClose: () => void; onDone: () => void }) {
  const ctx = useRequestContext();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError("Please select a CSV file first.");
    setBusy(true);
    setError(null);
    try {
      const csvText = await file.text();
      const result = await api.importWatchlist(ctx, { listId: list.id, fileName: file.name, csvText });
      toast({ tone: "success", title: "Import successful", body: `${result.rowsAccepted} rows added. ${result.rowsRejected} rejected.` });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? () => {} : onClose} title={`Import to ${list.name}`} width="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted mb-4">
          Upload a CSV containing: <code>plate,reason,color,make,model,vehicle_type,case_ref,source,expires_at</code>
        </p>
        <div className="flex items-center justify-center w-full">
          <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-border border-dashed rounded-lg cursor-pointer bg-bg-subtle hover:bg-surface transition-colors">
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              {file ? <CheckCircle2 className="w-8 h-8 mb-3 text-ok" /> : <FileText className="w-8 h-8 mb-3 text-muted" />}
              <p className="mb-2 text-sm text-text font-medium">{file ? file.name : "Click to upload CSV"}</p>
              <p className="text-xs text-muted">{file ? `${(file.size / 1024).toFixed(1)} KB` : "CSV or TXT (UTF-8) up to 10MB"}</p>
            </div>
            <input type="file" className="hidden" accept=".csv,.txt" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
        </div>
        {error && <p className="text-sm text-danger bg-danger-soft p-3 rounded-sm">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!file}><Upload size={15} /> Upload</Button>
        </div>
      </form>
    </Dialog>
  );
}

function ManageEntryDialog({ entry, onClose, onDone }: { entry: WatchlistEntry; onClose: () => void; onDone: () => void }) {
  const ctx = useRequestContext();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [action, setAction] = useState<"removed" | "expired">("removed");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.length < 10) return setError("Please provide a longer justification.");
    setBusy(true);
    setError(null);
    try {
      await api.setWatchlistEntryStatus(ctx, entry.id, action, reason);
      toast({ tone: "success", title: "Status updated", body: `Entry is now ${action}.` });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed");
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? () => {} : onClose} title={`Manage Plate: ${entry.plate}`} width="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <div className="p-4 bg-bg-subtle rounded-md border border-border">
          <p className="text-sm text-muted">Current status: <Badge tone="ok" dot>Active</Badge></p>
          <p className="text-sm text-muted mt-1">Listed for: <strong>{entry.reason}</strong></p>
        </div>
        
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">New Status</legend>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={action === "removed"} onChange={() => setAction("removed")} className="accent-accent" />
              <span className="text-sm">Remove (Error/Cleared)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={action === "expired"} onChange={() => setAction("expired")} className="accent-warn" />
              <span className="text-sm">Expire (Time elapsed)</span>
            </label>
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Justification</span>
          <textarea 
            value={reason} 
            onChange={(e) => setReason(e.target.value)} 
            className="w-full rounded-sm border border-border bg-surface p-3 text-sm focus-ring resize-none h-24"
            placeholder="Why is this entry being changed? (min 10 chars)"
          />
        </label>
        
        {error && <p className="text-sm text-danger bg-danger-soft p-3 rounded-sm">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant={action === "removed" ? "danger" : "primary"} loading={busy} disabled={reason.length < 10}>
            {action === "removed" ? <><Trash2 size={15} /> Remove</> : <><Ban size={15} /> Expire</>}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddEntryDialog({ list, onClose, onDone }: { list: WatchlistList; onClose: () => void; onDone: () => void }) {
  const ctx = useRequestContext();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [plateNum, setPlateNum] = useState("");
  const [plateLetter, setPlateLetter] = useState("أ");
  const [plateRegion, setPlateRegion] = useState("");
  
  const [reason, setReason] = useState<"stolen" | "wanted" | "other">("stolen");
  const [color, setColor] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [caseRef, setCaseRef] = useState("");
  
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!plateNum || !plateLetter || !plateRegion) return setError("Please fill all Moroccan plate fields.");
    setBusy(true);
    setError(null);
    try {
      const canonicalPlate = `${plateNum}|${plateLetter}|${plateRegion}`;
      await api.addWatchlistEntry(ctx, list.id, {
        plate: canonicalPlate,
        reason: reason as any,
        color: color || undefined,
        make: make || undefined,
        model: model || undefined,
        caseRef: caseRef || undefined,
      });
      toast({ tone: "success", title: "Plate added", body: `Added ${canonicalPlate} to ${list.name}.` });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add entry");
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? () => {} : onClose} title={`Add Plate to ${list.name}`} width="max-w-md">
      <form onSubmit={submit} className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Moroccan Plate Number</legend>
          <div className="flex gap-2 items-center bg-bg-subtle p-3 rounded-lg border border-border">
            <input
              type="text"
              value={plateNum}
              onChange={(e) => setPlateNum(e.target.value.replace(/\D/g, "").slice(0, 5))}
              className="w-24 text-center text-lg font-bold rounded-sm border border-border bg-surface p-2 focus-ring"
              placeholder="12345"
              required
            />
            <span className="text-xl text-muted font-light">|</span>
            <input
              type="text"
              value={plateLetter}
              onChange={(e) => setPlateLetter(e.target.value)}
              className="w-16 text-center text-lg font-bold rounded-sm border border-border bg-surface p-2 focus-ring"
              dir="rtl"
              required
            />
            <span className="text-xl text-muted font-light">|</span>
            <input
              type="text"
              value={plateRegion}
              onChange={(e) => setPlateRegion(e.target.value.replace(/\D/g, "").slice(0, 2))}
              className="w-16 text-center text-lg font-bold rounded-sm border border-border bg-surface p-2 focus-ring"
              placeholder="6"
              required
            />
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Reason</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as any)} className="w-full rounded-sm border border-border bg-surface p-2.5 text-sm focus-ring">
            <option value="stolen">Stolen</option>
            <option value="wanted">Wanted</option>
            <option value="other">Other</option>
          </select>
        </label>
        
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Make</span>
            <input type="text" value={make} onChange={(e) => setMake(e.target.value)} className="w-full rounded-sm border border-border bg-surface p-2.5 text-sm focus-ring" placeholder="e.g. Dacia" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Model</span>
            <input type="text" value={model} onChange={(e) => setModel(e.target.value)} className="w-full rounded-sm border border-border bg-surface p-2.5 text-sm focus-ring" placeholder="e.g. Logan" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Color</span>
            <input type="text" value={color} onChange={(e) => setColor(e.target.value)} className="w-full rounded-sm border border-border bg-surface p-2.5 text-sm focus-ring" placeholder="e.g. White" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Case Reference</span>
            <input type="text" value={caseRef} onChange={(e) => setCaseRef(e.target.value)} className="w-full rounded-sm border border-border bg-surface p-2.5 text-sm focus-ring" placeholder="Optional" />
          </label>
        </div>

        {error && <p className="text-sm text-danger bg-danger-soft p-3 rounded-sm">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}><Plus size={15} /> Add Plate</Button>
        </div>
      </form>
    </Dialog>
  );
}
