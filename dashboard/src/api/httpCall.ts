import { ApiError } from "./errors";
import type { RequestContext } from "./types";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * fetch() wrapper shared by every HTTP client. The session token travels as a Bearer header from
 * memory: never in localStorage, script-set cookies or URLs. FastAPI's {"detail": ...} becomes
 * an ApiError with the same status.
 */
export function makeCall(baseUrl: string) {
  return async function call<T>(ctx: RequestContext | null, method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (ctx) headers.Authorization = `Bearer ${ctx.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, `Cannot reach the accounts service at ${baseUrl}. Is it running?`);
    }
    if (!res.ok) {
      const detail = await res.json().then((j: { detail?: unknown }) => j.detail).catch(() => null);
      const message = typeof detail === "string" ? detail : Array.isArray(detail) ? "Some fields are invalid." : res.statusText;
      throw new ApiError(res.status, message);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
}
