/*
 * Role-based access control: ONE permission map, used by the sidebar, the routes, the buttons
 * and the mock API. The real backend must enforce the same map server-side: hiding a button in
 * the browser is a convenience, not a security control.
 */

export const ROLES = ["super_admin", "admin", "analyst", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  analyst: "Analyst",
  auditor: "Auditor",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  super_admin: "Full control: every page and action in every city, including reviewing alerts, revealing plates and managing Admin accounts.",
  admin: "Manages cities, cameras, credentials, watchlists, and Analyst/Auditor accounts. Sees everything and exports the audit log.",
  analyst: "Monitors the cameras of allowed cities, reviews alerts, searches plates (masked; revealing needs a reason).",
  auditor: "Read-only: audit log, evidence verification and security pages. No camera or watchlist access.",
};

export type Permission =
  | "overview:view"
  | "alerts:view"
  | "alerts:review"
  | "search:view"
  | "plates:reveal"
  | "evidence:view"
  | "evidence:verify"
  | "audit:view"
  | "audit:export"
  | "security:view"
  | "models:view"
  | "cameras:view"
  | "camera:live"
  | "settings:view"
  | "admin:cameras"
  /** Cities & Cameras page: admins edit, analysts read their own cities, auditors never */
  | "registry:view"
  | "admin:watchlists"
  | "admin:users"
  /** Clear plate reads, decided alerts and their frames (audited; server: detections.purge) */
  | "history:clear";

const ADMIN: readonly Permission[] = [
  "overview:view", "alerts:view", "alerts:review", "search:view", "plates:reveal",
  "evidence:view", "evidence:verify", "audit:view", "audit:export", "security:view",
  "models:view", "cameras:view", "camera:live", "settings:view",
  "admin:cameras", "admin:watchlists", "admin:users", "registry:view", "history:clear",
];

/** Super admin and admin share page access; which ACCOUNTS each may manage is decided server-side. */
const PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: ADMIN,
  admin: ADMIN,
  analyst: [
    "overview:view", "alerts:view", "alerts:review", "search:view", "plates:reveal",
    "models:view", "cameras:view", "camera:live", "settings:view", "registry:view",
  ],
  auditor: [
    "overview:view", "evidence:view", "evidence:verify", "audit:view", "security:view",
    "models:view", "settings:view",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  return PERMISSIONS[role].includes(permission);
}

export function permissionsOf(role: Role): readonly Permission[] {
  return PERMISSIONS[role];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
