// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAs } from "../../test/render";
import { cam } from "../cameras/fakeApi";
import LiveCameraPage from "./LiveCameraPage";

vi.setConfig({ testTimeout: 20_000 });

function stub(cameras: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/cities") ? [{ id: "city-1", name: "Rabat", region: "R" }] : url.includes("/cameras?") ? cameras : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
}
afterEach(() => vi.unstubAllGlobals());

const page = (
  <Routes>
    <Route path="/" element={<LiveCameraPage />} />
    <Route path="/camera/:id" element={<LiveCameraPage />} />
  </Routes>
);

describe("Live surveillance page", () => {
  it("offers real-time monitoring for a local camera (this PC's webcam)", async () => {
    stub([cam({ id: "web-1", name: "PC webcam", protocol: "file" })]);
    renderAs("analyst", page);
    expect(await screen.findByRole("button", { name: /Start monitoring/ })).toBeInTheDocument();
    expect(screen.getByText(/Detection runs on the server; video is not recorded/)).toBeInTheDocument();
  });

  it("explains that network cameras are read by the camera worker", async () => {
    stub([cam({ id: "street-1", name: "Street", protocol: "rtsps" })]);
    renderAs("analyst", page);
    expect(await screen.findByText("Network camera")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start monitoring/ })).toBeNull();
  });

  it("guides admins to register the webcam when no camera exists", async () => {
    stub([]);
    renderAs("admin", page);
    expect(await screen.findByText("No camera registered")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Register this PC's webcam/ })).toBeInTheDocument();
  });
});

describe("Live surveillance camera rail", () => {
  it("lists every camera as a card, local cameras first, and marks the one being watched", async () => {
    stub([cam({ id: "street-1", name: "Street", protocol: "rtsps" }), cam({ id: "web-1", name: "PC webcam", protocol: "file" })]);
    renderAs("analyst", page);
    const rail = await screen.findByRole("navigation", { name: "Cameras" });
    const links = within(rail).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([expect.stringContaining("PC webcam"), expect.stringContaining("Street")]);
    await waitFor(() => expect(links[0]).toHaveAttribute("aria-current", "page"));
    expect(links[0]).toHaveAttribute("href", "/camera/web-1");
  });

  it("shows the session telemetry at zero before monitoring starts", async () => {
    stub([cam({ id: "web-1", name: "PC webcam", protocol: "file" })]);
    renderAs("analyst", page);
    const tiles = await screen.findByRole("region", { name: "Session telemetry" });
    expect(tiles.textContent).toContain("Frames");
    expect(tiles.textContent).toContain("not monitoring");
  });
});
