/*
 * THE ONE FILE THAT WIRES THE API.
 *   accounts  the PostgreSQL API (/api/v1/auth, cookie sessions). Always real.
 *   api       data for pages not yet ported to /api/v1. In real mode it returns NO data: every
 *             call fails with "not connected", and those routes show a "Not connected yet" page.
 *             Fictional data exists only with VITE_APP_ENV=demo (an explicit opt-in).
 *   cameras   the Cities & Cameras feature: see features/cameras/api.ts.
 */
import type { AccountsApi, AnprApi } from "./types";
import { cachedIdentity, createAccountsApi } from "./accounts";
import { createMockApi } from "./mock";
import { createUnavailableApi } from "./unavailable";
import { API_BASE } from "./v1";

export const accounts: AccountsApi = createAccountsApi(API_BASE);

/** VITE_APP_ENV=demo: every page runs on fictional in-browser data, with a DEMO DATA ribbon. */
export const demoMode = import.meta.env.VITE_APP_ENV === "demo";

export const api: AnprApi = demoMode ? createMockApi({ identity: cachedIdentity(accounts) }) : createUnavailableApi();
