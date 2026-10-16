/*
 * In-browser camera registry for VITE_APP_ENV=demo ONLY. Every city and camera here is
 * fictional (names start with "Demo"), hosts use the 198.51.100.0/24 documentation range, and
 * connection tests are simulated and say so. Never loaded in real mode (see api.ts).
 */
import { ApiError } from "../../api/errors";
import type {
  CameraAuditEntry, CameraDraft, CameraImportResult, CameraKind, CameraProtocol, CameraRegistryApi, CameraStatus,
  ConnectionTestResult, RegistryCamera, RegistryCity, StatusEvent,
} from "./types";

const wait = (ms = 220) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

export function createDemoRegistry(): CameraRegistryApi {
  let seq = 1;
  const uid = () => `demo-${(seq++).toString(16).padStart(6, "0")}`;
  const cities: RegistryCity[] = [
    { id: uid(), name: "Demo Northgate", region: "Fictional Region A" },
    { id: uid(), name: "Demo Riverside", region: "Fictional Region B" },
  ];
  const cameras: RegistryCamera[] = [];
  const history = new Map<string, StatusEvent[]>();
  const audit = new Map<string, CameraAuditEntry[]>();
  let auditSeq = 1;

  const seed: [number, string, CameraKind, CameraProtocol, CameraStatus, number, number, number | null, number | null, number | null][] = [
    // city, name, kind, protocol, status, lat, lon, minutes since last frame, TLS days left, view
    [0, "Demo gate 1", "anpr_camera", "rtsps", "online", 34.0209, -6.8416, 1, 220, 90],
    [0, "Demo gate 2", "anpr_camera", "rtsps", "online", 34.0182, -6.8361, 2, 18, 270],
    [0, "Demo square PTZ", "ptz", "onvif", "degraded", 34.0151, -6.8326, 34, null, null],
    [0, "Demo bridge radar", "radar", "mqtt", "online", 34.0244, -6.8302, 1, null, 180],
    [0, "Demo market CCTV", "fixed_cctv", "rtsp", "offline", 34.0127, -6.8459, 640, null, 45],
    [0, "Demo depot", "fixed_cctv", "rtsps", "maintenance", 34.0098, -6.8392, null, -4, 0],
    [1, "Demo quay north", "anpr_camera", "rtsps", "online", 33.5951, -7.6187, 1, 95, 135],
    [1, "Demo quay south", "anpr_camera", "rtsps", "online", 33.5899, -7.6122, 3, 9, 315],
    [1, "Demo ring road", "radar", "webhook", "unknown", 33.5862, -7.6301, null, null, 90],
    [1, "Demo tunnel PTZ", "ptz", "rtsp", "degraded", 33.5927, -7.6248, 22, null, null],
  ];
  seed.forEach(([c, name, kind, protocol, status, lat, lon, frame, tls, view], i) => {
    const cam: RegistryCamera = {
      id: uid(), cityId: cities[c].id, name, kind, district: c ? "Demo harbour" : "Demo old town",
      streetAddress: `${10 + i} Demo avenue`, latitude: lat, longitude: lon, viewDirectionDeg: view, lane: kind === "anpr_camera" ? "1" : null,
      installedOn: "2025-11-03", owner: "Demo operator", host: `198.51.100.${20 + i}`,
      port: protocol === "rtsps" ? 322 : protocol === "rtsp" ? 554 : protocol === "onvif" ? 80 : protocol === "mqtt" ? 1883 : null,
      protocol, streamPath: protocol.startsWith("rtsp") ? "/stream1" : null, vlan: 120 + c, firmwareVersion: "4.2.1",
      credentialsSet: i % 4 !== 2, status, lastFrameAt: frame === null ? null : ago(frame), tlsNotAfter: tls === null ? null : inDays(tls),
      notes: null, createdAt: ago(60 * 24 * 30), updatedAt: ago(60 * 5),
    };
    cameras.push(cam);
    history.set(cam.id, [
      { status, reason: status === "maintenance" ? "maintenance mode" : "demo seed", at: ago(60 * 5) },
      { status: "unknown", reason: "created", at: cam.createdAt },
    ]);
  });

  const log = (cameraId: string, action: string, justification: string | null = null) => {
    const list = audit.get(cameraId) ?? [];
    list.unshift({ seq: auditSeq++, ts: now(), actorRole: "admin", action, justification });
    audit.set(cameraId, list);
  };
  const find = (cameraId: string) => {
    const cam = cameras.find((c) => c.id === cameraId);
    if (!cam) throw new ApiError(404, "Camera not found.");
    return cam;
  };
  const simulate = (protocol: CameraProtocol, host: string | null): ConnectionTestResult => {
    if (protocol === "webhook" || protocol === "file") throw new ApiError(422, `${protocol} sources are not contacted by the server; nothing to test`);
    if (!host) throw new ApiError(422, "the camera needs a host and a port to be tested");
    const steps: ConnectionTestResult["steps"] = [
      { name: "dns", ok: true, ms: 3.1, detail: `Resolved to ${host} (simulated)` },
      { name: "tcp", ok: true, ms: 18.4, detail: "Port open (simulated)" },
    ];
    if (protocol === "rtsps") steps.push({ name: "tls", ok: true, ms: 41.2, detail: "Handshake OK, certificate chain not verified (simulated)" });
    return { reachable: true, verdict: "Network reachable, stream not verified (demo simulation)", latencyMs: 18.4, steps, tlsNotAfter: protocol === "rtsps" ? inDays(120) : null, testedAt: now() };
  };

  return {
    async listCities() { await wait(); return structuredClone(cities); },
    async createCity(input) {
      await wait();
      if (cities.some((c) => c.name.toLowerCase() === input.name.toLowerCase())) throw new ApiError(409, "A city with this name already exists.");
      const city = { id: uid(), ...input };
      cities.push(city);
      return city;
    },
    async updateCity(cityId, patch) {
      await wait();
      const city = cities.find((c) => c.id === cityId);
      if (!city) throw new ApiError(404, "City not found.");
      Object.assign(city, patch);
      return { ...city };
    },
    async deleteCity(cityId) {
      await wait();
      const n = cameras.filter((c) => c.cityId === cityId).length;
      if (n) throw new ApiError(409, `The city still has ${n} camera(s); move or delete them first.`);
      cities.splice(cities.findIndex((c) => c.id === cityId), 1);
    },
    async listCameras() { await wait(320); return structuredClone(cameras); },
    async createCamera(input: CameraDraft) {
      await wait();
      if (cameras.some((c) => c.cityId === input.cityId && c.name.toLowerCase() === input.name.toLowerCase())) {
        throw new ApiError(409, "This city already has a camera with this name.");
      }
      const cam: RegistryCamera = {
        district: null, streetAddress: null, viewDirectionDeg: null, lane: null, installedOn: null, owner: null, host: null, port: null,
        streamPath: null, vlan: null, firmwareVersion: null, notes: null, status: "unknown",
        ...input, id: uid(), credentialsSet: false, lastFrameAt: null, tlsNotAfter: null, createdAt: now(), updatedAt: now(),
      } as RegistryCamera;
      cameras.push(cam);
      history.set(cam.id, [{ status: cam.status, reason: "created", at: now() }]);
      log(cam.id, "camera.create");
      return structuredClone(cam);
    },
    async updateCamera(cameraId, patch) {
      await wait();
      const cam = find(cameraId);
      const before = cam.status;
      Object.assign(cam, patch, { updatedAt: now() });
      if (cam.status !== before) history.get(cameraId)?.unshift({ status: cam.status, reason: cam.status === "maintenance" ? "maintenance mode" : "set by admin", at: now() });
      log(cameraId, "camera.update", Object.keys(patch).sort().join(", "));
      return structuredClone(cam);
    },
    async deleteCamera(cameraId) {
      await wait();
      find(cameraId);
      cameras.splice(cameras.findIndex((c) => c.id === cameraId), 1);
    },
    async replaceCredentials(cameraId) {
      await wait();
      find(cameraId).credentialsSet = true; // the demo keeps nothing: the values are simply dropped
      log(cameraId, "camera.credentials.replace");
    },
    async testConnection(cameraId) {
      await wait(900);
      const cam = find(cameraId);
      const result = simulate(cam.protocol, cam.host);
      log(cameraId, "camera.test_connection", "reachable (simulated); stream not verified");
      return result;
    },
    async testDraftConnection(input) { await wait(900); return simulate(input.protocol, input.host); },
    async statusHistory(cameraId) { await wait(); find(cameraId); return structuredClone(history.get(cameraId) ?? []); },
    async cameraAudit(cameraId) { await wait(); return structuredClone(audit.get(cameraId) ?? []); },
    async importCsv(file, mode): Promise<CameraImportResult> {
      await wait(500);
      const lines = (await file.text()).split(/\r?\n/).filter(Boolean);
      const rows = lines.slice(1);
      return {
        mode, fileName: file.name, sha256: "demo-mode-no-hash", rowsTotal: rows.length, rowsAccepted: 0, rowsRejected: rows.length,
        accepted: [], rejected: rows.map((_, i) => ({ line: i + 2, name: "", reasons: ["CSV import is disabled in demo mode"] })),
      };
    },
    async importTemplate() {
      await wait();
      return "city,name,kind,district,street_address,latitude,longitude,view_direction_deg,lane,installed_on,owner,protocol,host,port,stream_path,vlan,firmware_version,notes\n";
    },
  };
}
