/*
 * Shapes of the camera registry API (/api/v1, camelCase). They mirror src/anpr/api/schemas.py.
 * There is no credentials field anywhere except CameraCredentials, which is only ever SENT:
 * responses carry `credentialsSet: boolean` and nothing else about credentials.
 */

export const CAMERA_KINDS = ["fixed_cctv", "ptz", "anpr_camera", "radar"] as const;
export const CAMERA_PROTOCOLS = ["rtsps", "rtsp", "onvif", "webhook", "mqtt", "file"] as const;
export const CAMERA_STATUSES = ["online", "offline", "degraded", "maintenance", "unknown"] as const;

export type CameraKind = (typeof CAMERA_KINDS)[number];
export type CameraProtocol = (typeof CAMERA_PROTOCOLS)[number];
export type CameraStatus = (typeof CAMERA_STATUSES)[number];

export interface RegistryCity {
  id: string;
  name: string;
  region: string;
}

export interface RegistryCamera {
  id: string;
  cityId: string;
  name: string;
  kind: CameraKind;
  district: string | null;
  streetAddress: string | null;
  latitude: number;
  longitude: number;
  viewDirectionDeg: number | null;
  lane: string | null;
  installedOn: string | null;
  owner: string | null;
  host: string | null;
  port: number | null;
  protocol: CameraProtocol;
  streamPath: string | null;
  vlan: number | null;
  firmwareVersion: string | null;
  credentialsSet: boolean;
  status: CameraStatus;
  lastFrameAt: string | null;
  tlsNotAfter: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /admin/cameras body. PATCH takes any subset except cityId. */
export interface CameraDraft {
  cityId: string;
  name: string;
  kind: CameraKind;
  district?: string | null;
  streetAddress?: string | null;
  latitude: number;
  longitude: number;
  viewDirectionDeg?: number | null;
  lane?: string | null;
  installedOn?: string | null;
  owner?: string | null;
  host?: string | null;
  port?: number | null;
  protocol: CameraProtocol;
  streamPath?: string | null;
  vlan?: number | null;
  firmwareVersion?: string | null;
  status?: CameraStatus;
  notes?: string | null;
}

export type CameraPatch = Partial<Omit<CameraDraft, "cityId">>;

/** Write-only. Sent once over TLS, encrypted at rest with AES-GCM, never returned. */
export interface CameraCredentials {
  username: string;
  password: string;
}

export interface ProbeStep {
  name: "dns" | "tcp" | "tls";
  ok: boolean;
  ms: number | null;
  detail: string;
}

/** reachable = TCP (and TLS for rtsps) succeeded. It never means the stream decodes. */
export interface ConnectionTestResult {
  reachable: boolean;
  verdict: string;
  latencyMs: number | null;
  steps: ProbeStep[];
  tlsNotAfter: string | null;
  testedAt: string;
}

export interface StatusEvent {
  status: CameraStatus;
  reason: string;
  at: string;
}

export interface CameraAuditEntry {
  seq: number;
  ts: string;
  actorRole: string;
  action: string;
  justification: string | null;
}

export interface CameraImportResult {
  mode: "preview" | "confirm";
  fileName: string;
  sha256: string;
  rowsTotal: number;
  rowsAccepted: number;
  rowsRejected: number;
  accepted: { line: number; name: string; cityId: string; kind: CameraKind; protocol: CameraProtocol }[];
  rejected: { line: number; name: string; reasons: string[] }[];
}

export interface CameraRegistryApi {
  listCities(): Promise<RegistryCity[]>;
  createCity(input: { name: string; region: string }): Promise<RegistryCity>;
  updateCity(id: string, patch: { name?: string; region?: string }): Promise<RegistryCity>;
  deleteCity(id: string): Promise<void>;
  listCameras(): Promise<RegistryCamera[]>;
  createCamera(input: CameraDraft): Promise<RegistryCamera>;
  updateCamera(id: string, patch: CameraPatch): Promise<RegistryCamera>;
  deleteCamera(id: string): Promise<void>;
  replaceCredentials(id: string, credentials: CameraCredentials): Promise<void>;
  testConnection(id: string): Promise<ConnectionTestResult>;
  testDraftConnection(input: { protocol: CameraProtocol; host: string; port: number | null }): Promise<ConnectionTestResult>;
  statusHistory(id: string): Promise<StatusEvent[]>;
  cameraAudit(id: string): Promise<CameraAuditEntry[]>;
  importCsv(file: File, mode: "preview" | "confirm"): Promise<CameraImportResult>;
  importTemplate(): Promise<string>;
}
