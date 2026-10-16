/*
 * Cities & Cameras data source. Real mode: the PostgreSQL API, cookie session, city scoping and
 * RBAC enforced by the server. Demo mode (VITE_APP_ENV=demo): an in-browser registry with
 * fictional data, and the page shows a "DEMO DATA" ribbon. Nothing fictional in real mode.
 */
import { demoMode } from "../../api/client";
import { v1 } from "../../api/v1";
import { createDemoRegistry } from "./demoApi";
import type {
  CameraAuditEntry, CameraImportResult, CameraRegistryApi, ConnectionTestResult, RegistryCamera, RegistryCity, StatusEvent,
} from "./types";

const id = encodeURIComponent;

export function createHttpRegistry(call = v1.call, text = v1.text): CameraRegistryApi {
  return {
    listCities: () => call<RegistryCity[]>("GET", "/cities"),
    createCity: (input) => call<RegistryCity>("POST", "/admin/cities", input),
    updateCity: (cityId, patch) => call<RegistryCity>("PATCH", `/admin/cities/${id(cityId)}`, patch),
    deleteCity: (cityId) => call<void>("DELETE", `/admin/cities/${id(cityId)}`),
    listCameras: () => call<RegistryCamera[]>("GET", "/cameras?limit=500"),
    createCamera: (input) => call<RegistryCamera>("POST", "/admin/cameras", input),
    updateCamera: (cameraId, patch) => call<RegistryCamera>("PATCH", `/admin/cameras/${id(cameraId)}`, patch),
    deleteCamera: (cameraId) => call<void>("DELETE", `/admin/cameras/${id(cameraId)}`),
    replaceCredentials: (cameraId, credentials) => call<void>("PUT", `/admin/cameras/${id(cameraId)}/credentials`, credentials),
    testConnection: (cameraId) => call<ConnectionTestResult>("POST", `/admin/cameras/${id(cameraId)}/test-connection`),
    testDraftConnection: (input) => call<ConnectionTestResult>("POST", "/admin/cameras/test-connection", input),
    statusHistory: (cameraId) => call<StatusEvent[]>("GET", `/cameras/${id(cameraId)}/status-events`),
    cameraAudit: (cameraId) => call<CameraAuditEntry[]>("GET", `/admin/cameras/${id(cameraId)}/audit`),
    importCsv: (file, mode) => {
      const form = new FormData();
      form.append("file", file);
      return call<CameraImportResult>("POST", `/admin/cameras/import?mode=${mode}`, form);
    },
    importTemplate: () => text("/admin/cameras/import/template"),
  };
}

export const registry: CameraRegistryApi = demoMode ? createDemoRegistry() : createHttpRegistry();
export const registryIsDemo = demoMode;
