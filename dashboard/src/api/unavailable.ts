/*
 * The data API for pages not yet built on /api/v1. It never invents data: every read fails with
 * a clear "not connected" error, so a page can only ever show real data or say it has none.
 * Pages are ported one at a time onto the PostgreSQL API (see features/cameras for the pattern).
 */
import { ApiError } from "./errors";
import type { AnprApi } from "./types";

export const NOT_CONNECTED = "This page is not connected to the PostgreSQL API yet, so it has no data to show.";

const refuse = () => Promise.reject(new ApiError(501, NOT_CONNECTED));

export function createUnavailableApi(): AnprApi {
  return new Proxy({} as AnprApi, {
    get(_target, name) {
      if (name === "subscribeAlerts") return () => () => {}; // no live channel yet: nothing arrives
      if (name === "getNotifications") return () => Promise.resolve([]); // the bell stays empty, honestly
      return refuse;
    },
  });
}
