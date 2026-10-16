/*
 * Watchlist CSV validation. The browser runs it for the preview; the API runs the SAME code
 * again on import, because a client can never be trusted to have validated anything.
 *
 * Columns: plate,reason,caseRef,source,expiresAt
 *   plate      Moroccan number|letter|region (same rules as src/anpr/pipeline/validator.py)
 *   reason     stolen | wanted | other
 *   caseRef    letters, digits and . _ - / (max 40)
 *   source     who reported it (max 60)
 *   expiresAt  optional, YYYY-MM-DD or ISO date-time, must be in the future
 */
import type { WatchlistReason } from "../api/types";
import { CsvError, looksLikeFormula, parseCsv, toCsv } from "./csv";
import { canonical, parsePlate } from "./plate";

export const WATCHLIST_COLUMNS = ["plate", "reason", "caseRef", "source", "expiresAt"] as const;
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 1_000_000;
const REASONS: WatchlistReason[] = ["stolen", "wanted", "other"];
const CASE_REF = /^[A-Za-z0-9._\-/]{1,40}$/;

export interface ValidEntry {
  plate: string; // canonical
  reason: WatchlistReason;
  caseRef: string;
  source: string;
  expiresAt: string | null; // ISO
}

export interface RowResult {
  line: number; // 1-based line in the file (header is line 1)
  cells: string[];
  ok: boolean;
  problems: string[];
  entry: ValidEntry | null;
}

export interface ImportValidation {
  /** a problem with the whole file (bad header, too big...): nothing is imported */
  fatal: string | null;
  rows: RowResult[];
  accepted: number;
  rejected: number;
}

export interface ValidateOptions {
  now: number;
  /** canonical plates already active on any watchlist */
  activePlates?: ReadonlySet<string>;
}

function parseExpiry(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return null;
  // a bare date expires at the end of that day, UTC
  const t = Date.parse(value.length === 10 ? `${value}T23:59:59Z` : value);
  return Number.isNaN(t) ? null : t;
}

export function validateWatchlistCsv(text: string, { now, activePlates = new Set() }: ValidateOptions): ImportValidation {
  const fail = (fatal: string): ImportValidation => ({ fatal, rows: [], accepted: 0, rejected: 0 });
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) return fail(`The file is larger than ${MAX_IMPORT_BYTES / 1_000_000} MB.`);

  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (e) {
    return fail(e instanceof CsvError ? e.message : "The file is not valid CSV.");
  }
  if (table.length === 0) return fail("The file is empty.");

  const header = table[0].map((h) => h.trim());
  if (header.join(",") !== WATCHLIST_COLUMNS.join(",")) {
    return fail(`The first line must be exactly: ${WATCHLIST_COLUMNS.join(",")}`);
  }
  const body = table.slice(1);
  if (body.length === 0) return fail("The file has a header but no rows.");
  if (body.length > MAX_IMPORT_ROWS) return fail(`At most ${MAX_IMPORT_ROWS} rows per import; this file has ${body.length}.`);

  const firstLineOf = new Map<string, number>();
  const rows: RowResult[] = body.map((cells, i) => {
    const line = i + 2;
    const problems: string[] = [];
    if (cells.length !== WATCHLIST_COLUMNS.length) {
      return { line, cells, ok: false, problems: [`Expected ${WATCHLIST_COLUMNS.length} columns, found ${cells.length}.`], entry: null };
    }
    const [plateRaw, reasonRaw, caseRefRaw, sourceRaw, expiresRaw] = cells.map((c) => c.trim());

    if (cells.some((c) => looksLikeFormula(c.trim()))) problems.push("A cell starts with = + - or @ (spreadsheet formula); refused.");

    const plate = parsePlate(plateRaw);
    if (!plate) problems.push("Plate is not number|letter|region with a known letter and region 1–89.");

    const reason = reasonRaw.toLowerCase() as WatchlistReason;
    if (!REASONS.includes(reason)) problems.push("Reason must be stolen, wanted or other.");

    if (!CASE_REF.test(caseRefRaw)) problems.push("caseRef is required: letters, digits and . _ - / only, at most 40 characters.");
    if (!sourceRaw || sourceRaw.length > 60) problems.push("source is required (at most 60 characters).");

    let expiresAt: string | null = null;
    if (expiresRaw) {
      const t = parseExpiry(expiresRaw);
      if (t === null) problems.push("expiresAt is not a date (use YYYY-MM-DD).");
      else if (t <= now) problems.push(`Already expired (${expiresRaw}).`);
      else expiresAt = new Date(t).toISOString();
    }

    if (plate) {
      const key = canonical(plate);
      const first = firstLineOf.get(key);
      if (first !== undefined) problems.push(`Duplicate of line ${first}.`);
      else firstLineOf.set(key, line);
      if (activePlates.has(key)) problems.push("Already active on a watchlist.");
    }

    const ok = problems.length === 0;
    return {
      line,
      cells,
      ok,
      problems,
      entry: ok && plate ? { plate: canonical(plate), reason, caseRef: caseRefRaw, source: sourceRaw, expiresAt } : null,
    };
  });

  const accepted = rows.filter((r) => r.ok).length;
  return { fatal: null, rows, accepted, rejected: rows.length - accepted };
}

/** A small, valid template with fictional rows. */
export function watchlistTemplateCsv(): string {
  return toCsv(WATCHLIST_COLUMNS, [
    ["48213|ب|6", "stolen", "CASE-2026-0001", "Demo police desk", "2027-12-31"],
    ["7305|د|41", "wanted", "CASE-2026-0002", "Demo police desk", ""],
  ]);
}
