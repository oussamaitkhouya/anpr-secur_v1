// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAs } from "../../test/render";
import type { LiveAlert } from "./api";
import AlertsPage from "./AlertsPage";

vi.setConfig({ testTimeout: 20_000 });

const FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const FRAME_SHA = "c8271e7a7c627a582c7743c59388e95ade120b2b83b707e8d2a8b443e7147e3e"; // sha256 of FRAME

function alert(over: Partial<LiveAlert> = {}): LiveAlert {
  return {
    id: "0b6c2d1e-aaaa-bbbb-cccc-000000000001", detectionId: "d1", plate: "12345|أ|6", plateMasked: false, plateConfidence: 0.96,
    chars: [..."12345أ6"].map((char) => ({ char, confidence: 0.95 })), cameraId: "c1", cameraName: "Agdal gate",
    cameraAddress: "Avenue Mohammed V", cameraLatitude: 34.0132, cameraLongitude: -6.8326, cameraViewDeg: 90, cityId: "city-1",
    cityName: "Rabat", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), kind: "full_match", matchScore: 1,
    observedColor: "white", observedMake: null, observedModel: null, evidenceSha256: FRAME_SHA,
    plateBox: [0.4, 0.5, 0.2, 0.08], speedKmh: null,
    watchlistEntry: { id: "e1", listId: "l1", listName: "Stolen", plate: "12345|أ|6", reason: "stolen", caseRef: "CASE-9", source: "DGSN",
      color: null, make: null, model: null, addedAt: new Date().toISOString(), expiresAt: null },
    status: "pending", createdAt: new Date().toISOString(), decision: null, ...over,
  };
}

