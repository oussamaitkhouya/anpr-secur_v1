import { useMemo } from "react";
import { Link } from "react-router";
import { Video } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { Camera, City } from "../api/types";
import { useSession } from "../app/session";
import { Badge } from "../components/ui/Badge";
import { Card, CardHeader, RevealGroup } from "../components/ui/Card";
import { PageHeader } from "../components/ui/PageHeader";
import { LoadingBlock } from "../components/ui/Skeleton";
import { EmptyState, ErrorState } from "../components/ui/States";
import { CAMERA_STATUS, TLS_STATUS } from "../components/ui/tones";
import { SOURCE_ICONS, SOURCE_LABELS } from "../components/ui/cameraSource";
import { cn } from "../lib/cn";
import { formatDecimal, formatNumber, relativeTime } from "../lib/format";

export default function CamerasList() {
  const { role, user, can } = useSession();
  const cameras = useApi((ctx) => api.getCameras(ctx));
  const cities = useApi((ctx) => api.getCities(ctx));

  const byCity = useMemo(() => {
    const groups = new Map<string, { city: City; cameras: Camera[] }>();
    for (const c of cities.data ?? []) groups.set(c.id, { city: c, cameras: [] });
    for (const cam of cameras.data ?? []) groups.get(cam.cityId)?.cameras.push(cam);
    return [...groups.values()];
  }, [cameras.data, cities.data]);

  const error = cameras.error ?? cities.error;
  const total = cameras.data?.length ?? 0;
  const online = cameras.data?.filter((c) => c.status === "online").length ?? 0;

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Cameras"
        description={
          role === "analyst"
            ? `Cameras in the ${user.allowedCityIds.length === 1 ? "city" : "cities"} you are allowed to monitor.`
            : "Every camera, grouped by city."
        }
        actions={cameras.data && <Badge tone={online === total ? "ok" : "warn"} dot>{online} of {total} online</Badge>}
      />
      {error ? (
        <ErrorState error={error} onRetry={() => { cameras.reload(); cities.reload(); }} />
      ) : !cameras.data || !cities.data ? (
        <LoadingBlock className="rounded-lg border border-border bg-surface" label="Loading cameras" />
      ) : byCity.length === 0 ? (
        <EmptyState title="No cities assigned">Ask an Admin to give your account access to a city.</EmptyState>
      ) : (
        <RevealGroup className="space-y-6">
          {byCity.map(({ city, cameras: list }) => (
            <Card key={city.id} className="overflow-hidden">
              <CardHeader
                title={<span className="flex items-center gap-2">{city.name} {city.demo && <Badge className="h-5 text-[10px] uppercase tracking-wide">Demo</Badge>}</span>}
                subtitle={`${list.length} camera${list.length === 1 ? "" : "s"}`}
                actions={can("admin:cameras") && <Link to="/admin/cameras" className="text-sm text-accent hover:underline">Manage</Link>}
              />
              {list.length === 0 ? (
                <p className="px-6 pb-6 pt-3 text-sm text-muted">No cameras in this city yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="mt-3 w-full text-left text-sm">
                    <thead>
                      <tr className="border-y border-border text-[11px] uppercase tracking-[0.08em] text-faint">
                        <th scope="col" className="px-6 py-2.5 font-medium">Camera</th>
                        <th scope="col" className="px-4 py-2.5 font-medium">Source</th>
                        <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                        <th scope="col" className="px-4 py-2.5 font-medium">Uptime 30 d</th>
                        <th scope="col" className="px-4 py-2.5 font-medium">TLS</th>
                        <th scope="col" className="px-4 py-2.5 font-medium">Last frame</th>
                        <th scope="col" className="px-4 py-2.5 font-medium">Reads today</th>
                        <th scope="col" className="px-6 py-2.5"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((c) => {
                        const Icon = SOURCE_ICONS[c.sourceType];
                        const status = CAMERA_STATUS[c.status];
                        return (
                          <tr key={c.id} className="border-b border-border/70 last:border-0">
                            <td className="px-6 py-3">
                              <span className="block font-medium">{c.name}</span>
                              <span className="font-mono text-[11.5px] text-muted">{c.id}</span>
                            </td>
                            <td className="px-4 py-3"><span className="flex items-center gap-1.5 whitespace-nowrap text-muted"><Icon size={14} aria-hidden /> {SOURCE_LABELS[c.sourceType]}</span></td>
                            <td className="px-4 py-3"><Badge tone={status.tone} dot>{status.label}</Badge></td>
                            <td className="px-4 py-3 font-mono tabular">{c.uptimePct ? `${formatDecimal(c.uptimePct)}%` : "—"}</td>
                            <td className="px-4 py-3">{c.tlsStatus === "not_applicable" ? <span className="text-faint">n/a</span> : <Badge tone={TLS_STATUS[c.tlsStatus].tone}>{TLS_STATUS[c.tlsStatus].label}</Badge>}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-muted">{c.lastFrameAt ? relativeTime(c.lastFrameAt) : "never"}</td>
                            <td className="px-4 py-3 font-mono tabular">{formatNumber(c.readsToday)}</td>
                            <td className="px-6 py-3 text-right">
                              {can("camera:live") && (
                                <Link
                                  to={`/camera/${c.id}`}
                                  className={cn(
                                    "focus-ring inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-[13px] font-medium",
                                    c.sourceType === "browser-webcam" ? "bg-accent text-accent-fg shadow-1 hover:bg-accent-hover" : "border border-border bg-surface text-muted hover:text-text",
                                  )}
                                >
                                  <Video size={14} aria-hidden /> Open live view
                                </Link>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}
        </RevealGroup>
      )}
    </>
  );
}
