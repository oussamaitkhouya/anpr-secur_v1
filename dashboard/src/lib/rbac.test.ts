import { describe, expect, it } from "vitest";
import { NAV } from "../app/nav";
import { can, isRole, permissionsOf, ROLES, type Role } from "./rbac";

const visible = (role: Role) => NAV.filter((n) => can(role, n.permission)).map((n) => n.path);

describe("rbac permission map", () => {
  it("gives super admin and admin every permission any role has", () => {
    const all = new Set(ROLES.flatMap((r) => permissionsOf(r)));
    for (const p of all) {
      expect(can("admin", p)).toBe(true);
      expect(can("super_admin", p)).toBe(true);
    }
  });

  it("lets analysts monitor, review and search, but nothing administrative", () => {
    for (const p of ["alerts:review", "plates:reveal", "cameras:view", "camera:live"] as const) expect(can("analyst", p)).toBe(true);
    for (const p of ["audit:view", "security:view", "evidence:view", "admin:cameras", "admin:watchlists", "admin:users"] as const) {
      expect(can("analyst", p)).toBe(false);
    }
  });

  it("keeps auditors read-only, with no camera, watchlist or plate access", () => {
    for (const p of ["audit:view", "evidence:verify", "security:view"] as const) expect(can("auditor", p)).toBe(true);
    for (const p of ["cameras:view", "camera:live", "alerts:view", "search:view", "plates:reveal", "admin:watchlists", "audit:export"] as const) {
      expect(can("auditor", p)).toBe(false);
    }
  });

  it("shows each role a different sidebar", () => {
    expect(visible("admin")).toHaveLength(NAV.length);
    expect(visible("analyst")).toEqual(expect.arrayContaining(["/alerts", "/admin/cameras", "/camera", "/search"])); // "/cameras" merged into Cities & Cameras
    expect(visible("analyst")).not.toContain("/admin/users");
    expect(visible("auditor")).toEqual(expect.arrayContaining(["/audit", "/evidence", "/security"]));
    expect(visible("auditor")).not.toContain("/camera");
    expect(visible("auditor")).not.toContain("/admin/watchlists");
  });

  it("recognises only known roles", () => {
    expect(isRole("super_admin")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});
