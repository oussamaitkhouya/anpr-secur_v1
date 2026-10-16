import {
  Building2,
  FileLock2,
  Gauge,
  LayoutDashboard,
  ListChecks,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Siren,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "../lib/rbac";

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  group: "Operate" | "Assure" | "Admin" | "System";
  /** extra words the command palette matches on */
  keywords?: string;
  /** has a real data source on /api/v1; the others show "Not connected yet" outside demo mode */
  connected?: boolean;
}

export const NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: LayoutDashboard, permission: "overview:view", group: "Operate", keywords: "home kpi dashboard", connected: true },
  { path: "/alerts", label: "Live Alerts", icon: Siren, permission: "alerts:view", group: "Operate", keywords: "review watchlist queue stolen", connected: true },
  { path: "/camera", label: "Live Camera", icon: Video, permission: "camera:live", group: "Operate", keywords: "webcam stream live view getusermedia" , connected: true },
  { path: "/search", label: "Plate Search", icon: Search, permission: "search:view", group: "Operate", keywords: "find lookup" , connected: true },
  { path: "/evidence", label: "Evidence Vault", icon: FileLock2, permission: "evidence:view", group: "Assure", keywords: "signature hash chain verify" , connected: true },
  { path: "/audit", label: "Audit Log", icon: ScrollText, permission: "audit:view", group: "Assure", keywords: "logs history who" , connected: true },
  { path: "/security", label: "Security Center", icon: ShieldCheck, permission: "security:view", group: "Assure", keywords: "mitre stride threats" , connected: true },
  { path: "/admin/cameras", label: "Cities & Cameras", icon: Building2, permission: "registry:view", group: "Operate", keywords: "add camera rtsp credentials city map health registry", connected: true },
  { path: "/admin/watchlists", label: "Watchlists", icon: ListChecks, permission: "admin:watchlists", group: "Admin", keywords: "import csv stolen wanted plates", connected: true },
  { path: "/admin/users", label: "Users", icon: Users, permission: "admin:users", group: "Admin", keywords: "roles access cities rbac", connected: true },
  { path: "/models", label: "Model Performance", icon: Gauge, permission: "models:view", group: "System", keywords: "detector ocr accuracy map" , connected: true },
  { path: "/settings", label: "Settings", icon: Settings, permission: "settings:view", group: "System", keywords: "retention account" , connected: true },
];

export const NAV_GROUPS = ["Operate", "Assure", "Admin", "System"] as const;

/** Nav entry whose path is the longest prefix of pathname ("/evidence/ev-3" -> Evidence Vault). */
export function navFor(pathname: string): NavItem | undefined {
  return NAV.filter((n) => (n.path === "/" ? pathname === "/" : pathname === n.path || pathname.startsWith(`${n.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0];
}
