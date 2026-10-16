import type { AlertStatus, CameraStatus, ControlStatus, Priority, TlsStatus } from "../../api/types";
import type { Tone } from "./Badge";

export const PRIORITY_TONE: Record<Priority, Tone> = { critical: "gold", high: "danger", medium: "warn" };

export const ALERT_STATUS: Record<AlertStatus, { tone: Tone; label: string }> = {
  pending: { tone: "accent", label: "Awaiting review" },
  approved: { tone: "ok", label: "Confirmed" },
  rejected: { tone: "neutral", label: "Rejected" },
  escalated: { tone: "gold", label: "Escalated" },
};

export const CAMERA_STATUS: Record<CameraStatus, { tone: Tone; label: string }> = {
  online: { tone: "ok", label: "Online" },
  degraded: { tone: "warn", label: "Degraded" },
  offline: { tone: "danger", label: "Offline" },
};

export const TLS_STATUS: Record<TlsStatus, { tone: Tone; label: string }> = {
  valid: { tone: "ok", label: "Valid" },
  expiring: { tone: "warn", label: "Expiring" },
  expired: { tone: "danger", label: "Expired" },
};

export const CONTROL_STATUS: Record<ControlStatus, { tone: Tone; label: string }> = {
  mitigated: { tone: "ok", label: "Mitigated" },
  monitored: { tone: "accent", label: "Monitored" },
  gap: { tone: "gold", label: "Gap" },
};
