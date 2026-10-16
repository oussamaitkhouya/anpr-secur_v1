/*
 * Client for the accounts side of the PostgreSQL API (src/anpr/api/routes/auth.py and the
 * user routes in admin.py). Sign-in is two steps, password then TOTP code, and the session is
 * held in httpOnly cookies the browser sends by itself. There are no demo accounts.
 */
import type { AccountsApi, LoginStep, MfaSetup, RequestContext, User } from "./types";
import { ApiError } from "./errors";
import { isRole } from "../lib/rbac";
import { makeV1 } from "./v1";

/** GET /auth/me */
interface MeOut {
  id: string;
  username: string;
  role: string;
  cityIds: string[] | null;
}

/** GET /admin/users */
interface UserOut {
  id: string;
  username: string;
  role: string;
  isActive: boolean;
  mfaEnrolled: boolean;
  locked: boolean;
  cityIds: string[];
  createdAt: string;
}

function roleOf(role: string): User["role"] {
  if (!isRole(role)) throw new ApiError(500, "The server returned an unknown role.");
  return role;
}

export function meToUser(me: MeOut): User {
  return { id: me.id, username: me.username, name: me.username, role: roleOf(me.role), allowedCityIds: me.cityIds ?? [] };
}

function toUser(u: UserOut): User {
  return {
    id: u.id, username: u.username, name: u.username, role: roleOf(u.role), allowedCityIds: u.cityIds,
    active: u.isActive, createdAt: u.createdAt, manageable: true,
  };
}

export function createAccountsApi(baseUrl?: string): AccountsApi {
  const { call } = makeV1(baseUrl);
  const id = encodeURIComponent;
  return {
    login: (username, password) => call<LoginStep>("POST", "/auth/login", { username, password }),
    mfaSetup: () => call<MfaSetup>("POST", "/auth/mfa/setup"),
    mfaVerify: (code) => call<MeOut>("POST", "/auth/mfa", { code }).then(meToUser),
    logout: () => call<void>("POST", "/auth/logout"),
    me: () => call<MeOut>("GET", "/auth/me").then(meToUser),
    changeOwnPassword: () =>
      Promise.reject(new ApiError(501, "Changing your own password is not available yet; ask an Admin to reset it.")),
    listUsers: () => call<UserOut[]>("GET", "/admin/users").then((us) => us.map(toUser)),
    createUser: (_ctx, input) =>
      call<UserOut>("POST", "/admin/users", { username: input.username, password: input.password, role: input.role, cityIds: input.allowedCityIds })
        .then(toUser),
    updateUser: (_ctx, userId, patch) =>
      call<UserOut>("PATCH", `/admin/users/${id(userId)}`, { role: patch.role, isActive: patch.active, cityIds: patch.allowedCityIds })
        .then(toUser),
    resetPassword: (_ctx, userId, password) => call<void>("PUT", `/admin/users/${id(userId)}/password`, { password }),
    deleteUser: () =>
      Promise.reject(new ApiError(405, "Accounts are deactivated, not deleted, so their audit history stays intact.")),
  };
}

/**
 * "Who is calling?" for the mock data API (pages not yet on the real API), cached briefly so
 * every mock call does not hit the server.
 */
const IDENTITY_TTL_MS = 15_000;

export function cachedIdentity(accounts: AccountsApi): (token: string) => Promise<User> {
  let hit: { user: Promise<User>; at: number } | null = null;
  return (token) => {
    if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.user;
    const user = accounts.me({ token } satisfies RequestContext);
    hit = { user, at: Date.now() };
    user.catch(() => (hit = null));
    return user;
  };
}
