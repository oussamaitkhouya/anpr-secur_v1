import { describe, expect, it } from "vitest";
import { canSeeCity, visibleCityIds } from "./scope";

const ALL = ["city-local", "city-north", "city-south"];

describe("city scoping", () => {
  it("gives admins and super admins every city", () => {
    expect([...visibleCityIds({ role: "admin", allowedCityIds: [] }, ALL)]).toEqual(ALL);
    expect([...visibleCityIds({ role: "super_admin", allowedCityIds: [] }, ALL)]).toEqual(ALL);
  });

  it("limits analysts to their allowed cities that still exist", () => {
    const user = { role: "analyst" as const, allowedCityIds: ["city-north", "city-gone"] };
    expect([...visibleCityIds(user, ALL)]).toEqual(["city-north"]);
    expect(canSeeCity(user, "city-south", ALL)).toBe(false);
  });

  it("gives an analyst with no cities nothing", () => {
    expect(visibleCityIds({ role: "analyst", allowedCityIds: [] }, ALL).size).toBe(0);
  });
});
