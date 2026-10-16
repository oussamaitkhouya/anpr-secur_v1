import { useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Columns3, KeyRound, LayoutGrid, MoreHorizontal, Pencil, Plug, Rows3, Search, Trash2, Wrench, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { relativeTime } from "../../lib/format";
import { readPref, writePref } from "../../lib/storage";
import { useDismiss } from "../../lib/useDismiss";
import { cn } from "../../lib/cn";
import { KIND_LABELS, PROTOCOL_LABELS, STATUS_LABELS } from "./logic";
import { CredentialsChip, EmptyArt, KindIcon, ProtocolBadge, StatusChip, TlsBadge } from "./ui";
import { CAMERA_KINDS, CAMERA_PROTOCOLS, CAMERA_STATUSES, type CameraKind, type CameraProtocol, type CameraStatus, type RegistryCamera } from "./types";

export type RowAction = "edit" | "test" | "credentials" | "maintenance" | "delete";

const OPTIONAL_COLUMNS = { city: "City", protocol: "Protocol", lastFrame: "Last frame", tls: "TLS", credentials: "Credentials", host: "Host" } as const;
type Column = keyof typeof OPTIONAL_COLUMNS;
const DEFAULT_COLUMNS: Column[] = ["city", "protocol", "lastFrame", "tls", "credentials"];

function loadColumns(): Column[] {
  try {
    const saved = JSON.parse(readPref("cameras.columns") ?? "null");
    if (Array.isArray(saved)) return saved.filter((c): c is Column => c in OPTIONAL_COLUMNS);
  } catch {
    // ignore a malformed preference
  }
  return DEFAULT_COLUMNS;
}

export function CamerasTab({ cameras, cityName, canWrite, onOpen, onAction, onBulk, onAdd, emptyHint }: {
  cameras: RegistryCamera[];
  cityName: (id: string) => string;
  canWrite: boolean;
  onOpen: (id: string) => void;
  onAction: (action: RowAction, camera: RegistryCamera) => void;
  onBulk: (action: "maintenance" | "test" | "delete", cameras: RegistryCamera[]) => void;
  onAdd?: () => void;
  emptyHint: string;
}) {
  const [view, setView] = useState<"table" | "grid">(() => (readPref("cameras.view") === "grid" ? "grid" : "table"));
  const [columns, setColumns] = useState<Column[]>(loadColumns);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<CameraStatus | "">("");
  const [kind, setKind] = useState<CameraKind | "">("");
  const [protocol, setProtocol] = useState<CameraProtocol | "">("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const shown = useMemo(() => cameras.filter((c) =>
    (!status || c.status === status) && (!kind || c.kind === kind) && (!protocol || c.protocol === protocol)
    && (!q.trim() || `${c.name} ${c.district ?? ""} ${c.host ?? ""} ${cityName(c.cityId)}`.toLowerCase().includes(q.trim().toLowerCase())),
  ).sort((a, b) => a.name.localeCompare(b.name)), [cameras, status, kind, protocol, q, cityName]);

  const chosen = shown.filter((c) => selected.has(c.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allChecked = shown.length > 0 && chosen.length === shown.length;
  const setViewSaved = (v: "table" | "grid") => { setView(v); writePref("cameras.view", v); };
  const setColumnsSaved = (cols: Column[]) => { setColumns(cols); writePref("cameras.columns", JSON.stringify(cols)); };
  const filtered = !!(q || status || kind || protocol);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="flex h-9 min-w-48 flex-1 items-center gap-2 rounded-full border border-border bg-surface/60 px-3 text-sm focus-within:border-accent sm:max-w-xs">
          <Search size={14} className="text-faint" aria-hidden />
          <span className="sr-only">Search cameras</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, district, host…" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
        </label>
        <Filter label="Status" value={status} onChange={setStatus} options={CAMERA_STATUSES.map((s) => [s, STATUS_LABELS[s]])} />
        <Filter label="Type" value={kind} onChange={setKind} options={CAMERA_KINDS.map((k) => [k, KIND_LABELS[k]])} />
        <Filter label="Protocol" value={protocol} onChange={setProtocol} options={CAMERA_PROTOCOLS.map((p) => [p, PROTOCOL_LABELS[p]])} />
        {filtered && <Button size="sm" variant="ghost" onClick={() => { setQ(""); setStatus(""); setKind(""); setProtocol(""); }}><X size={13} aria-hidden /> Clear</Button>}
        <span className="ml-auto flex items-center gap-1">
          {view === "table" && <ColumnPicker columns={columns} onChange={setColumnsSaved} />}
          <span className="flex rounded-full border border-border p-0.5" role="group" aria-label="View">
            {(["table", "grid"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setViewSaved(v)} aria-pressed={view === v} className={cn("focus-ring grid size-8 place-items-center rounded-full transition-colors", view === v ? "bg-accent-soft text-accent" : "text-muted hover:text-text")} aria-label={v === "table" ? "Table view" : "Card view"}>
                {v === "table" ? <Rows3 size={15} aria-hidden /> : <LayoutGrid size={15} aria-hidden />}
              </button>
            ))}
          </span>
        </span>
      </div>

      <AnimatePresence>
        {canWrite && chosen.length > 0 && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="glass mb-3 flex flex-wrap items-center gap-2 rounded-md px-4 py-2.5 shadow-2" role="region" aria-label="Bulk actions">
            <span className="text-sm font-medium">{chosen.length} selected</span>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <Button size="sm" onClick={() => onBulk("test", chosen)}><Plug size={13} aria-hidden /> Test connection</Button>
            <Button size="sm" onClick={() => onBulk("maintenance", chosen)}><Wrench size={13} aria-hidden /> Maintenance mode</Button>
            <Button size="sm" variant="danger" onClick={() => onBulk("delete", chosen)}><Trash2 size={13} aria-hidden /> Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} className="ml-auto">Clear selection</Button>
          </motion.div>
        )}
      </AnimatePresence>

      {!shown.length ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed border-border-strong px-6 py-14 text-center">
          <EmptyArt />
          <p className="mt-3 font-display text-lg">{filtered ? "No camera matches these filters" : "No cameras here yet"}</p>
          <p className="mt-1 max-w-md text-sm text-muted">{filtered ? "Change or clear the filters." : emptyHint}</p>
          {!filtered && onAdd && <Button variant="primary" className="mt-5" onClick={onAdd}>Add a camera</Button>}
        </div>
      ) : view === "table" ? (
        <div className="card-surface relative overflow-x-auto rounded-lg">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                {canWrite && (
                  <th className="w-10 py-3 pl-4">
                    <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(shown.map((c) => c.id)))} aria-label="Select all shown cameras" className="accent-[var(--accent)]" />
                  </th>
                )}
                <th className="py-3 pl-4 pr-3">Camera</th>
                <th className="px-3 py-3">Status</th>
                {columns.map((c) => <th key={c} className="px-3 py-3">{OPTIONAL_COLUMNS[c]}</th>)}
                <th className="w-12 px-3 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <motion.tbody initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.025 } } }}>
              {shown.map((c) => (
                <motion.tr key={c.id} variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }} className={cn("group border-b border-border/60 transition-colors last:border-0 hover:bg-bg-subtle/50", selected.has(c.id) && "bg-accent-soft/40")}>
                  {canWrite && <td className="py-3 pl-4"><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} className="accent-[var(--accent)]" /></td>}
                  <td className="py-3 pl-4 pr-3">
                    <button type="button" onClick={() => onOpen(c.id)} className="focus-ring flex items-center gap-3 rounded-xs text-left">
                      <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent transition-transform group-hover:scale-105"><KindIcon kind={c.kind} /></span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium hover:text-accent">{c.name}</span>
                        <span className="block truncate text-xs text-muted">{KIND_LABELS[c.kind]}{c.district ? ` · ${c.district}` : ""}</span>
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-3"><StatusChip status={c.status} /></td>
                  {columns.map((col) => (
                    <td key={col} className="px-3 py-3">
                      {col === "city" && <span className="text-muted">{cityName(c.cityId)}</span>}
                      {col === "protocol" && <ProtocolBadge protocol={c.protocol} />}
                      {col === "lastFrame" && <span className="whitespace-nowrap text-xs text-muted tabular">{c.lastFrameAt ? relativeTime(c.lastFrameAt) : "Never"}</span>}
                      {col === "tls" && <TlsBadge tlsNotAfter={c.tlsNotAfter} compact />}
                      {col === "credentials" && <CredentialsChip set={c.credentialsSet} protocol={c.protocol} />}
                      {col === "host" && <span className="font-mono text-xs text-muted">{c.host ?? "—"}{c.port ? `:${c.port}` : ""}</span>}
                    </td>
                  ))}
                  <td className="px-3 py-3 text-right">{canWrite && <RowMenu camera={c} onAction={onAction} />}</td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      ) : (
        <motion.ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }}>
          {shown.map((c) => (
            <motion.li key={c.id} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} whileHover={{ y: -3 }} className={cn("card-surface relative rounded-lg p-4", selected.has(c.id) && "ring-2 ring-accent")}>
              <div className="flex items-start justify-between gap-2">
                <button type="button" onClick={() => onOpen(c.id)} className="focus-ring flex min-w-0 items-center gap-3 rounded-xs text-left">
                  <span className="grid size-11 shrink-0 place-items-center rounded-[12px] bg-accent-soft text-accent"><KindIcon kind={c.kind} size={19} /></span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{c.name}</span>
                    <span className="block truncate text-xs text-muted">{cityName(c.cityId)}{c.district ? ` · ${c.district}` : ""}</span>
                  </span>
                </button>
                <span className="flex items-center gap-1">
                  {canWrite && <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name}`} className="accent-[var(--accent)]" />}
                  {canWrite && <RowMenu camera={c} onAction={onAction} />}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2"><StatusChip status={c.status} /><ProtocolBadge protocol={c.protocol} /><CredentialsChip set={c.credentialsSet} protocol={c.protocol} /></div>
              <div className="mt-3 flex items-center justify-between text-xs text-muted">
                <span className="tabular">Last frame {c.lastFrameAt ? relativeTime(c.lastFrameAt) : "never"}</span>
                <TlsBadge tlsNotAfter={c.tlsNotAfter} />
              </div>
            </motion.li>
          ))}
        </motion.ul>
      )}
      <p className="mt-3 text-xs text-muted tabular">{shown.length} of {cameras.length} cameras</p>
    </div>
  );
}

function Filter<T extends string>({ label, value, onChange, options }: { label: string; value: T | ""; onChange: (v: T | "") => void; options: [T, string][] }) {
  return (
    <label className={cn("flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs", value ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")}>
      <span className="font-medium">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T | "")} className="bg-transparent font-medium text-text outline-none">
        <option value="">All</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function ColumnPicker({ columns, onChange }: { columns: Column[]; onChange: (c: Column[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="focus-ring grid size-9 place-items-center rounded-full border border-border text-muted hover:text-text" aria-label="Choose columns">
        <Columns3 size={15} aria-hidden />
      </button>
      {open && (
        <div className="glass absolute right-0 top-11 z-30 w-48 rounded-md p-2 shadow-3">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Columns</p>
          {(Object.keys(OPTIONAL_COLUMNS) as Column[]).map((c) => (
            <label key={c} className="flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-sm hover:bg-bg-subtle">
              <input type="checkbox" checked={columns.includes(c)} onChange={() => onChange(columns.includes(c) ? columns.filter((x) => x !== c) : (Object.keys(OPTIONAL_COLUMNS) as Column[]).filter((x) => x === c || columns.includes(x)))} className="accent-[var(--accent)]" />
              {OPTIONAL_COLUMNS[c]}
            </label>
          ))}
          <p className="px-2 pt-1 text-[11px] text-faint">Remembered in this browser.</p>
        </div>
      )}
    </div>
  );
}

function RowMenu({ camera, onAction }: { camera: RegistryCamera; onAction: (a: RowAction, c: RegistryCamera) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const items: [RowAction, string, typeof Pencil, string?][] = [
    ["edit", "Edit", Pencil],
    ["test", "Test connection", Plug],
    ["credentials", camera.credentialsSet ? "Replace credentials" : "Add credentials", KeyRound],
    ["maintenance", camera.status === "maintenance" ? "End maintenance" : "Maintenance mode", Wrench],
    ["delete", "Delete", Trash2, "text-danger"],
  ];
  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="focus-ring grid size-8 place-items-center rounded-full text-muted hover:bg-bg-subtle hover:text-text" aria-label={`Actions for ${camera.name}`}>
        <MoreHorizontal size={16} aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div role="menu" initial={{ opacity: 0, scale: 0.96, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.14 }} className="glass absolute right-0 top-9 z-30 w-52 origin-top-right rounded-md p-1.5 text-left shadow-3">
            {items.map(([a, label, Icon, cls]) => (
              <button key={a} role="menuitem" type="button" onClick={() => { close(); onAction(a, camera); }} className={cn("focus-ring flex w-full items-center gap-2.5 rounded-xs px-3 py-2 text-sm hover:bg-bg-subtle", cls ?? "text-text")}>
                <Icon size={14} aria-hidden /> {label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
