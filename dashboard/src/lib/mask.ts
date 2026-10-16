/*
 * Plate masking. The rule is deliberately simple so it can be explained in one sentence:
 * the serial number is replaced by a fixed-width mask (so its length is hidden too), and only
 * its last digit stays visible when the number has 3 or more digits. Letter and region stay,
 * because they identify a region, not a vehicle.
 *
 *   12345|ب|6 -> ••••5|ب|6      42|د|1 -> ••••|د|1
 *
 * The real API masks server-side; the UI never receives a full plate unless a reveal
 * (with a reason, written to the audit log) returns it.
 */
import { parsePlate } from "./plate";

export const MASK = "••••";

export function maskPlate(canonicalPlate: string): string {
  const plate = parsePlate(canonicalPlate);
  if (!plate) return `${MASK}|?|?`; // never echo text that failed to parse
  const tail = plate.number.length >= 3 ? plate.number.slice(-1) : "";
  return `${MASK}${tail}|${plate.letter}|${plate.region}`;
}

export function isMasked(text: string): boolean {
  return text.startsWith(MASK);
}

export const MIN_REASON_LENGTH = 10;

/** Reason required to reveal a plate. Returns an error message, or null if acceptable. */
export function validateRevealReason(reason: string): string | null {
  const r = reason.trim();
  if (r.length < MIN_REASON_LENGTH) return `Give a reason of at least ${MIN_REASON_LENGTH} characters.`;
  if (/^(.)\1+$/.test(r.replace(/\s/g, ""))) return "The reason must describe why you need the plate.";
  return null;
}

/**
 * Shortest plate query a search accepts. Partial matching on very short strings would let
 * someone enumerate masked plates one digit at a time through the search box.
 */
export const MIN_PLATE_QUERY = 3;

export function plateQueryLength(query: string): number {
  return query.replace(/[\s|\-_/.,:;]/g, "").length;
}
