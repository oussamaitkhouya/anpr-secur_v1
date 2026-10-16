import { createContext, useContext } from "react";
import type { User } from "../api/types";
import type { Permission, Role } from "../lib/rbac";

export type Theme = "light" | "dark";

/** RequestContext.token under cookie sessions: a fixed marker, never a secret. */
export const COOKIE_SESSION = "cookie-session";

export interface SessionValue {
  /** COOKIE_SESSION: the real session is an httpOnly cookie JavaScript cannot read */
  token: string;
  user: User;
  role: Role;
  can: (permission: Permission) => boolean;
  /** replace the user after the server changed it (e.g. an Admin edited their own account) */
  setUser: (user: User) => void;
  signOut: () => Promise<void>;
  /** the server said 401: drop the session without calling logout */
  expire: () => void;
  theme: Theme;
  toggleTheme: () => void;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionProvider> after sign-in");
  return session;
}
