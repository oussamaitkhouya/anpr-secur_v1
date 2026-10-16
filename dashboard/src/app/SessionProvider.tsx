import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { accounts } from "../api/client";
import type { User } from "../api/types";
import { can } from "../lib/rbac";
import { readPref, writePref } from "../lib/storage";
import Login from "../pages/Login";
import { COOKIE_SESSION, SessionContext, type SessionValue, type Theme } from "./session";

function initialTheme(): Theme {
  const saved = readPref("theme");
  if (saved === "light" || saved === "dark") return saved;
  return "dark"; // dark is the signature look; the toggle remembers a light preference
}

/**
 * Holds the signed-in user. The session itself is in httpOnly cookies set by the API, so a
 * reload asks GET /auth/me who is signed in; nothing is kept in localStorage. Until someone
 * signs in, the login page is shown instead of the app; the URL is kept, so a deep link opens
 * after sign-in.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<{ token: string; user: User } | null>(null);
  const [checking, setChecking] = useState(true);
  const [expiredNotice, setExpiredNotice] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    let live = true;
    accounts
      .me({ token: COOKIE_SESSION })
      .then((user) => live && setAuth({ token: COOKIE_SESSION, user }))
      .catch(() => {}) // not signed in (or the API is down: the login page says so on submit)
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      writePref("theme", next);
      return next;
    });
  }, []);

  const onLogin = useCallback((user: User) => {
    setExpiredNotice(false);
    setAuth({ token: COOKIE_SESSION, user });
  }, []);

  const signOut = useCallback(async () => {
    setAuth(null);
    await accounts.logout({ token: COOKIE_SESSION }).catch(() => {});
  }, []);

  const expire = useCallback(() => {
    setAuth(null);
    setExpiredNotice(true);
  }, []);

  const setUser = useCallback((user: User) => setAuth((a) => (a ? { ...a, user } : a)), []);

  const value = useMemo<SessionValue | null>(
    () =>
      auth && {
        token: auth.token,
        user: auth.user,
        role: auth.user.role,
        can: (p) => can(auth.user.role, p),
        setUser,
        signOut,
        expire,
        theme,
        toggleTheme,
      },
    [auth, setUser, signOut, expire, theme, toggleTheme],
  );

  return (
    // "user": framer-motion skips transform/layout animation when the OS asks for reduced motion
    <MotionConfig reducedMotion="user">
      {checking ? (
        <div className="grid min-h-screen place-items-center" role="status" aria-label="Checking your session">
          <span className="size-8 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />
        </div>
      ) : value ? (
        <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
      ) : (
        <Login onLogin={onLogin} expired={expiredNotice} theme={theme} onToggleTheme={toggleTheme} />
      )}
    </MotionConfig>
  );
}
