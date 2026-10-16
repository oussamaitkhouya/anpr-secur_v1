/*
 * "This computer" camera: shown in Cities & Cameras while the registry has no camera yet.
 *
 * It is NOT a registry record: a webcam has no city, GPS position or network address, and
 * storing one would mean inventing them. The preview uses getUserMedia (video only, no audio),
 * stays in this browser, sends nothing to the server and records nothing. The stream stops
 * (camera light off) when the preview closes or the page unmounts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Laptop, MonitorPlay, ShieldCheck, VideoOff } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Drawer } from "../../components/ui/Drawer";
import { setCameraActive } from "../../camera/activeStore";
import { listCameras, requestCamera, stopStream, type MediaDevicesLike } from "../../camera/permission";
import { cn } from "../../lib/cn";

const media = (): MediaDevicesLike | undefined => (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);

/** Video inputs on this machine, refreshed when a device is plugged in or out. */
function useLocalDevices() {
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[] | null>(null);
  const refresh = useCallback(() => {
    void listCameras(media()).then(setDevices);
  }, []);
  useEffect(() => {
    refresh();
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    md?.addEventListener?.("devicechange", refresh);
    return () => md?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);
  return { devices, refresh, supported: !!media()?.getUserMedia };
}

export function LocalCameraCard({ onRegister }: { onRegister?: () => void }) {
  const { devices, refresh, supported } = useLocalDevices();
  const [open, setOpen] = useState(false);
  const count = devices?.length ?? 0;
  const state = !supported ? "unsupported" : devices === null ? "checking" : count ? "found" : "none";

  return (
    <>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="card-surface relative overflow-hidden rounded-lg p-5" data-testid="local-camera">
        <span className="pointer-events-none absolute -right-10 -top-10 size-36 rounded-full bg-accent-2 opacity-20 blur-3xl" aria-hidden />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span className="btn-primary relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-[14px]">
              <Laptop size={22} aria-hidden />
              {state === "found" && <span className="scan-beam" aria-hidden />}
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-display text-lg font-semibold">
                This computer&apos;s camera
                <span className="rounded-full border border-border px-2 py-0.5 font-sans text-[11px] font-medium text-muted">Local device</span>
              </p>
              <p className="text-sm text-muted">
                {state === "found" ? `${count} camera${count === 1 ? "" : "s"} detected on this PC${devices?.[0]?.label && !/^Camera \d+$/.test(devices[0].label) ? `: ${devices[0].label}` : ""}.`
                  : state === "none" ? "No camera detected on this PC."
                  : state === "unsupported" ? "This browser cannot use a camera here (needs HTTPS or localhost)."
                  : "Looking for cameras…"}
              </p>
            </div>
          </div>
          <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
            state === "found" ? "bg-ok-soft text-ok" : state === "checking" ? "bg-bg-subtle text-muted" : "bg-warn-soft text-warn")}>
            <span className={cn("size-1.5 rounded-full", state === "found" ? "bg-ok" : state === "checking" ? "bg-faint" : "bg-warn")} aria-hidden />
            {state === "found" ? "Available" : state === "checking" ? "Checking" : "Unavailable"}
          </span>
        </div>
        <div className="relative mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck size={13} className="text-accent" aria-hidden />
            Register it (protocol File) to monitor it live and detect plates. Until then it is not in the registry; the preview never leaves this browser.
          </p>
          <div className="flex gap-2">
            {state === "none" && <Button size="sm" variant="ghost" onClick={refresh}>Check again</Button>}
            {onRegister && state === "found" && <Button size="sm" onClick={onRegister}>Register as a camera</Button>}
            <Button size="sm" variant="primary" onClick={() => setOpen(true)} disabled={state === "unsupported"}>
              <MonitorPlay size={14} aria-hidden /> Preview
            </Button>
          </div>
        </div>
      </motion.div>
      <LocalPreview open={open} onClose={() => setOpen(false)} devices={devices ?? []} onDevicesChanged={refresh} />
    </>
  );
}

function LocalPreview({ open, onClose, devices, onDevicesChanged }: {
  open: boolean;
  onClose: () => void;
  devices: { deviceId: string; label: string }[];
  onDevicesChanged: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [status, setStatus] = useState<{ kind: "idle" | "starting" | "live" | "error"; message?: string; label?: string }>({ kind: "idle" });

  const stop = useCallback(() => {
    stopStream(stream.current);
    stream.current = null;
    setCameraActive(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setStatus({ kind: "starting" });
    void requestCamera(media(), { deviceId: deviceId || null }).then(({ event, stream: s }) => {
      if (!live) {
        stopStream(s);
        return;
      }
      if (event.type === "GRANTED" && s) {
        stop();
        stream.current = s;
        setCameraActive(true);
        if (video.current) video.current.srcObject = s;
        setStatus({ kind: "live", label: event.label });
        onDevicesChanged(); // labels become readable once permission is granted
      } else {
        setStatus({ kind: "error", message: "message" in event ? event.message : "The camera could not be started." });
      }
    });
    return () => {
      live = false;
      stop();
    };
  }, [open, deviceId, stop, onDevicesChanged]);

  return (
    <Drawer open={open} onRequestClose={onClose} width="max-w-3xl" title="This computer's camera" subtitle="Live preview. Video only, no audio. Nothing is sent to the server or recorded.">
      <div className="space-y-4">
        <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-[var(--plate-ink)]">
          <video ref={video} autoPlay playsInline muted className={cn("h-full w-full object-cover", status.kind !== "live" && "opacity-0")} aria-label="Live preview from this computer's camera" />
          {status.kind === "live" && (
            <>
              {["left-3 top-3 border-l-2 border-t-2", "right-3 top-3 border-r-2 border-t-2", "bottom-3 left-3 border-b-2 border-l-2", "bottom-3 right-3 border-b-2 border-r-2"].map((c) => (
                <span key={c} className={`pointer-events-none absolute size-6 rounded-[3px] border-accent-2 ${c}`} aria-hidden />
              ))}
              <span className="absolute left-4 top-4 ml-8 flex items-center gap-2 rounded-full bg-black/50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-white">
                <span className="size-1.5 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden /> Live · local only
              </span>
            </>
          )}
          {status.kind !== "live" && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/80">
              {status.kind === "starting" ? "Starting the camera… your browser may ask for permission." : (
                <span className="flex flex-col items-center gap-2"><VideoOff size={22} aria-hidden />{status.message}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {devices.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Camera</span>
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="focus-ring h-9 rounded-sm border border-border bg-surface px-2 text-sm">
                <option value="">Default</option>
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </label>
          ) : <span className="text-sm text-muted">{status.label ?? ""}</span>}
          <Button onClick={onClose}>Stop and close</Button>
        </div>
        <p className="text-xs text-muted">
          To use this webcam for plate reading, register it as a camera with its real location; the detection pipeline then sends its reads to the API.
        </p>
      </div>
    </Drawer>
  );
}
