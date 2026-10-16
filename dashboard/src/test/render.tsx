import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { MemoryRouter } from "react-router";
import { COOKIE_SESSION, SessionContext, type SessionValue } from "../app/session";
import { ToastProvider } from "../components/ui/ToastProvider";
import { can, type Role } from "../lib/rbac";

/** Render inside the app's providers, signed in as `role`. No network: pass fake APIs to pages. */
export function renderAs(role: Role, ui: ReactElement) {
  const session: SessionValue = {
    token: COOKIE_SESSION,
    user: { id: `u-${role}`, username: role, name: role, role, allowedCityIds: role === "analyst" ? ["city-1"] : [] },
    role,
    can: (p) => can(role, p),
    setUser: () => {},
    signOut: async () => {},
    expire: () => {},
    theme: "light",
    toggleTheme: () => {},
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MotionConfig reducedMotion="always">
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <MemoryRouter>{ui}</MemoryRouter>
          </ToastProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    </MotionConfig>,
  );
}
