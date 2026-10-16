/*
 * Minimal CSV reading and writing (RFC 4180: commas, double-quoted fields, "" for a quote).
 * Writing neutralises spreadsheet formulas: a cell starting with = + - @ tab or CR is prefixed
 * with ' so Excel or LibreOffice shows it as text instead of running it (CSV injection).
 */

export class CsvError extends Error {}

/** Parse CSV text into rows of cells. Strips a leading BOM; ignores blank lines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let quoteStartLine = 0;

  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    cell = "";
  };

  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (c === "\n") line++;
        cell += c;
      }
    } else if (c === '"') {
      if (cell !== "") throw new CsvError(`Line ${line}: a quote may only start a field.`);
      quoted = true;
      quoteStartLine = line;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
    } else {
      cell += c;
    }
  }
  if (quoted) throw new CsvError(`Line ${quoteStartLine}: a quoted field is never closed.`);
  if (cell !== "" || row.length) endRow();
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

export function looksLikeFormula(value: string): boolean {
  return FORMULA_START.test(value);
}

function escapeCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (looksLikeFormula(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [header, ...rows].map((r) => r.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}
