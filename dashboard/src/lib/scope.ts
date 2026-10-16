/*
 * City scoping: which cities' cameras, reads and alerts a user may see. Used by the mock API
 * (the enforcement point) and by the tests. RBAC decides WHAT a role may do; scoping decides
 * WHERE.
 *
 *   Admin    all cities
 *   Analyst  only allowedCityIds (and only cities that still exist)
 *   Auditor  all cities, but only for aggregate figures: the auditor role has no camera,
 *            alert or search permission, so it never sees per-camera or per-plate data
 */
import type { User } from "../api/types";

export function visibleCityIds(user: Pick<User, "role" | "allowedCityIds">, allCityIds: readonly string[]): Set<string> {
  if (user.role === "analyst") return new Set(user.allowedCityIds.filter((id) => allCityIds.includes(id)));
  return new Set(allCityIds);
}

export function canSeeCity(user: Pick<User, "role" | "allowedCityIds">, cityId: string, allCityIds: readonly string[]): boolean {
  return visibleCityIds(user, allCityIds).has(cityId);
}
