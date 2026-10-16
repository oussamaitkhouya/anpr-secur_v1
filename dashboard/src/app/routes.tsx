import type { ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "../components/layout/AppShell";
import { NAV } from "./nav";
import { Guard, NotFound } from "./RouteViews";
import { NotConnected } from "./NotConnected";
import { RouteError } from "./RouteError";
import { demoMode } from "../api/client";
import OverviewPage from "../features/operations/OverviewPage";
import AlertsPage from "../features/operations/AlertsPage";
import AdminUsers from "../pages/admin/AdminUsers";
import CamerasPage from "../features/cameras/CamerasPage";
import AuditPage from "../features/insight/AuditPage";
import EvidencePage from "../features/insight/EvidencePage";
import LiveCameraPage from "../features/insight/LiveCameraPage";
import ModelsPage from "../features/insight/ModelsPage";
import SearchPage from "../features/insight/SearchPage";
import SecurityPage from "../features/insight/SecurityPage";
import SettingsPage from "../features/insight/SettingsPage";

import WatchlistsPage from "../features/watchlists/WatchlistsPage";

/** Wrap a page in the RBAC guard of its nav entry, so routes and sidebar use the same rule. */
function guarded(navPath: string, element: ReactNode) {
  const item = NAV.find((n) => n.path === navPath);
  if (!item) throw new Error(`no nav entry for ${navPath}`);
  const page = item.connected || demoMode ? element : <NotConnected />;
  return <Guard permission={item.permission} what={item.label}>{page}</Guard>;
}

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [{
      // pathless layout route: a page that throws renders RouteError inside the shell
      errorElement: <RouteError />,
      children: [
      { path: "/", element: guarded("/", <OverviewPage />) },
      { path: "/alerts", element: guarded("/alerts", <AlertsPage />) },
      { path: "/camera", element: guarded("/camera", <LiveCameraPage />) },
      { path: "/camera/:id", element: guarded("/camera", <LiveCameraPage />) },
      { path: "/admin/users", element: guarded("/admin/users", <AdminUsers />) },
      { path: "/admin/cameras", element: guarded("/admin/cameras", <CamerasPage />) },
      { path: "/admin/watchlists", element: guarded("/admin/watchlists", <WatchlistsPage />) },
      { path: "/search", element: guarded("/search", <SearchPage />) },
      { path: "/evidence", element: guarded("/evidence", <EvidencePage />) },
      { path: "/evidence/:id", element: <Navigate to="/evidence" replace /> },
      { path: "/audit", element: guarded("/audit", <AuditPage />) },
      { path: "/security", element: guarded("/security", <SecurityPage />) },
      { path: "/models", element: guarded("/models", <ModelsPage />) },
      { path: "/cameras", element: <Navigate to="/admin/cameras" replace /> }, // merged into Cities & Cameras
      { path: "/settings", element: guarded("/settings", <SettingsPage />) },
      { path: "*", element: <NotFound /> },
      ],
    }],
  },
]);
