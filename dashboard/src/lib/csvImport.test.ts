import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv";
import { validateWatchlistCsv, watchlistTemplateCsv, WATCHLIST_COLUMNS } from "./csvImport";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const HEADER = WATCHLIST_COLUMNS.join(",");
const run = (rows: string[], activePlates: string[] = []) =>
  validateWatchlistCsv([HEADER, ...rows].join("\n"), { now: NOW, activePlates: new Set(activePlates) });

describe("parseCsv / toCsv", () => {
  it("handles quotes, escaped quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,"b,c","say ""hi"""\r\n1,2,3\r\n')).toEqual([["a", "b,c", 'say "hi"'], ["1", "2", "3"]]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => parseCsv('a,"b\n1,2')).toThrow(/never closed/);
  });

  it("neutralises spreadsheet formulas when writing", () => {
    expect(toCsv(["x"], [["=1+1"], ["@SUM(A1)"], ["ok"]])).toBe("x\r\n'=1+1\r\n'@SUM(A1)\r\nok\r\n");
  });
});

describe("validateWatchlistCsv", () => {
  it("accepts valid rows and canonicalises plates", () => {
    const v = run(["١٢٣٤٥ - ب - 6,STOLEN,CASE-1,Desk,2027-01-31", "7305|د|41,wanted,CASE-2,Desk,"]);
    expect(v.fatal).toBeNull();
    expect(v.accepted).toBe(2);
    expect(v.rows[0].entry).toMatchObject({ plate: "12345|ب|6", reason: "stolen", expiresAt: "2027-01-31T23:59:59.000Z" });
    expect(v.rows[1].entry?.expiresAt).toBeNull();
  });

  it("rejects malformed rows with a reason for each", () => {
    const v = run([
      "12345|X|6,stolen,CASE-1,Desk,",       // unknown letter
      "12345|ب|99,stolen,CASE-2,Desk,",      // region out of range
      "12345|ب|6,lost,CASE-3,Desk,",         // bad reason
      "12345|ب|7,stolen,,Desk,",             // missing caseRef
      "12345|ب|8,stolen,CASE-5,Desk",        // missing a column
      "12345|ب|9,stolen,CASE-6,Desk,31/12/2027", // bad date
    ]);
    expect(v.accepted).toBe(0);
    expect(v.rows.map((r) => r.problems.join(" "))).toEqual([
      expect.stringMatching(/number\|letter\|region/),
      expect.stringMatching(/region 1–89/),
      expect.stringMatching(/Reason must be/),
      expect.stringMatching(/caseRef is required/),
      expect.stringMatching(/Expected 5 columns/),
      expect.stringMatching(/not a date/),
    ]);
  });

  it("rejects duplicates inside the file and plates already on a watchlist", () => {
    const v = run(["12345|ب|6,stolen,CASE-1,Desk,", "12345 ب 6,wanted,CASE-2,Desk,", "7305|د|41,stolen,CASE-3,Desk,"], ["7305|د|41"]);
    expect(v.rows[0].ok).toBe(true);
    expect(v.rows[1].problems).toContain("Duplicate of line 2.");
    expect(v.rows[2].problems).toContain("Already active on a watchlist.");
  });

  it("rejects expired rows", () => {
    const v = run(["12345|ب|6,stolen,CASE-1,Desk,2026-10-07", "12345|ب|7,stolen,CASE-2,Desk,2026-10-08T11:00:00Z"]);
    expect(v.rows.every((r) => r.problems.some((p) => p.startsWith("Already expired")))).toBe(true);
  });

  it("refuses cells that would run as spreadsheet formulas", () => {
    const v = run(["12345|ب|6,stolen,CASE-1,=HYPERLINK(1),"]);
    expect(v.rows[0].problems.join(" ")).toMatch(/formula/);
  });

  it("fails the whole file on a wrong header, no rows, or bad CSV", () => {
    expect(validateWatchlistCsv("plate,reason\n1|ب|1,stolen", { now: NOW }).fatal).toMatch(/first line/);
    expect(validateWatchlistCsv(HEADER, { now: NOW }).fatal).toMatch(/no rows/);
    expect(validateWatchlistCsv("", { now: NOW }).fatal).toMatch(/empty/);
    expect(validateWatchlistCsv(`${HEADER}\n"oops`, { now: NOW }).fatal).toMatch(/never closed/);
  });

  it("produces a template that validates cleanly", () => {
    const v = validateWatchlistCsv(watchlistTemplateCsv(), { now: NOW });
    expect(v.fatal).toBeNull();
    expect(v.rejected).toBe(0);
  });
});
