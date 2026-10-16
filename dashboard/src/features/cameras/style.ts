import { Cctv, Radar, ScanLine, Video, type LucideIcon } from "lucide-react";
import type { CameraKind, CameraStatus } from "./types";

export const KIND_ICONS: Record<CameraKind, LucideIcon> = { fixed_cctv: Cctv, ptz: Video, anpr_camera: ScanLine, radar: Radar };

/** Token colour per status, for chips, markers and bars. */
export const STATUS_COLOR: Record<CameraStatus, string> = {
  online: "var(--ok)", degraded: "var(--warn)", offline: "var(--danger)", maintenance: "var(--accent)", unknown: "var(--text-faint)",
};
