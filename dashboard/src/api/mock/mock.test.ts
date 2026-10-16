import { beforeEach, describe, expect, it } from "vitest";
import type { AnprApi, RequestContext, User } from "../types";
import { ApiError } from "../errors";
import { isMasked } from "../../lib/mask";
import { parsePlate } from "../../lib/plate";
import { GENESIS, linkHash, sha256Hex, verifyChain } from "../../lib/chain";
import { WATCHLIST_COLUMNS } from "../../lib/csvImport";
import { auditPayload, WEBCAM_ID } from "./seed";
import { createMockApi } from ".";

const NOW = Date.parse("2026-10-08T14:00:00Z");

/** Test identities: in the app these come from the accounts service. */
const USERS: Record<string, User> = {
  "t-super": { id: "u1", username: "root", name: "Root", role: "super_admin", allowedCityIds: [] },
  "t-admin": { id: "u2", username: "boss", name: "Boss", role: "admin", allowedCityIds: [] },
  "t-local": { id: "u3", username: "ana.local", name: "Ana", role: "analyst", allowedCityIds: ["city-local"] },
  "t-north": { id: "u4", username: "ana.north", name: "Nora", role: "analyst", allowedCityIds: ["city-local", "city-north"] },
  "t-audit": { id: "u5", username: "audi", name: "Audi", role: "auditor", allowedCityIds: [] },
};
const identity = async (token: string) => {
  const user = USERS[token];
  if (!user) throw new ApiError(401, "Your session has expired. Sign in again.");
  return user;
};
const ctx = (token: string): RequestContext => ({ token });
const admin = ctx("t-admin");
const local = ctx("t-local");
const north = ctx("t-north");
const auditor = ctx("t-audit");

let api: AnprApi;
const newApi = () => createMockApi({ seed: 7, now: NOW, latency: [0, 0], liveAlertEveryMs: 0, identity });
beforeEach(() => {
  api = newApi();
});

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof ApiError) return e.status;
    throw e;
  }
}

describe("mock API: identity and data", () => {
  it("rejects unknown tokens with 401", async () => {
    expect(await status(api.getOverview(ctx("nope")))).toBe(401);
  });

  it("is deterministic for a given seed", async () => {
    const [a, b] = await Promise.all([api.getAlerts(admin), newApi().getAlerts(admin)]);
    expect(a.map((x) => x.plate)).toEqual(b.map((x) => x.plate));
  });

  it("returns a consistent overview", async () => {
    const o = await api.getOverview(admin);
    expect(o.platesToday).toBeGreaterThan(0);
    expect(o.hourly).toHaveLength(24);
    expect(o.byPlateType.reduce((s, t) => s + t.count, 0)).toBe(o.platesToday);
    expect(Object.values(o.sparklines).every((s) => s.length === 14 && s.every(Number.isFinite))).toBe(true);
  });
});

describe("mock API: RBAC is enforced by the API, not only the UI", () => {
  it("returns 403 outside the role", async () => {
    expect(await status(api.getAudit(local, {}))).toBe(403);
    expect(await status(api.getSecurity(local))).toBe(403);
    expect(await status(api.getEvidence(local))).toBe(403);
    expect(await status(api.getAlerts(auditor))).toBe(403);
    expect(await status(api.getCameras(auditor))).toBe(403);
    expect(await status(api.getWatchlists(local))).toBe(403);
    expect(await status(api.saveCamera(north, { cityId: "city-north", name: "Gate", sourceType: "rtsp", endpoint: "rtsps://10.0.0.1/s" }))).toBe(403);
    expect(await status(api.recordAuditExport(auditor, 1))).toBe(403); // export is Admin-only
  });

  it("allows super admins everything an admin can do", async () => {
    expect(await status(api.getWatchlists(ctx("t-super")))).toBe(200);
    expect(await status(api.getAudit(ctx("t-super"), {}))).toBe(200);
  });
});

