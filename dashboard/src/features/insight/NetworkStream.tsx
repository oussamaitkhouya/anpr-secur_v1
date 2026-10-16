/*
 * Live video of a network camera (RTSP/RTSPS), relayed by the API as MJPEG
 * (GET /cameras/{id}/stream.mjpg, src/anpr/api/routes/stream.py). The browser never sees the
 * camera's address or credentials: the API opens the stream and reads plates on it; the boxes
 * are drawn into the video on the server.
 *
 * The API ends each connection after the access-token lifetime, and a 401 means the cookie
 * expired: polling the relay's state goes through v1.call, which refreshes the session, and the
 * <img> then reconnects with the fresh cookie.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, VideoOff } from "lucide-react";
import { API_BASE, v1 } from "../../api/v1";
import { cn } from "../../lib/cn";

export interface StreamStatus {
  state: "idle" | "connecting" | "live" | "error";
  message: string | null;
  width: number | null;
  height: number | null;
  fps: number;
  viewers: number;
  reads: number;
  lastReadAt: string | null;
}

const RETRY_MS = 3000;

export const streamUrl = (cameraId: string, attempt: number) =>
  `${API_BASE}/api/v1/cameras/${encodeURIComponent(cameraId)}/stream.mjpg?attempt=${attempt}`;

export function useStreamStatus(cameraId: string, enabled = true) {
  return useQuery({
    queryKey: ["stream", cameraId],
    queryFn: () => v1.call<StreamStatus>("GET", `/cameras/${encodeURIComponent(cameraId)}/stream`),
    refetchInterval: 3000,
    enabled,
  });
}

/** The camera's video, filling its parent (which sets the aspect ratio). */
export function NetworkStream({ cameraId, cameraName, status, className }: {
  cameraId: string;
  cameraName: string;
  status: StreamStatus | undefined;
  className?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retry = useRef<number | undefined>(undefined);

  const reconnect = useCallback(() => {
    window.clearTimeout(retry.current);
    retry.current = window.setTimeout(() => { setLoaded(false); setAttempt((a) => a + 1); }, RETRY_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(retry.current), []);

  // Our connection ended (token lifetime reached, camera edited): the relay shows idle. Reconnect.
  useEffect(() => {
    if (loaded && status?.state === "idle") reconnect();
  }, [loaded, status?.state, reconnect]);

  const failed = status?.state === "error";
  return (
    <div className={cn("relative h-full w-full bg-[radial-gradient(70%_60%_at_50%_40%,var(--bg-subtle),var(--plate-ink))]", className)}>
      <img key={attempt} src={streamUrl(cameraId, attempt)} alt={`Live video from ${cameraName}`}
        onLoad={() => setLoaded(true)} onError={reconnect}
        className={cn("block h-full w-full object-contain transition-opacity duration-300", loaded ? "opacity-100" : "opacity-0")} />
      {(!loaded || failed) && (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white/85" role="status">
          {failed ? (
            <span className="flex max-w-sm flex-col items-center gap-2 rounded-md bg-black/55 px-4 py-3 backdrop-blur-sm">
              <VideoOff size={22} aria-hidden />{status?.message ?? "The stream is unavailable."}
              <span className="text-xs text-white/60">Retrying automatically.</span>
            </span>
          ) : (
            <span className="flex items-center gap-2"><Loader2 size={16} className="motion-safe:animate-spin" aria-hidden /> Connecting to the camera…</span>
          )}
        </div>
      )}
    </div>
  );
}
