/*
 * /admin/cameras: Cities & Cameras. Admins manage everything; analysts get a read-only view of
 * their own cities; auditors are refused (route guard here, 403 from the API regardless).
 * The UI hiding a button is a convenience only: every rule is enforced by the server.
 */
import { useCallback, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Eye, FileUp, HeartPulse, LayoutGrid, Map as MapIcon, Plus, Rows3 } from "lucide-react";
import { ApiError } from "../../api/errors";
import { useSession } from "../../app/session";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { PageHeader } from "../../components/ui/PageHeader";
import { ErrorState, NoAccessState } from "../../components/ui/States";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/toast";
import { cn } from "../../lib/cn";
import { readPref, writePref } from "../../lib/storage";
import { registry } from "./api";
import { CameraDetail } from "./CameraDetail";
import { CamerasTab, type RowAction } from "./CamerasTab";
import { CameraWizard } from "./CameraWizard";
import { CityRail } from "./CityRail";
import { LocalCameraCard } from "./LocalCamera";
import { HealthTab } from "./HealthTab";
import { LiveWall } from "./LiveWall";
import { useCameras, useCities, useRegistryMutations } from "./hooks";
import { CredentialsDialog, ImportDialog } from "./ImportDialog";
import { summarize, type CameraForm } from "./logic";
import { RegistryMap } from "./map";
import { SummaryStrip } from "./SummaryStrip";
import { ConnectionTimeline } from "./widgets";
import { CAMERA_STATUSES, type CameraRegistryApi, type CameraStatus, type ConnectionTestResult, type RegistryCamera } from "./types";

type Tab = "cameras" | "wall" | "map" | "health";
/** This PC's webcam: a local source (protocol File) the browser can monitor on the Live page. */
const WEBCAM_PRESET: Partial<CameraForm> = { name: "This PC webcam", kind: "fixed_cctv", protocol: "file", notes: "Local webcam monitored from the Live surveillance page." };
const TABS: { id: Tab; label: string; icon: typeof Rows3 }[] = [
  { id: "cameras", label: "Cameras", icon: Rows3 },
  { id: "wall", label: "Live wall", icon: LayoutGrid },
  { id: "map", label: "Map", icon: MapIcon },
  { id: "health", label: "Health", icon: HeartPulse },
];

