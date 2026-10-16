import { CircleAlert, ShieldAlert, Siren, type LucideIcon } from "lucide-react";
import type { Priority } from "../../api/types";

/** Priority is always shown by glyph and colour together, never colour alone. */
export const PRIORITY_ICON: Record<Priority, LucideIcon> = { critical: Siren, high: ShieldAlert, medium: CircleAlert };
export const PRIORITY_COLOR: Record<Priority, string> = { critical: "var(--gold)", high: "var(--danger)", medium: "var(--warn)" };
export const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2 };
