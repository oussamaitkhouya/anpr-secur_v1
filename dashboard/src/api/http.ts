/*
 * Operational data over HTTP, for the FastAPI backend once these routes exist (accounts are in
 * accounts.ts). Routes are the contract the backend should implement.
 */
import type {
  Alert, AnprApi, AuditEntry, Camera, City, ConnectionTest, EvidenceDetail, EvidenceList, ModelMetrics,
  Notification, OverviewMetrics, RetentionPolicy, RevealResult, SearchResult, SecurityOverview,
  WatchlistEntry, WatchlistImport, WatchlistList,
} from "./types";
import { ApiError } from "./errors";
import { makeCall } from "./httpCall";

function query(params: object): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : "";
}

export function createHttpApi(baseUrl: string): AnprApi {
  const call = makeCall(baseUrl);
  const id = encodeURIComponent;
  const notYet = () => Promise.reject(new ApiError(501, "Live detection needs the backend camera stream (stage 2)."));

  return {
    getOverview: (ctx) => call<OverviewMetrics>(ctx, "GET", "/metrics/overview"),
    getAlerts: (ctx) => call<Alert[]>(ctx, "GET", "/alerts"),
    reviewAlert: (ctx, alertId, action, justification) => call<Alert>(ctx, "POST", `/alerts/${id(alertId)}/review`, { action, justification }),
    subscribeAlerts: (ctx, onAlert) => {
      // EventSource cannot send headers; a short-lived ticket from POST /alerts/stream-ticket
      // would be exchanged here. Not needed until the backend exists.
      void ctx;
      void onAlert;
      return () => {};
    },
    searchPlates: (ctx, filters) => call<SearchResult[]>(ctx, "GET", `/plates/search${query(filters)}`),
    revealPlate: (ctx, readId, reason) => call<RevealResult>(ctx, "POST", `/plates/${id(readId)}/reveal`, { reason }),

    getEvidence: (ctx) => call<EvidenceList>(ctx, "GET", "/evidence"),
    getEvidenceDetail: (ctx, evidenceId) => call<EvidenceDetail>(ctx, "GET", `/evidence/${id(evidenceId)}`),
    recordChainVerification: (ctx, summary) => call<AuditEntry>(ctx, "POST", "/evidence/verifications", summary),
    getAudit: (ctx, filters) => call<AuditEntry[]>(ctx, "GET", `/audit${query(filters)}`),
    recordAuditExport: (ctx, rows) => call<AuditEntry>(ctx, "POST", "/audit/exports", { rows }),

    getCities: (ctx) => call<City[]>(ctx, "GET", "/cities"),
    getCameras: (ctx) => call<Camera[]>(ctx, "GET", "/cameras"),
    getCamera: (ctx, cameraId) => call<Camera>(ctx, "GET", `/cameras/${id(cameraId)}`),
    saveCamera: (ctx, input) => (input.id ? call<Camera>(ctx, "PUT", `/cameras/${id(input.id)}`, input) : call<Camera>(ctx, "POST", "/cameras", input)),
    replaceCredentials: (ctx, cameraId, credentials) => call<Camera>(ctx, "PUT", `/cameras/${id(cameraId)}/credentials`, credentials),
    testConnection: (ctx, cameraId) => call<ConnectionTest>(ctx, "POST", `/cameras/${id(cameraId)}/test`),

    getWatchlists: (ctx) => call<{ lists: WatchlistList[]; entries: WatchlistEntry[] }>(ctx, "GET", "/watchlists"),
    getWatchlistImports: (ctx) => call<WatchlistImport[]>(ctx, "GET", "/watchlists/imports"),
    importWatchlist: (ctx, request) => call<WatchlistImport>(ctx, "POST", "/watchlists/imports", request),
    addWatchlistEntry: (ctx, listId, input) => call<WatchlistEntry>(ctx, "POST", `/watchlists/${id(listId)}/entries`, input),
    setWatchlistEntryStatus: (ctx, entryId, status, reason) => call<WatchlistEntry>(ctx, "POST", `/watchlists/entries/${id(entryId)}/status`, { status, reason }),

    getModelMetrics: (ctx) => call<ModelMetrics>(ctx, "GET", "/metrics/models"),
    getSecurity: (ctx) => call<SecurityOverview>(ctx, "GET", "/security/overview"),
    getRetention: (ctx) => call<RetentionPolicy>(ctx, "GET", "/settings/retention"),
    getNotifications: (ctx) => call<Notification[]>(ctx, "GET", "/notifications"),

    recordCameraEvent: (ctx, cameraId, kind, detail) => call<AuditEntry>(ctx, "POST", `/cameras/${id(cameraId)}/events`, { kind, detail }),
    sendFrame: async (ctx, frame) => {
      const formData = new FormData();
      formData.append("file", frame.jpeg, "frame.jpg");
      formData.append("sessionId", frame.sessionId);
      formData.append("cameraId", frame.cameraId);
      formData.append("seq", String(frame.seq));
      const headers: Record<string, string> = {};
      if (ctx) headers.Authorization = `Bearer ${ctx.token}`;
      const res = await fetch(`${baseUrl}/detections/frame`, { method: "POST", headers, body: formData });
      if (!res.ok) throw new ApiError(res.status, res.statusText);
      return res.json();
    },
    getDetections: (ctx, sessionId) => call(ctx, "GET", `/detections?sessionId=${id(sessionId)}`),
  };
}