describe("mock API: city scoping", () => {
  it("shows analysts only the cameras of their cities", async () => {
    const all = (await api.getCameras(admin)).map((c) => c.cityId);
    expect(new Set(all)).toEqual(new Set(["city-local", "city-north", "city-south"]));
    expect((await api.getCameras(local)).map((c) => c.id)).toEqual([WEBCAM_ID]);
    expect(new Set((await api.getCameras(north)).map((c) => c.cityId))).toEqual(new Set(["city-local", "city-north"]));
  });

  it("scopes alerts, search and reveal, and hides out-of-scope items as 404", async () => {
    const southAlert = (await api.getAlerts(admin)).find((a) => a.cityId === "city-south")!;
    expect((await api.getAlerts(north)).every((a) => a.cityId !== "city-south")).toBe(true);
    expect(await status(api.reviewAlert(north, southAlert.id, "approve", "Trying to review another city"))).toBe(404);
    expect((await api.searchPlates(north, {})).every((r) => r.cameraId.startsWith("cam-n") || r.cameraId === WEBCAM_ID)).toBe(true);
    expect(await status(api.getCamera(local, "cam-s1"))).toBe(404);
    expect(await status(api.revealPlate(north, southAlert.readId, "Reason long enough to pass"))).toBe(404);
  });
});

describe("mock API: masking and reveal", () => {
  it("masks every search result and audits reveals", async () => {
    const results = await api.searchPlates(north, {});
    expect(results.every((r) => isMasked(r.plateMasked))).toBe(true);
    expect(await status(api.revealPlate(north, results[0].readId, "x"))).toBe(422);
    const revealed = await api.revealPlate(north, results[0].readId, "Security desk request: blocking the gate");
    expect(isMasked(revealed.plate)).toBe(false);
    const [entry] = await api.getAudit(admin, { action: "plate.reveal" });
    expect(entry).toMatchObject({ id: revealed.auditId, actor: "ana.north" });
  });

  it("refuses plate queries too short to be anything but enumeration", async () => {
    expect(await status(api.searchPlates(north, { plate: "12" }))).toBe(422);
  });
});

describe("mock API: human review", () => {
  it("requires a justification, audits, and refuses a second decision", async () => {
    const pending = (await api.getAlerts(north)).find((a) => a.status === "pending")!;
    expect(await status(api.reviewAlert(north, pending.id, "approve", "ok"))).toBe(422);
    const reviewed = await api.reviewAlert(north, pending.id, "reject", "Crop shows a 3 where OCR read an 8.");
    expect(reviewed.decision?.reviewer).toBe("ana.north");
    expect(await status(api.reviewAlert(north, pending.id, "approve", "Changed my mind about this one"))).toBe(409);
  });
});

