/* Test double for the registry API: records calls, returns fixed data. Tests only. */
import { vi } from "vitest";
import type { CameraRegistryApi, RegistryCamera, RegistryCity } from "./types";

export const CITY: RegistryCity = { id: "city-1", name: "Rabat", region: "Rabat-Salé-Kénitra" };

export function cam(over: Partial<RegistryCamera> = {}): RegistryCamera {
  return {
    id: "cam-1", cityId: CITY.id, name: "Agdal gate 1", kind: "anpr_camera", district: "Agdal", streetAddress: null,
    latitude: 34.0007, longitude: -6.8498, viewDirectionDeg: 90, lane: "2", installedOn: null, owner: null, host: "10.20.0.11",
    port: 322, protocol: "rtsps", streamPath: "/stream1", vlan: 120, firmwareVersion: null, credentialsSet: true, status: "online",
    lastFrameAt: null, tlsNotAfter: null, notes: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
  };
}

export function fakeRegistry(over: Partial<CameraRegistryApi> = {}): CameraRegistryApi {
  const api: CameraRegistryApi = {
    listCities: vi.fn(async () => [CITY]),
    createCity: vi.fn(async (v) => ({ id: "city-2", ...v })),
    updateCity: vi.fn(async (id, p) => ({ ...CITY, id, ...p })),
    deleteCity: vi.fn(async () => {}),
    listCameras: vi.fn(async () => [cam()]),
    createCamera: vi.fn(async (d) => cam({ ...d, id: "cam-new", credentialsSet: false } as Partial<RegistryCamera>)),
    updateCamera: vi.fn(async (id, p) => cam({ id, ...p } as Partial<RegistryCamera>)),
    deleteCamera: vi.fn(async () => {}),
    replaceCredentials: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({ reachable: true, verdict: "Network reachable, stream not verified", latencyMs: 12, steps: [], tlsNotAfter: null, testedAt: "" })),
    testDraftConnection: vi.fn(async () => ({
      reachable: true, verdict: "Network reachable, stream not verified", latencyMs: 12, tlsNotAfter: null, testedAt: "",
      steps: [{ name: "dns" as const, ok: true, ms: 1, detail: "Resolved" }, { name: "tcp" as const, ok: true, ms: 12, detail: "Port 322 open" }, { name: "tls" as const, ok: true, ms: 30, detail: "Handshake OK" }],
    })),
    statusHistory: vi.fn(async () => []),
    cameraAudit: vi.fn(async () => []),
    importCsv: vi.fn(async (file, mode) => ({
      mode, fileName: file.name, sha256: "a".repeat(64), rowsTotal: 2, rowsAccepted: 1, rowsRejected: 1,
      accepted: [{ line: 2, name: "Imported cam", cityId: CITY.id, kind: "ptz" as const, protocol: "rtsp" as const }],
      rejected: [{ line: 3, name: "Bad cam", reasons: ["latitude: Input should be less than or equal to 90"] }],
    })),
    importTemplate: vi.fn(async () => "city,name\n"),
    ...over,
  };
  return api;
}
