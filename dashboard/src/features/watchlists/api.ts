/* Watchlists on the PostgreSQL API (src/anpr/api/routes/watchlists.py). Real data only. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { v1 } from "../../api/v1";

export type Reason = "stolen" | "wanted" | "other";
export type EntryStatus = "active" | "expired" | "removed";

export interface Watchlist {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  activeEntries: number;
}

export interface Entry {
  id: string;
  listId: string;
  importId: string | null;
  plateCanonical: string;
  reason: Reason;
  color: string | null;
  make: string | null;
  model: string | null;
  vehicleType: string | null;
  caseRef: string | null;
  source: string | null;
  addedAt: string;
  expiresAt: string | null;
  removedAt: string | null;
  status: EntryStatus;
}

export interface EntryInput {
  plate: string;
  reason: Reason;
  color?: string;
  make?: string;
  model?: string;
  vehicleType?: string;
  caseRef?: string;
  source?: string;
  expiresAt?: string;
}

export interface ImportResult {
  mode: "preview" | "confirm";
  fileName: string;
  sha256: string;
  rowsTotal: number;
  rowsAccepted: number;
  rowsRejected: number;
  accepted: { line: number; plateCanonical: string; reason: Reason; caseRef: string | null }[];
  rejected: { line: number; plate: string; reasons: string[] }[];
  importId: string | null;
  version: number | null;
}

export interface ImportRecord {
  id: string;
  fileName: string;
  sha256: string;
  rowsTotal: number;
  rowsAccepted: number;
  rowsRejected: number;
  importedAt: string;
  version: number;
}

export const MIN_JUSTIFICATION = 20;
const id = encodeURIComponent;
export const wlKeys = {
  lists: ["wl", "lists"] as const,
  entries: (listId: string) => ["wl", "entries", listId] as const,
  imports: (listId: string) => ["wl", "imports", listId] as const,
};

export const useWatchlists = () => useQuery({ queryKey: wlKeys.lists, queryFn: () => v1.call<Watchlist[]>("GET", "/watchlists") });
export const useEntries = (listId: string | null) =>
  useQuery({ queryKey: wlKeys.entries(listId ?? ""), queryFn: () => v1.call<Entry[]>("GET", `/watchlists/${id(listId!)}/entries`), enabled: !!listId });
export const useImports = (listId: string | null) =>
  useQuery({ queryKey: wlKeys.imports(listId ?? ""), queryFn: () => v1.call<ImportRecord[]>("GET", `/watchlists/${id(listId!)}/imports`), enabled: !!listId });

export function useWatchlistMutations(listId: string | null) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: wlKeys.lists });
    if (listId) {
      void qc.invalidateQueries({ queryKey: wlKeys.entries(listId) });
      void qc.invalidateQueries({ queryKey: wlKeys.imports(listId) });
    }
  };
  return {
    createList: useMutation({ mutationFn: (v: { name: string; source: string }) => v1.call<Watchlist>("POST", "/watchlists", v), onSuccess: refresh }),
    addEntry: useMutation({ mutationFn: (v: EntryInput) => v1.call<Entry>("POST", `/watchlists/${id(listId!)}/entries`, v), onSuccess: refresh }),
    removeEntry: useMutation({
      mutationFn: (v: { entryId: string; justification: string }) =>
        v1.call<Entry>("POST", `/watchlists/${id(listId!)}/entries/${id(v.entryId)}/remove`, { justification: v.justification }),
      onSuccess: refresh,
    }),
    expireEntry: useMutation({
      mutationFn: (v: { entryId: string; expiresAt: string; justification: string }) =>
        v1.call<Entry>("POST", `/watchlists/${id(listId!)}/entries/${id(v.entryId)}/expire`, { expiresAt: v.expiresAt, justification: v.justification }),
      onSuccess: refresh,
    }),
    importCsv: useMutation({
      mutationFn: (v: { file: File; mode: "preview" | "confirm" }) => {
        const form = new FormData();
        form.append("file", v.file);
        return v1.call<ImportResult>("POST", `/watchlists/${id(listId!)}/import?mode=${v.mode}`, form);
      },
      onSuccess: (r) => r.mode === "confirm" && refresh(),
    }),
  };
}

export const templateCsv = (listId: string) => v1.text(`/watchlists/${id(listId)}/import/template`);
