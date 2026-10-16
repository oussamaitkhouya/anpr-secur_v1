import { describe, expect, it } from "vitest";
import { isMasked, MASK, maskPlate, validateRevealReason } from "./mask";
import { normalizePlateText, parsePlate } from "./plate";

describe("maskPlate", () => {
  it("hides the serial number but keeps its last digit, the letter and the region", () => {
    expect(maskPlate("12345|ب|6")).toBe(`${MASK}5|ب|6`);
    expect(maskPlate("987|ه|45")).toBe(`${MASK}7|ه|45`);
  });

  it("hides short numbers completely", () => {
    expect(maskPlate("42|د|1")).toBe(`${MASK}|د|1`);
    expect(maskPlate("7|أ|89")).toBe(`${MASK}|أ|89`);
  });

  it("uses a fixed width so the number's length is not revealed", () => {
    expect(maskPlate("12345|ب|6").length).toBe(maskPlate("345|ب|6").length);
  });

  it("never echoes text it cannot parse", () => {
    expect(maskPlate("not a plate 12345")).toBe(`${MASK}|?|?`);
    expect(maskPlate("12345|X|6")).toBe(`${MASK}|?|?`); // letter outside the configured set
  });

  it("marks masked output as masked", () => {
    expect(isMasked(maskPlate("12345|ب|6"))).toBe(true);
    expect(isMasked("12345|ب|6")).toBe(false);
  });
});

describe("validateRevealReason", () => {
  it("rejects missing, short and junk reasons", () => {
    expect(validateRevealReason("")).not.toBeNull();
    expect(validateRevealReason("   because ")).not.toBeNull();
    expect(validateRevealReason("aaaaaaaaaaaaaaa")).not.toBeNull();
  });

  it("accepts a real reason", () => {
    expect(validateRevealReason("Security desk request for incident #12")).toBeNull();
  });
});

describe("plate parsing", () => {
  it("normalises Arabic digits and separators like the Python validator", () => {
    expect(normalizePlateText("١٢٣٤٥ - ب - ٦")).toBe("12345|ب|6");
    expect(parsePlate("12345 ب 6")).toEqual({ number: "12345", letter: "ب", region: 6 });
  });

  it("rejects out-of-range regions and too many digits", () => {
    expect(parsePlate("12345|ب|90")).toBeNull();
    expect(parsePlate("123456|ب|6")).toBeNull();
  });
});
