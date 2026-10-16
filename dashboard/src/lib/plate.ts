import type { Plate, PlateType } from "../api/types";

/*
 * Mirrors configs/plate_format.yaml. Those values are still marked unverified there,
 * so they are equally provisional here.
 */
export const PLATE_LETTERS = ["أ", "ب", "ج", "د", "ه", "و", "ط", "ش"] as const;
export const REGION_MIN = 1;
export const REGION_MAX = 89;

export const PLATE_TYPES: PlateType[] = ["private", "taxi", "temporary", "police", "government", "diplomatic"];

export const PLATE_TYPE_LABELS: Record<PlateType, string> = {
  private: "Private",
  taxi: "Taxi",
  temporary: "Temporary",
  police: "Police",
  government: "Government",
  diplomatic: "Diplomatic",
};

export function canonical(p: Plate): string {
  return `${p.number}|${p.letter}|${p.region}`;
}

const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/** Same normalisation as the Python validator: Arabic digits, tatweel, and separators to "|". */
export function normalizePlateText(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d])
    .replace(/ـ/g, "")
    .trim()
    .replace(/[\s\-_/.,:;]+/g, "|");
}

const PATTERN = /^(\d{1,5})\|(.)\|(\d{1,2})$/u;

export function parsePlate(text: string): Plate | null {
  const m = PATTERN.exec(normalizePlateText(text));
  if (!m) return null;
  const [, number, letter, regionText] = m;
  const region = Number(regionText);
  if (!(PLATE_LETTERS as readonly string[]).includes(letter)) return null;
  if (region < REGION_MIN || region > REGION_MAX) return null;
  return { number, letter, region };
}
