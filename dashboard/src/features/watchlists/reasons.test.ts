import { describe, expect, it } from "vitest";
import type { Entry } from "./api";
import { daysUntilExpiry, expiresSoon, numberHit } from "./reasons";

const now = Date.parse("2026-10-09T12:00:00Z");
const entry = (over: Partial<Entry>): Entry => ({
  id: "e", listId: "l", importId: null, plateCanonical: "1|أ|1", reason: "stolen", color: null, make: null, model: null, vehicleType: null,
  caseRef: null, source: null, addedAt: "2026-10-01T00:00:00Z", expiresAt: null, removedAt: null, status: "active", ...over,
});
const inDays = (d: number) => new Date(now + d * 86_400_000).toISOString();

describe("expiresSoon", () => {
  it("is true only for active entries expiring within the next 7 days", () => {
    expect(expiresSoon(entry({ expiresAt: inDays(3) }), now)).toBe(true);
    expect(expiresSoon(entry({ expiresAt: inDays(8) }), now)).toBe(false);
    expect(expiresSoon(entry({ expiresAt: inDays(-1) }), now)).toBe(false);
    expect(expiresSoon(entry({ expiresAt: null }), now)).toBe(false);
    expect(expiresSoon(entry({ expiresAt: inDays(3), status: "removed" }), now)).toBe(false);
  });
});

describe("daysUntilExpiry", () => {
  it("counts days for active entries with a future expiry only", () => {
    expect(daysUntilExpiry(entry({ expiresAt: inDays(12) }), now)).toBeCloseTo(12);
    expect(daysUntilExpiry(entry({ expiresAt: inDays(-2) }), now)).toBeNull();
    expect(daysUntilExpiry(entry({ expiresAt: null }), now)).toBeNull();
    expect(daysUntilExpiry(entry({ expiresAt: inDays(2), status: "expired" }), now)).toBeNull();
  });
});

describe("numberHit", () => {
  it("finds digits inside the plate number, ignoring separators", () => {
    expect(numberHit("40781|ب|40", "0781")).toEqual([1, 5]);
    expect(numberHit("40781|ب|40", "40 781")).toEqual([0, 5]);
    expect(numberHit("40781|ب|40", "999")).toBeNull();
    expect(numberHit("40781|ب|40", "CASE")).toBeNull();
    expect(numberHit("40781|ب|40", "")).toBeNull();
  });
});
