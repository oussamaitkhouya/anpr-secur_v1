/*
 * fetch() wrapper for the PostgreSQL API (/api/v1, src/anpr/api/main.py).
 *
 * The session lives in httpOnly cookies set by the server (access 15 min, refresh 7 days,
 * SameSite=Strict). JavaScript never sees a token: requests just send `credentials: "include"`.
 * On a 401 the client tries POST /auth/refresh once (shared by concurrent requests), then
 * retries; if that fails the 401 is passed on and the app returns to the sign-in page.
 * FastAPI's {"detail": ...} becomes an ApiError with the same status. Error messages never
 * contain submitted values: the server does not echo them (see main.py), and neither do we.
 */
import { ApiError } from "./errors";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const PREFIX = "/api/v1";
const NO_REFRESH = ["/auth/login", "/auth/mfa", "/auth/mfa/setup", "/auth/refresh", "/auth/logout"];

let refreshing: Promise<boolean> | null = null;

function refreshOnce(baseUrl: string): Promise<boolean> {
  refreshing ??= fetch(`${baseUrl}${PREFIX}/auth/refresh`, { method: "POST", credentials: "include" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  const detail = await res.json().then((j: { detail?: unknown }) => j.detail).catch(() => null);
  if (typeof detail === "string") return new ApiError(res.status, detail);
  if (Array.isArray(detail)) {
    const fields = detail
      .map((d: { loc?: unknown[] }) => (Array.isArray(d.loc) ? String(d.loc[d.loc.length - 1]) : ""))
      .filter((f) => f && f !== "body");
    return new ApiError(res.status, fields.length ? `Check these fields: ${[...new Set(fields)].join(", ")}.` : "Some fields are invalid.");
  }
  if (res.status === 429) return new ApiError(429, "Too many requests. Wait a minute and try again.");
  return new ApiError(res.status, res.statusText || "Request failed.");
}

export function makeV1(baseUrl: string = API_BASE) {
  async function send(method: Method, path: string, body: unknown, retry: boolean): Promise<Response> {
    const isForm = body instanceof FormData;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${PREFIX}${path}`, {
        method,
        credentials: "include",
        headers: body === undefined || isForm ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, `Cannot reach the API at ${baseUrl}. Is it running?`);
    }
    if (res.status === 401 && retry && !NO_REFRESH.some((p) => path.startsWith(p)) && (await refreshOnce(baseUrl))) {
      return send(method, path, body, false);
    }
    return res;
  }

  async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const res = await send(method, path, body, true);
    if (!res.ok) throw await toError(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** For file downloads (CSV template): returns the raw body. */
  async function text(path: string): Promise<string> {
    const res = await send("GET", path, undefined, true);
    if (!res.ok) throw await toError(res);
    return res.text();
  }

  /** For images (evidence frames): the raw bytes plus response headers. */
  async function blob(path: string): Promise<{ blob: Blob; headers: Headers }> {
    const res = await send("GET", path, undefined, true);
    if (!res.ok) throw await toError(res);
    return { blob: await res.blob(), headers: res.headers };
  }

  return { call, text, blob };
}

export const v1 = makeV1();
