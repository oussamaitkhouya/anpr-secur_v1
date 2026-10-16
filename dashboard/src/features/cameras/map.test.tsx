// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cam } from "./fakeApi";
import { MiniMap, RegistryMap } from "./map";

/*
 * Real Leaflet, no mocks: other tests stub the map out, which is how a crash with no tile server
 * ("Map has no maxZoom specified" from marker clustering) once reached the browser.
 */
describe("maps without a tile server", () => {
  it("renders clustered markers instead of crashing", () => {
    const cameras = [cam(), cam({ id: "cam-2", name: "Second", latitude: 34.01, longitude: -6.84 })];
    expect(() => render(<RegistryMap cameras={cameras} cityName={() => "Rabat"} onOpen={() => {}} />)).not.toThrow();
    expect(screen.getByText(/No tile server configured/)).toBeInTheDocument();
  });

  it("renders the detail mini map", () => {
    expect(() => render(<MiniMap camera={cam()} />)).not.toThrow();
  });
});