describe("mock API: camera administration and credentials", () => {
  it("creates and edits cameras with validation, all audited", async () => {
    const cam = await api.saveCamera(admin, { cityId: "city-north", name: "New gate", sourceType: "rtsp", endpoint: "rtsps://10.20.1.30:322/s1" });
    expect(cam).toMatchObject({ cityName: "Demo City North", status: "offline", credentialsSet: false });
    await api.saveCamera(admin, { id: cam.id, cityId: "city-north", name: "New gate (east)", sourceType: "rtsp", endpoint: cam.endpoint });
    const log = await api.getAudit(admin, { q: cam.id });
    expect(log.map((e) => e.action)).toEqual(["camera.update", "camera.create"]);

    const bad = [
      { cityId: "city-north", name: "X", sourceType: "rtsp" as const, endpoint: "rtsps://10.0.0.1/s" }, // name too short
      { cityId: "nowhere", name: "Gate", sourceType: "rtsp" as const, endpoint: "rtsps://10.0.0.1/s" },
      { cityId: "city-north", name: "Gate", sourceType: "rtsp" as const, endpoint: "rtsp://10.0.0.1/s" }, // plain RTSP
      { cityId: "city-north", name: "Gate", sourceType: "rtsp" as const, endpoint: "rtsps://admin:hunter2@10.0.0.1/s" }, // creds in URL
      { cityId: "city-north", name: "Gate", sourceType: "browser-webcam" as const, endpoint: "rtsps://x/y" },
    ];
    for (const input of bad) expect(await status(api.saveCamera(admin, input))).toBe(422);
  });

  it("never exposes a camera password anywhere", async () => {
    const SECRET = "Sup3r-Secret-Camera-Pass";
    const cam = await api.saveCamera(admin, { cityId: "city-north", name: "Credential test", sourceType: "rtsp", endpoint: "rtsps://10.20.1.40:322/s" });
    const after = await api.replaceCredentials(admin, cam.id, { username: "camuser", password: SECRET });
    expect(after.credentialsSet).toBe(true);
    expect(Object.keys(after)).not.toContain("password");
    expect(await status(api.replaceCredentials(admin, cam.id, { username: "camuser", password: "short" }))).toBe(422);
    expect(await status(api.replaceCredentials(admin, WEBCAM_ID, { username: "x", password: SECRET }))).toBe(422);
    expect(await status(api.replaceCredentials(north, cam.id, { username: "x", password: SECRET }))).toBe(403);

    const everything = JSON.stringify([
      await api.getCameras(admin), await api.getCamera(admin, cam.id), await api.getAudit(admin, {}),
      await api.testConnection(admin, cam.id), await api.getNotifications(admin),
    ]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("camuser");
  });
});

describe("mock API: watchlist imports", () => {
  const csv = (rows: string[]) => [WATCHLIST_COLUMNS.join(","), ...rows].join("\n");

  it("re-validates on the server, records SHA-256, counts, author and version, and audits", async () => {
    const text = csv(["48213|ب|6,stolen,CASE-9,Desk,2027-12-31", "bad-plate,stolen,CASE-10,Desk,", "48213|ب|6,stolen,CASE-11,Desk,"]);
    const imp = await api.importWatchlist(admin, { listId: "wl-stolen", fileName: "C:\\Users\\x\\stolen.csv", csvText: text });
    expect(imp).toMatchObject({ fileName: "stolen.csv", rowsTotal: 3, rowsAccepted: 1, rowsRejected: 2, importedBy: "boss", version: 2 });
    expect(imp.sha256).toBe(await sha256Hex(text));
    const [entry] = await api.getAudit(admin, { action: "watchlist.import" });
    expect(entry.justification).toContain(imp.sha256);
    const { entries } = await api.getWatchlists(admin);
    expect(entries.some((e) => e.plate === "48213|ب|6" && e.importId === imp.id)).toBe(true);
  });

  it("refuses fatal files, files with no valid row, unknown lists and non-admins", async () => {
    expect(await status(api.importWatchlist(admin, { listId: "wl-stolen", fileName: "x.csv", csvText: "nope" }))).toBe(422);
    expect(await status(api.importWatchlist(admin, { listId: "wl-stolen", fileName: "x.csv", csvText: csv(["junk,stolen,C,D,"]) }))).toBe(422);
    expect(await status(api.importWatchlist(admin, { listId: "wl-nope", fileName: "x.csv", csvText: csv(["48213|ب|6,stolen,C-1,D,"]) }))).toBe(422);
    expect(await status(api.importWatchlist(north, { listId: "wl-stolen", fileName: "x.csv", csvText: csv(["48213|ب|6,stolen,C-1,D,"]) }))).toBe(403);
  });

  it("removes or expires entries with a reason, audited, with the plate masked in the log", async () => {
    const { entries } = await api.getWatchlists(admin);
    const target = entries.find((e) => e.status === "active")!;
    expect(await status(api.setWatchlistEntryStatus(admin, target.id, "removed", "short"))).toBe(422);
    const removed = await api.setWatchlistEntryStatus(admin, target.id, "removed", "Vehicle recovered, case closed");
    expect(removed.status).toBe("removed");
    expect(await status(api.setWatchlistEntryStatus(admin, target.id, "expired", "Second change attempt"))).toBe(409);
    const [entry] = await api.getAudit(admin, { action: "watchlist.remove" });
    expect(entry.target).toContain(target.id);
    expect(entry.target).not.toContain(target.plate);
  });
});

describe("mock API: live camera", () => {
  const frame = (seq: number) => ({
    sessionId: "s-test", cameraId: WEBCAM_ID, seq, capturedAt: new Date(NOW).toISOString(), width: 640, height: 360,
    jpeg: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }),
  });

  it("allows only roles with camera access, in scope", async () => {
    expect(await status(api.recordCameraEvent(auditor, WEBCAM_ID, "start", "Cam"))).toBe(403);
    expect(await status(api.recordCameraEvent(local, "cam-n1", "start", "Cam"))).toBe(404); // not in local's cities
    expect(await status(api.recordCameraEvent(local, WEBCAM_ID, "start", "Cam"))).toBe(200);
    expect((await api.getCamera(local, WEBCAM_ID)).status).toBe("online");
    await api.recordCameraEvent(local, WEBCAM_ID, "stop", "stopped by user");
    expect((await api.getCamera(local, WEBCAM_ID)).status).toBe("offline");
  });

  it("turns webcam watchlist matches into pending alerts, once per minute per plate", async () => {
    // Mock tracks change every 20 frames and every third set includes a watchlist plate.
    let alertId: string | null = null;
    for (let seq = 40; seq < 60 && !alertId; seq++) {
      await api.sendFrame(local, frame(seq));
      alertId = (await api.getDetections(local, "s-test")).find((d) => d.watchlistMatch)?.alertId ?? null;
    }
    expect(alertId).not.toBeNull();
    const alert = (await api.getAlerts(local)).find((a) => a.id === alertId)!;
    expect(alert).toMatchObject({ status: "pending", cameraId: WEBCAM_ID, cityId: "city-local" });
    await api.sendFrame(local, frame(59));
    const again = (await api.getDetections(local, "s-test")).find((d) => d.watchlistMatch);
    expect(again?.alertId).toBe(alertId); // same plate within a minute joins the same alert
    expect(await status(api.sendFrame(local, { ...frame(61), jpeg: new Blob([]) }))).toBe(422);
    expect(await status(api.sendFrame(local, { ...frame(62), cameraId: "cam-n1" }))).toBe(404);
  });

  it("returns well-formed detections inside the frame", async () => {
    await api.sendFrame(local, frame(7));
    for (const d of await api.getDetections(local, "s-test")) {
      expect(parsePlate(d.plate)).not.toBeNull();
      expect(d.box.x + d.box.w).toBeLessThanOrEqual(1);
    }
  });
});

