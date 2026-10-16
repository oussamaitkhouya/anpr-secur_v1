import { useId, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Globe2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { ApiError } from "../../api/errors";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { cityHealth } from "./logic";
import { HealthRing } from "./ui";
import type { RegistryCamera, RegistryCity } from "./types";

export function CityRail({ cities, cameras, selected, onSelect, canWrite, onCreate, onUpdate, onDelete }: {
  cities: RegistryCity[] | undefined;
  cameras: RegistryCamera[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  canWrite: boolean;
  onCreate: (v: { name: string; region: string }) => Promise<unknown>;
  onUpdate: (v: { id: string; name: string; region: string }) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<RegistryCity | "new" | null>(null);
  const [deleting, setDeleting] = useState<RegistryCity | null>(null);
  const toast = useToast();
  const list = (cities ?? []).filter((c) => `${c.name} ${c.region}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <aside aria-label="Cities" className="card-surface relative flex flex-col rounded-lg p-4 lg:sticky lg:top-[calc(var(--topbar-h)+1.5rem)] lg:max-h-[calc(100vh-var(--topbar-h)-3rem)]">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="font-display text-base font-semibold">Cities</h2>
        {canWrite && <Button size="sm" variant="primary" onClick={() => setEditing("new")}><Plus size={14} aria-hidden /> Add city</Button>}
      </div>
      <label className="mt-3 flex h-9 items-center gap-2 rounded-full border border-border bg-surface/60 px-3 text-sm focus-within:border-accent">
        <Search size={14} className="text-faint" aria-hidden />
        <span className="sr-only">Search cities</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cities…" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
      </label>

      <ul className="-mx-1 mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1 pb-1">
        <li>
          <RailItem active={selected === null} onClick={() => onSelect(null)} title="All cities" subtitle={`${cameras.length} cameras`} health={cityHealth(cameras)} icon />
        </li>
        {!cities ? Array.from({ length: 3 }, (_, i) => <li key={i}><Skeleton className="h-16 rounded-md" /></li>) : (
          <AnimatePresence initial={false}>
            {list.map((c, i) => {
              const mine = cameras.filter((x) => x.cityId === c.id);
              return (
                <motion.li key={c.id} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0, transition: { delay: i * 0.03 } }} exit={{ opacity: 0 }} className="group relative">
                  <RailItem active={selected === c.id} onClick={() => onSelect(c.id)} title={c.name} subtitle={`${c.region} · ${mine.length} camera${mine.length === 1 ? "" : "s"}`} health={cityHealth(mine)} />
                  {canWrite && (
                    <span className="absolute right-2 top-2 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <button type="button" onClick={() => setEditing(c)} className="focus-ring grid size-7 place-items-center rounded-xs text-faint hover:bg-bg-subtle hover:text-text" aria-label={`Rename ${c.name}`}><Pencil size={13} aria-hidden /></button>
                      <button type="button" onClick={() => setDeleting(c)} className="focus-ring grid size-7 place-items-center rounded-xs text-faint hover:bg-danger-soft hover:text-danger" aria-label={`Delete ${c.name}`}><Trash2 size={13} aria-hidden /></button>
                    </span>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        )}
        {cities && !list.length && <li className="px-2 py-6 text-center text-sm text-muted">{cities.length ? "No city matches." : "No cities yet."}</li>}
      </ul>

      <CityDialog
        city={editing}
        onClose={() => setEditing(null)}
        onSubmit={async (v) => {
          if (editing === "new") await onCreate(v);
          else if (editing) await onUpdate({ id: editing.id, ...v });
          toast({ tone: "success", title: editing === "new" ? "City added" : "City updated", body: v.name });
          setEditing(null);
        }}
      />
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title={`Delete ${deleting?.name ?? ""}?`} description="Only possible when the city has no cameras and no analysts assigned. This is recorded in the audit log.">
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={async () => {
            const city = deleting!;
            try {
              await onDelete(city.id);
              toast({ tone: "success", title: "City deleted", body: city.name });
              if (selected === city.id) onSelect(null);
            } catch (e) {
              toast({ tone: "error", title: "Could not delete the city", body: e instanceof ApiError ? e.message : undefined });
            }
            setDeleting(null);
          }}>Delete city</Button>
        </div>
      </Dialog>
    </aside>
  );
}

function RailItem({ active, onClick, title, subtitle, health, icon }: { active: boolean; onClick: () => void; title: string; subtitle: string; health: number | null; icon?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "focus-ring flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-all",
        active ? "border-accent/60 bg-[linear-gradient(90deg,var(--accent-soft),transparent)] shadow-1" : "border-transparent hover:border-border hover:bg-bg-subtle/60",
      )}
    >
      {icon ? <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><Globe2 size={18} aria-hidden /></span> : <HealthRing value={health} />}
      <span className="min-w-0 flex-1 pr-12">
        <span className="block truncate text-sm font-semibold">{title}</span>
        <span className="block truncate text-xs text-muted">{subtitle}</span>
      </span>
    </button>
  );
}

function CityDialog({ city, onClose, onSubmit }: { city: RegistryCity | "new" | null; onClose: () => void; onSubmit: (v: { name: string; region: string }) => Promise<void> }) {
  const open = city !== null;
  const base = useId();
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCity, setLastCity] = useState<typeof city>(null);
  if (city !== lastCity) {
    setLastCity(city);
    setName(city && city !== "new" ? city.name : "");
    setRegion(city && city !== "new" ? city.region : "");
    setError(null);
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !region.trim()) return setError("Enter the city name and its region.");
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), region: region.trim() });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Saving failed.");
    } finally {
      setBusy(false);
    }
  };
  const field = "focus-ring h-10 w-full rounded-sm border border-border bg-surface px-3 text-sm";
  return (
    <Dialog open={open} onClose={onClose} title={city === "new" ? "Add a city" : "Edit city"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div><label htmlFor={`${base}-n`} className="mb-1.5 block text-sm font-medium">Name</label><input id={`${base}-n`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={field} /></div>
        <div><label htmlFor={`${base}-r`} className="mb-1.5 block text-sm font-medium">Region</label><input id={`${base}-r`} value={region} onChange={(e) => setRegion(e.target.value)} maxLength={80} className={field} placeholder="e.g. Rabat-Salé-Kénitra" /></div>
        {error && <p role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Dialog>
  );
}
