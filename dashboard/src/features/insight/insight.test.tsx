// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAs } from "../../test/render";
import { csvCell, type Read } from "./api";
import AuditPage from "./AuditPage";
import EvidencePage from "./EvidencePage";
import ModelsPage from "./ModelsPage";
import SearchPage from "./SearchPage";
import SecurityPage from "./SecurityPage";

vi.setConfig({ testTimeout: 20_000 });

const READ: Read = {
  detectionId: "d-1", plateMasked: "••••5|أ|6", plateValid: true, plateConfidence: 0.93, observedAt: new Date().toISOString(),
  receivedAt: new Date().toISOString(), sourceKind: "video", cameraId: "c-1", cameraName: "Agdal gate", cityId: "city-1", cityName: "Rabat",
  observedColor: null, observedMake: null, observedModel: null, evidenceSha256: "", alerts: 0,
};

type Route = (url: string, init?: RequestInit) => unknown;
function stub(route: Route) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const out = route(url, init);
    return out === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { status: 200 });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("insight pages on the real API", () => {
  it("search shows masked plates; reveal needs a reason and shows the plate only after the server agrees", async () => {
    const calls = stub((url, init) =>
      url.includes("/reveal") ? { detectionId: "d-1", plateCanonical: "12345|أ|6", plateRaw: "12345أ6" }
        : url.includes("/plates/search") ? [READ] : url.includes("/cameras") ? [] : init?.method ? undefined : []);
    const user = userEvent.setup({ delay: null });
    renderAs("analyst", <SearchPage />);
    await user.type(screen.getByLabelText("Plate characters"), "2345");
    await user.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("Agdal gate")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("12345");
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    await user.type(screen.getByLabelText("Reason"), "Checking the read behind alert on case CASE-1.");
    await user.click(screen.getAllByRole("button", { name: "Reveal" }).at(-1)!);
    expect(await screen.findByText("revealed · audited")).toBeInTheDocument();
    expect(calls.find((c) => c.url.includes("/reveal"))?.body).toMatchObject({ justification: expect.stringContaining("CASE-1") });
  });

  it("evidence: the chosen file is hashed in the browser and only its hash is sent", async () => {
    const frame = new File(["frame-bytes"], "f.jpg", { type: "image/jpeg" });
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await frame.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const calls = stub((url) => (url.includes("/verify") ? { detectionId: "d-1", recordedSha256: digest, match: true } : [{ ...READ, evidenceSha256: digest }]));
    const user = userEvent.setup({ delay: null });
    renderAs("auditor", <EvidencePage />);
    await user.click(await screen.findByRole("button", { name: /Check a file/ }));
    await user.upload(screen.getByLabelText("Evidence frame file"), frame);
    expect(await screen.findByText("Matches the capture")).toBeInTheDocument();
    expect(calls.find((c) => c.url.includes("/verify"))?.body).toEqual({ sha256: digest });
  });

  it("audit export is recorded on the server before the file is produced", async () => {
    const row = { seq: 7, ts: new Date().toISOString(), actorId: "u1", actorRole: "admin", action: "camera.create", targetType: "camera",
      targetId: "c1", justification: null, ip: "127.0.0.1", prevHash: "a".repeat(64), hash: "b".repeat(64), signature: "sig" };
    const calls = stub((url, init) => (init?.method === "POST" ? undefined : url.includes("/audit/verify") ? { ok: true, entries: 7, firstBadSeq: null, reason: null } : [row]));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
    const user = userEvent.setup({ delay: null });
    renderAs("admin", <AuditPage />); // auditors read the log; exporting is an admin action in the dashboard
    expect(await screen.findByText("camera.create")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Export CSV/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/audit/exports"))).toBe(true));
    await user.click(screen.getByRole("button", { name: /Verify chain/ }));
    expect(await screen.findByText(/Chain intact/)).toBeInTheDocument();
  });

  it("csv cells cannot run as spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });

  it("security center renders the server's checks by area", async () => {
    stub(() => ({ checkedAt: new Date().toISOString(), recentEvents: [], checks: [
      { id: "cam-transport", title: "Encrypted camera transport", status: "warn", detail: "1 camera(s) stream over plain RTSP.", count: 1, area: "Cameras" },
      { id: "audit-chain", title: "Audit log intact", status: "ok", detail: "9 entries verified.", count: 9, area: "Integrity" },
    ] }));
    renderAs("auditor", <SecurityPage />);
    expect(await screen.findByText("Encrypted camera transport")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("models page flags a sanity-check OCR so its 100% is not trusted", async () => {
    const live = { reads: 0, validPlates: 0, validShare: null, meanConfidence: null, lowConfidenceReads: 0, alerts: {}, confirmedShare: null };
    stub(() => ({
      detector: { weights: "runs/detector/full/weights/last.pt", available: true, run: "full", epochs: [], final: { epoch: 25, precision: 0.99, recall: 0.97, map50: 0.99, map5095: 0.8 }, plannedEpochs: 50, baseModel: "yolo11n.pt", imageSize: 640 },
      ocr: { weights: "runs/ocr_overfit/best.pt", available: true, metrics: { plate_acc: 1, char_acc: 1 }, epoch: 60, sanityCheckOnly: true },
      live: { last24h: live, last7d: live }, note: "Training scores are validation results.",
    }));
    renderAs("analyst", <ModelsPage />);
    expect(await screen.findByText(/overfit sanity-check/)).toBeInTheDocument();
    expect(screen.getByText(/Training stopped at epoch 25 of 50/)).toBeInTheDocument();
  });
});
