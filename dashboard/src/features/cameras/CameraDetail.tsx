import type { ReactNode } from "react";
import { Link } from "react-router";
import { History, Pencil, ScrollText, Video } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Drawer } from "../../components/ui/Drawer";
import { Skeleton } from "../../components/ui/Skeleton";
import { formatTime, relativeTime } from "../../lib/format";
import { useCameraAudit, useStatusHistory } from "./hooks";
import { assembledUrlPreview, KIND_LABELS, STATUS_LABELS } from "./logic";
import { MiniMap } from "./map";
import { STATUS_COLOR } from "./style";
import { CredentialsChip, KindIcon, ProtocolBadge, StatusChip, TlsBadge } from "./ui";
import type { CameraRegistryApi, RegistryCamera } from "./types";

export function CameraDetail({ camera, cityName, open, onClose, canWrite, canAudit, canLive, onEdit, api }: {
  camera: RegistryCamera | null;
  cityName: string;
  open: boolean;
  onClose: () => void;
  canWrite: boolean;
  canAudit: boolean;
  canLive: boolean;
  onEdit: () => void;
  api: CameraRegistryApi;
}) {
  const history = useStatusHistory(open && camera ? camera.id : null, api);
  const audit = useCameraAudit(open && camera ? camera.id : null, canAudit, api);
  if (!camera) return null;
  const c = camera;
  const url = assembledUrlPreview({ protocol: c.protocol, host: c.host, port: c.port, streamPath: c.streamPath, withCredentials: c.credentialsSet });
  const fields: [string, ReactNode][] = [
    ["City", cityName], ["District", c.district], ["Street address", c.streetAddress], ["Lane", c.lane],
    ["Position", <span className="font-mono">{c.latitude.toFixed(6)}, {c.longitude.toFixed(6)}</span>],
    ["View direction", c.viewDirectionDeg !== null ? `${c.viewDirectionDeg}°` : null],
    ["Owner", c.owner], ["Installed on", c.installedOn], ["Firmware", c.firmwareVersion && <span className="font-mono">{c.firmwareVersion}</span>],
    ["Host", c.host && <span className="font-mono">{c.host}{c.port ? `:${c.port}` : ""}</span>], ["Stream path", c.streamPath && <span className="font-mono">{c.streamPath}</span>],
    ["VLAN", c.vlan], ["Last frame", c.lastFrameAt ? relativeTime(c.lastFrameAt) : "Never"], ["Updated", relativeTime(c.updatedAt)],
  ];

  return (
    <Drawer
      open={open}
      onRequestClose={onClose}
      width="max-w-2xl"
      title={<span className="flex items-center gap-2.5"><span className="grid size-9 place-items-center rounded-[10px] bg-accent-soft text-accent"><KindIcon kind={c.kind} size={17} /></span>{c.name}</span>}
      subtitle={<span className="flex flex-wrap items-center gap-2"><StatusChip status={c.status} /><ProtocolBadge protocol={c.protocol} /><CredentialsChip set={c.credentialsSet} protocol={c.protocol} /><TlsBadge tlsNotAfter={c.tlsNotAfter} /><span className="text-xs">{KIND_LABELS[c.kind]}</span></span>}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {canLive && <Link to={`/camera/${encodeURIComponent(c.id)}`} className="focus-ring inline-flex h-10 items-center gap-2 rounded-sm border border-border bg-surface/70 px-4 text-sm font-medium hover:bg-bg-subtle"><Video size={15} aria-hidden /> Open live view</Link>}
          {canWrite && <Button variant="primary" onClick={onEdit}><Pencil size={14} aria-hidden /> Edit camera</Button>}
        </div>
      }
    >
      <div className="space-y-6">
        <div className="overflow-hidden rounded-md border border-border"><MiniMap camera={c} /></div>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {fields.map(([k, v]) => (
            <div key={k} className="min-w-0 border-b border-border/60 pb-2"><dt className="text-xs text-muted">{k}</dt><dd className="truncate text-sm font-medium">{v ?? <span className="text-faint">—</span>}</dd></div>
          ))}
        </dl>
        {url && (
          <div className="rounded-md bg-bg-subtle/60 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Stream URL (assembled at runtime)</p>
            <p className="mt-1 break-all font-mono text-xs">{url}</p>
          </div>
        )}
        {c.notes && <p className="whitespace-pre-wrap rounded-md border border-border p-3 text-sm">{c.notes}</p>}

        <section>
          <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold"><History size={16} className="text-accent" aria-hidden /> Status history</h3>
          {history.isLoading ? <Skeleton className="h-20" /> : history.error ? <p className="text-sm text-danger">Could not load the history.</p> : (
            <ol className="relative space-y-3 border-l border-border pl-5">
              {(history.data ?? []).map((e, i) => (
                <li key={`${e.at}-${i}`} className="relative">
                  <span className="absolute -left-[25px] top-1 size-2.5 rounded-full ring-4 ring-surface" style={{ background: STATUS_COLOR[e.status] }} aria-hidden />
                  <p className="text-sm"><span className="font-medium">{STATUS_LABELS[e.status]}</span> <span className="text-muted">· {e.reason}</span></p>
                  <p className="text-xs text-faint tabular">{new Date(e.at).toLocaleDateString()} {formatTime(e.at)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>

        {canAudit && (
          <section>
            <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold"><ScrollText size={16} className="text-accent" aria-hidden /> Recent audit entries</h3>
            {audit.isLoading ? <Skeleton className="h-20" /> : audit.error ? <p className="text-sm text-danger">Could not load the audit entries.</p> : !audit.data?.length ? <p className="text-sm text-muted">No entries yet.</p> : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {audit.data.map((a) => (
                  <li key={a.seq} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0"><span className="font-mono text-xs">{a.action}</span>{a.justification && <span className="block truncate text-xs text-muted">{a.justification}</span>}</span>
                    <span className="shrink-0 text-right text-xs text-faint tabular">#{a.seq} · {a.actorRole}<br />{relativeTime(a.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </Drawer>
  );
}
