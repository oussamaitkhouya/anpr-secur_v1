// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAs } from "../../test/render";
import type { LiveAlert } from "./api";
import AlertsPage from "./AlertsPage";

vi.setConfig({ testTimeout: 20_000 });

function alert(id: string, plate: string, caseRef: string): LiveAlert {
  const now = new Date().toISOString();
  return {
    id, detectionId: `d-${id}`, plate, plateMasked: false, plateConfidence: 0.9, chars: [], cameraId: "c1", cameraName: "Gate",
    cameraAddress: null, cameraLatitude: null, cameraLongitude: null, cameraViewDeg: null, cityId: "city-1", cityName: "Rabat",
    observedAt: now, receivedAt: now, kind: "full_match", matchScore: 1, observedColor: null, observedMake: null, observedModel: null,
    evidenceSha256: null, plateBox: null, speedKmh: null,
    watchlistEntry: { id: `e-${id}`, listId: "l1", listName: "Stolen", plate, reason: "stolen", caseRef, source: null,
      color: null, make: null, model: null, addedAt: now, expiresAt: null },
    status: "pending", createdAt: now, decision: null,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
    alert("aaaaaaaa-0000-0000-0000-000000000001", "11111|أ|6", "CASE-ONE"),
    alert("bbbbbbbb-0000-0000-0000-000000000002", "22222|ب|1", "CASE-TWO"),
  ]), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

/** A card that framer-motion left in its "hidden" variant is invisible: opacity 0 inline. */
function visible(el: HTMLElement) {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) if (n.style.opacity === "0") return false;
  return true;
}

describe("Alerts page: switching alerts", () => {
  it("shows the details of the alert picked from the queue, without a reload", async () => {
    const user = userEvent.setup({ delay: null });
    renderAs("analyst", <AlertsPage />);
    await waitFor(() => expect(visible(screen.getAllByText("CASE-ONE").at(-1)!)).toBe(true));
    await user.click(screen.getByRole("button", { name: /22222/ }));
    await waitFor(() => {
      const details = screen.getAllByText("CASE-TWO").filter((n) => n.tagName === "DD");
      expect(details).toHaveLength(1);
      expect(visible(details[0])).toBe(true);
    }, { timeout: 4000 });
  });
});