function stubApi(list: LiveAlert[], evidence: () => Response = () => new Response(FRAME, { status: 200, headers: { "Content-Type": "image/jpeg" } })) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/evidence")) return evidence();
    if (init?.method === "POST" && url.includes("/review")) {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ...list[0], status: "approved", decision: { action: "approve", justification: body.justification, reviewer: "analyst", decidedAt: new Date().toISOString() } }), { status: 200 });
    }
    return new Response(JSON.stringify(list), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:evidence-frame");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe("Alerts page (real API)", () => {
  it("a reviewer must write a justification, and it is sent to the review endpoint", async () => {
    const calls = stubApi([alert()]);
    const user = userEvent.setup({ delay: null });
    renderAs("analyst", <AlertsPage />);
    await user.click(await screen.findByRole("button", { name: /Confirm match/ }));
    await user.type(screen.getByLabelText("Justification"), "too short");
    await user.click(screen.getAllByRole("button", { name: /Confirm match/ }).at(-1)!);
    expect(calls.some((c) => c.url.includes("/review"))).toBe(false);
    await user.type(screen.getByLabelText("Justification"), " but now the crop is clearly legible.");
    await user.click(screen.getAllByRole("button", { name: /Confirm match/ }).at(-1)!);
    await waitFor(() => expect(calls.find((c) => c.url.includes("/review"))?.body).toMatchObject({ action: "approve" }));
    expect(await screen.findAllByText(/Recorded in the signed audit log/)).not.toHaveLength(0);
  });

  it("roles that cannot review get a read-only panel and a masked plate", async () => {
    stubApi([alert({ plate: "••••5|أ|6", plateMasked: true, chars: [], watchlistEntry: { ...alert().watchlistEntry, plate: "••••5|أ|6" } })]);
    renderAs("admin", <AlertsPage />);
    expect(await screen.findByText("Your role can view alerts but not decide them.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm match/ })).toBeNull();
    expect(screen.getByText("Masked for your role")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("12345");
  });

  it("shows the real captured frame with where and when it was taken", async () => {
    const calls = stubApi([alert()]);
    renderAs("analyst", <AlertsPage />);
    const img = await screen.findByRole("img", { name: /Camera frame from Agdal gate/ });
    expect(img).toHaveAttribute("src", "blob:evidence-frame");
    expect(calls.filter((c) => c.url.endsWith("/evidence"))).toHaveLength(1); // fetched once, not polled
    expect(screen.getByText(/Avenue Mohammed V/)).toBeInTheDocument();
    expect(screen.getByText(/34\.01320°, -6\.83260°/)).toBeInTheDocument();
    expect(screen.getByText("faces E")).toBeInTheDocument();
    expect(screen.getByText("Chain of custody")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Generated|placeholder image/i);
  });

  it("draws the radar view over the frame: plate lock, plate zoom and the data strip", async () => {
    // jsdom has no layout: give the stage and the image a size so the overlay can be placed
    const size = (el: object, prop: string, value: number) => Object.defineProperty(el, prop, { configurable: true, value });
    const restore = [Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"), Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")];
    size(HTMLElement.prototype, "clientWidth", 800);
    size(HTMLElement.prototype, "clientHeight", 450);
    try {
      stubApi([alert({ speedKmh: 72.4 })]);
      renderAs("analyst", <AlertsPage />);
      const img = await screen.findByRole("img", { name: /Camera frame from Agdal gate/ });
      size(img, "naturalWidth", 1280);
      size(img, "naturalHeight", 720);
      fireEvent.load(img);
      expect(await screen.findByText(/TARGET LOCK · 96%/)).toBeInTheDocument();
      expect(screen.getByText("PLATE ×5.0")).toBeInTheDocument();
      expect(screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)).toBeInTheDocument();
      expect(screen.getByText("34.01320°N 6.83260°W")).toBeInTheDocument();
      expect(screen.getByText("72 KM/H")).toBeInTheDocument();
      expect(screen.getByText("⚠ STOLEN")).toBeInTheDocument();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", restore[0] ?? { configurable: true, value: 0 });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", restore[1] ?? { configurable: true, value: 0 });
    }
  });

  it("withholds a frame that fails the server's integrity check", async () => {
    stubApi([alert()], () => new Response(JSON.stringify({ detail: "The stored image does not match the hash recorded at capture; it is not shown." }), { status: 409 }));
    renderAs("analyst", <AlertsPage />);
    expect(await screen.findByText("Evidence integrity failure")).toBeInTheDocument();
    expect(screen.getByText("Integrity check failed: image withheld")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Camera frame/ })).toBeNull();
  });

  it("says plainly when no frame was kept", async () => {
    stubApi([alert({ evidenceSha256: null })]);
    renderAs("analyst", <AlertsPage />);
    expect(await screen.findByText("No frame kept")).toBeInTheDocument();
  });

  it("an empty database shows an honest empty state", async () => {
    stubApi([]);
    renderAs("analyst", <AlertsPage />);
    expect((await screen.findAllByText("No alerts yet")).length).toBeGreaterThan(0);
  });

  it("lists the most urgent alert first and narrows the queue by search and priority", async () => {
    const wanted = alert({ id: "0b6c2d1e-aaaa-bbbb-cccc-000000000002", plate: "777|ب|1", cityName: "Tanger",
      watchlistEntry: { ...alert().watchlistEntry, plate: "777|ب|1", reason: "wanted", caseRef: "CASE-7" } });
    stubApi([wanted, alert()]);
    const user = userEvent.setup({ delay: null });
    renderAs("analyst", <AlertsPage />);
    const queue = await screen.findByRole("list", { name: "Alert queue" });
    await waitFor(() => expect(queue.querySelectorAll("li")).toHaveLength(2));
    expect(queue.querySelectorAll("li")[0].textContent).toContain("Stolen vehicle"); // critical before high
    expect(screen.getByRole("region", { name: "Queue at a glance" }).textContent).toContain("Awaiting review");

    await user.type(screen.getByLabelText("Search alerts"), "tanger");
    await waitFor(() => expect(queue.querySelectorAll("li")).toHaveLength(1));
    expect(queue.textContent).toContain("Wanted vehicle");

    await user.clear(screen.getByLabelText("Search alerts"));
    await user.click(screen.getByRole("button", { name: /Critical/, pressed: false }));
    await waitFor(() => expect(queue.querySelectorAll("li")).toHaveLength(1));
    expect(queue.textContent).toContain("Stolen vehicle");
  });

  it("a shortcut key only opens the decision dialog; nothing is sent without a justification", async () => {
    const calls = stubApi([alert()]);
    const user = userEvent.setup({ delay: null });
    renderAs("analyst", <AlertsPage />);
    await screen.findByRole("button", { name: /Confirm match/ });
    await user.keyboard("r");
    expect(await screen.findByText("Reject as a false match")).toBeInTheDocument();
    await user.keyboard("a"); // typed into the justification field, not a second shortcut
    expect(screen.queryByText("Confirm this watchlist match")).toBeNull();
    expect(calls.some((c) => c.url.includes("/review"))).toBe(false);
  });

  it("no shortcut opens a decision for a role that cannot review", async () => {
    stubApi([alert({ plate: "••••5|أ|6", plateMasked: true, chars: [], watchlistEntry: { ...alert().watchlistEntry, plate: "••••5|أ|6" } })]);
    const user = userEvent.setup({ delay: null });
    renderAs("admin", <AlertsPage />);
    await screen.findByText("Your role can view alerts but not decide them.");
    await user.keyboard("a");
    expect(screen.queryByText("Confirm this watchlist match")).toBeNull();
  });
});