export default function CamerasPage({ api = registry }: { api?: CameraRegistryApi }) {
  const { role, can } = useSession();
  const canWrite = role === "admin" || role === "super_admin";
  const cities = useCities(api);
  const cameras = useCameras(api);
  const m = useRegistryMutations(api);
  const toast = useToast();

  const [tab, setTab] = useState<Tab>(() => (["wall", "map", "health"].includes(readPref("cameras.tab") ?? "") ? (readPref("cameras.tab") as Tab) : "cameras"));
  const [cityId, setCityId] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ camera: RegistryCamera | null; preset?: Partial<CameraForm> } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [credsFor, setCredsFor] = useState<RegistryCamera | null>(null);
  const [deleting, setDeleting] = useState<RegistryCamera[] | null>(null);
  const [testing, setTesting] = useState<{ camera: RegistryCamera; running: boolean; result: ConnectionTestResult | null; error: string | null } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const all = useMemo(() => cameras.data ?? [], [cameras.data]);
  const visible = useMemo(() => (cityId ? all.filter((c) => c.cityId === cityId) : all), [all, cityId]);
  const cityName = useCallback((id: string) => cities.data?.find((c) => c.id === id)?.name ?? "—", [cities.data]);
  const summary = cameras.data && cities.data ? summarize(visible, cityId ? 1 : cities.data.length) : null;
  const byStatus = cameras.data ? (Object.fromEntries(CAMERA_STATUSES.map((s) => [s, visible.filter((c) => c.status === s).length])) as Record<CameraStatus, number>) : null;
  const detail = all.find((c) => c.id === detailId) ?? null;

  const forbidden = [cities.error, cameras.error].some((e) => e instanceof ApiError && e.status === 403);
  if (forbidden) return <><PageHeader eyebrow="Registry" title="Cities & Cameras" /><NoAccessState what="the camera registry" /></>;

  const pickTab = (t: Tab) => { setTab(t); writePref("cameras.tab", t); };

  const fail = (title: string) => (e: unknown) => toast({ tone: "error", title, body: e instanceof ApiError ? e.message : undefined });

  const runTest = async (camera: RegistryCamera) => {
    setTesting({ camera, running: true, result: null, error: null });
    try {
      const result = await m.testConnection.mutateAsync(camera.id);
      setTesting({ camera, running: false, result, error: null });
    } catch (e) {
      setTesting({ camera, running: false, result: null, error: e instanceof ApiError ? e.message : "The test could not run." });
    }
  };

  const onAction = (action: RowAction, camera: RegistryCamera) => {
    if (action === "edit") setWizard({ camera });
    if (action === "credentials") setCredsFor(camera);
    if (action === "delete") setDeleting([camera]);
    if (action === "test") void runTest(camera);
    if (action === "maintenance") {
      const status: CameraStatus = camera.status === "maintenance" ? "unknown" : "maintenance";
      m.updateCamera.mutateAsync({ id: camera.id, patch: { status } })
        .then(() => toast({ tone: "success", title: status === "maintenance" ? "Maintenance mode on" : "Maintenance ended", body: camera.name }))
        .catch(fail("Could not change the status"));
    }
  };

  const onBulk = async (action: "maintenance" | "test" | "delete", list: RegistryCamera[]) => {
    if (action === "delete") return setDeleting(list);
    let ok = 0;
    for (const c of list) {
      try {
        if (action === "maintenance") await m.updateCamera.mutateAsync({ id: c.id, patch: { status: "maintenance" } });
        else if ((await m.testConnection.mutateAsync(c.id)).reachable) ok++;
        if (action === "maintenance") ok++;
      } catch {
        // counted as not ok; the server's reason is shown on a single-camera test
      }
    }
    toast({
      tone: ok === list.length ? "success" : "info",
      title: action === "maintenance" ? `${ok} of ${list.length} set to maintenance` : `${ok} of ${list.length} reachable`,
      body: action === "test" ? "Network reachability only; streams are not verified." : undefined,
    });
  };

  return (
    <>
      <PageHeader
        eyebrow="Registry"
        title="Cities & Cameras"
        description={canWrite
          ? "Every camera, where it is, how it connects and whether it is healthy. Locations and network details are sensitive and only visible to the people who need them."
          : "Read-only view of the cameras in your cities."}
        actions={canWrite && (
          <>
            <Button onClick={() => setImportOpen(true)}><FileUp size={15} aria-hidden /> Import CSV</Button>
            <Button variant="primary" onClick={() => setWizard({ camera: null })} disabled={!cities.data?.length} title={cities.data?.length ? undefined : "Add a city first"}>
              <Plus size={15} aria-hidden /> Add camera
            </Button>
          </>
        )}
      />
      {!canWrite && (
        <p className="mb-4 flex items-center gap-2 rounded-sm border border-border bg-bg-subtle/60 px-4 py-2.5 text-sm text-muted" role="note">
          <Eye size={15} className="text-accent" aria-hidden /> You can view cameras in your assigned cities. Changes are made by an Admin.
        </p>
      )}

      <SummaryStrip summary={summary} byStatus={byStatus} />

      {cameras.error || cities.error ? (
        <ErrorState error={cameras.error ?? cities.error} onRetry={() => { void cameras.refetch(); void cities.refetch(); }} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <CityRail
            cities={cities.data}
            cameras={all}
            selected={cityId}
            onSelect={setCityId}
            canWrite={canWrite}
            onCreate={(v) => m.createCity.mutateAsync(v)}
            onUpdate={(v) => m.updateCity.mutateAsync(v)}
            onDelete={(id) => m.deleteCity.mutateAsync(id)}
          />
          <section aria-label="Cameras" className="min-w-0">
            <div role="tablist" aria-label="Views" className="mb-4 inline-flex rounded-full border border-border bg-surface/60 p-1">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} id={`tab-${t.id}`} onClick={() => pickTab(t.id)}
                  className={cn("focus-ring relative flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors", tab === t.id ? "text-accent" : "text-muted hover:text-text")}>
                  {tab === t.id && <motion.span layoutId="cameras-tab" className="absolute inset-0 rounded-full bg-accent-soft shadow-1" transition={{ type: "spring", stiffness: 380, damping: 32 }} aria-hidden />}
                  <t.icon size={15} className="relative" aria-hidden /><span className="relative">{t.label}</span>
                </button>
              ))}
            </div>
            <AnimatePresence mode="wait">
              <motion.div key={tab} id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
                {!cameras.data || !cities.data ? (
                  <div className="space-y-2" role="status" aria-label="Loading cameras">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14 rounded-md" />)}</div>
                ) : tab === "cameras" ? (
                  <>
                  {/* the PC webcam stands in until the first real camera is registered */}
                  {all.length === 0 && <div className="mb-4"><LocalCameraCard onRegister={canWrite && cities.data.length ? () => setWizard({ camera: null, preset: WEBCAM_PRESET }) : undefined} /></div>}
                  <CamerasTab cameras={visible} cityName={cityName} canWrite={canWrite} onOpen={setDetailId} onAction={onAction} onBulk={onBulk}
                    onAdd={canWrite && cities.data.length ? () => setWizard({ camera: null }) : undefined}
                    emptyHint={canWrite ? (cities.data.length ? "Add the first camera, or import a CSV." : "Add a city first, then its cameras.") : "No camera is registered in your cities yet."} />
                  </>
                ) : tab === "wall" ? (
                  <LiveWall cameras={visible} cityName={cityName} canLive={can("camera:live")} onOpen={setDetailId} />
                ) : tab === "map" ? (
                  <div className="card-surface relative h-[calc(100vh-var(--topbar-h)-15rem)] min-h-[420px] overflow-hidden rounded-lg p-1.5">
                    <RegistryMap cameras={visible} cityName={cityName} onOpen={setDetailId} />
                  </div>
                ) : (
                  <HealthTab cameras={visible} cities={cityId ? cities.data.filter((c) => c.id === cityId) : cities.data} onOpen={setDetailId} />
                )}
              </motion.div>
            </AnimatePresence>
          </section>
        </div>
      )}

      {wizard && cities.data && (
        <CameraWizard
          key={wizard.camera?.id ?? "new"}
          open
          onClose={() => setWizard(null)}
          cities={cities.data}
          camera={wizard.camera}
          preset={wizard.preset}
          defaultCityId={cityId ?? undefined}
          api={{
            createCamera: (d) => m.createCamera.mutateAsync(d),
            updateCamera: (id, patch) => m.updateCamera.mutateAsync({ id, patch }),
            replaceCredentials: (id, credentials) => m.replaceCredentials.mutateAsync({ id, credentials }),
            testConnection: (id) => m.testConnection.mutateAsync(id),
            testDraftConnection: (v) => api.testDraftConnection(v),
          }}
          onSaved={() => {}}
        />
      )}
      <CameraDetail camera={detail} cityName={detail ? cityName(detail.cityId) : ""} open={!!detail} onClose={() => setDetailId(null)}
        canWrite={canWrite} canAudit={can("audit:view") && canWrite} canLive={can("camera:live")} api={api}
        onEdit={() => { const c = detail; setDetailId(null); if (c) setWizard({ camera: c }); }} />
      <CredentialsDialog cameraName={credsFor?.name ?? ""} open={!!credsFor} onClose={() => setCredsFor(null)}
        onSubmit={async (credentials) => {
          await m.replaceCredentials.mutateAsync({ id: credsFor!.id, credentials });
          toast({ tone: "success", title: "Credentials replaced", body: `${credsFor!.name} · stored encrypted` });
        }} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} api={api} cities={cities.data ?? []} onImported={() => { void cameras.refetch(); }} />
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title={deleting?.length === 1 ? `Delete ${deleting[0].name}?` : `Delete ${deleting?.length} cameras?`}
        description="Cameras with recorded detections cannot be deleted; use maintenance mode for those. Every deletion is recorded in the audit log.">
        <div className="flex justify-end gap-2">
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={async () => {
            const list = deleting ?? [];
            setDeleting(null);
            let done = 0;
            for (const c of list) {
              try { await m.deleteCamera.mutateAsync(c.id); done++; } catch (e) { fail(`Could not delete ${c.name}`)(e); }
            }
            if (done) toast({ tone: "success", title: `${done} camera${done === 1 ? "" : "s"} deleted` });
          }}>Delete</Button>
        </div>
      </Dialog>
      <Dialog open={!!testing} onClose={() => setTesting(null)} title={`Test connection · ${testing?.camera.name ?? ""}`} description="DNS, TCP and (for RTSPS) TLS, from the server. It does not log in or decode video.">
        {testing && <ConnectionTimeline running={testing.running} result={testing.result} error={testing.error} tls={testing.camera.protocol === "rtsps"} />}
        <div className="mt-5 flex justify-end"><Button onClick={() => setTesting(null)}>Close</Button></div>
      </Dialog>
    </>
  );
}