describe("mock API: integrity", () => {
  it("contains exactly one deliberately tampered evidence record", async () => {
    const { records, publicKey } = await api.getEvidence(admin);
    const result = await verifyChain(records, publicKey);
    expect(result.broken).toBe(1);
    expect(records.find((r) => r.seq === result.firstBreakSeq)?.demoNote).toMatch(/tamper/);
  });

  it("keeps the audit hash chain valid after every kind of action", async () => {
    const cam = await api.saveCamera(admin, { cityId: "city-south", name: "Chain test", sourceType: "rtsp", endpoint: "rtsps://10.30.2.50:322/s" });
    await api.replaceCredentials(admin, cam.id, { username: "u", password: "long-enough-password" });
    await api.testConnection(admin, cam.id);
    await api.importWatchlist(admin, { listId: "wl-wanted", fileName: "w.csv", csvText: `${WATCHLIST_COLUMNS.join(",")}\n7305|د|41,wanted,C-1,Desk,` });
    const pending = (await api.getAlerts(north)).find((a) => a.status === "pending")!;
    await api.reviewAlert(north, pending.id, "escalate", "Need a second reviewer for this one");
    await api.recordCameraEvent(local, WEBCAM_ID, "start", "Cam");
    await api.recordAuditExport(admin, 10);

    const log = (await api.getAudit(admin, {})).reverse();
    let prev = GENESIS;
    for (const e of log) {
      expect(e.prevHash).toBe(prev);
      expect(await linkHash(e.prevHash, auditPayload(e))).toBe(e.hash);
      prev = e.hash;
    }
  });
});
