/*
 * Monitoring one local camera (protocol File) from this browser: open the webcam, send ~2
 * frames/s to POST /cameras/{id}/frames, draw the returned plate boxes over the video, and
 * surface watchlist alerts. Used by the single-camera Live page and by every tile of the
 * Live wall, so both behave the same way.
 *
 * One frame in flight at a time (no backlog); on 429 the interval doubles. Frames go to the API
 * only; the API keeps a frame solely when it produced a report (evidence, 30-day retention).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors";
import { v1 } from "../../api/v1";
import { setCameraActive } from "../../camera/activeStore";
import { listCameras, requestCamera, stopStream } from "../../camera/permission";
import { useToast } from "../../components/ui/toast";
import { opsKeys } from "../operations/api";

export interface LiveBox { x: number; y: number; w: number; h: number; boxConfidence: number; plate: string | null; plateMasked: boolean; plateValid: boolean; confidence: number; reported: boolean }
export interface LiveAlert { id: string; kind: string; reason: string; listName: string; plate: string }
interface FrameResult { width: number; height: number; inferenceMs: number; readsPlates: boolean; boxes: LiveBox[]; alerts: LiveAlert[] }
export interface Hit { id: string; at: string; plate: string; valid: boolean; confidence: number; alert: LiveAlert | null }
export interface MonitorStats { frames: number; plates: number; alerts: number; ms: number; fps: number }
export type MonitorState = { kind: "idle" | "starting" | "live" | "error"; message?: string };

const BASE_INTERVAL_MS = 500;
const MAX_WIDTH = 1280;

export function useLiveMonitor({ cameraId, cameraName, video, overlay, initialDeviceId = "" }: {
  cameraId: string;
  cameraName: string;
  video: RefObject<HTMLVideoElement | null>;
  overlay: RefObject<HTMLCanvasElement | null>;
  initialDeviceId?: string;
}) {
  const grab = useRef<HTMLCanvasElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const running = useRef(false);
  const gen = useRef(0); // each start gets a generation; an older loop sees a newer one and exits
  const interval = useRef(BASE_INTERVAL_MS);
  const owner = `monitor:${cameraId}`;
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState<MonitorState>({ kind: "idle" });
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [stats, setStats] = useState<MonitorStats>({ frames: 0, plates: 0, alerts: 0, ms: 0, fps: 0 });
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [alarm, setAlarm] = useState<LiveAlert | null>(null);
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;

  useEffect(() => { void listCameras(media).then(setDevices); }, [media]);

  const clearTimer = useRef<number | undefined>(undefined);
  const draw = useCallback((boxes: LiveBox[], alerted: boolean) => {
    // Boxes describe a frame captured ~inference-time ago: clear them soon so they never sit
    // on top of newer video (a moving car or a moving phone).
    window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => overlay.current?.getContext("2d")?.clearRect(0, 0, overlay.current.width, overlay.current.height), 1200);
    const c = overlay.current;
    const v = video.current;
    if (!c || !v) return;
    c.width = v.clientWidth;
    c.height = v.clientHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    // the video is drawn with object-contain: map frame coordinates into the letterboxed area
    const scale = v.videoWidth ? Math.min(c.width / v.videoWidth, c.height / v.videoHeight) : 1;
    const [fw, fh] = v.videoWidth ? [v.videoWidth * scale, v.videoHeight * scale] : [c.width, c.height];
    const [ox, oy] = [(c.width - fw) / 2, (c.height - fh) / 2];
    const small = c.width < 560;
    for (const b of boxes) {
      const [x, y, w, h] = [ox + b.x * fw, oy + b.y * fh, b.w * fw, b.h * fh];
      const color = alerted && b.reported ? "#ff4d5e" : b.plate ? (b.plateValid ? "#34e0c8" : "#ffb347") : "rgba(255,255,255,0.6)";
      ctx.lineWidth = small ? 2 : 3;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;
      const label = b.plate ? `${b.plate.replace(/\|/g, " ")}  ${Math.round(b.confidence * 100)}%` : `plate found · not read (${Math.round(b.boxConfidence * 100)}%)`;
      ctx.font = `600 ${small ? 11 : 14}px 'Geist Mono', monospace`;
      const tw = ctx.measureText(label).width + 12;
      const lh = small ? 16 : 20;
      ctx.fillStyle = color;
      ctx.fillRect(x, Math.max(0, y - lh - 2), tw, lh);
      ctx.fillStyle = "#0a0a1f";
      ctx.fillText(label, x + 6, Math.max(lh - 6, y - 7));
    }
  }, [overlay, video]);

  const loop = useCallback(async (mine: number) => {
    const v = video.current;
    let frames = 0;
    let since = performance.now();
    while (running.current && gen.current === mine && v) {
      const started = performance.now();
      if (v.readyState >= 2 && v.videoWidth) {
        const scale = Math.min(1, MAX_WIDTH / v.videoWidth);
        grab.current ??= document.createElement("canvas");
        const g = grab.current;
        g.width = Math.round(v.videoWidth * scale);
        g.height = Math.round(v.videoHeight * scale);
        g.getContext("2d")?.drawImage(v, 0, 0, g.width, g.height);
        const blob = await new Promise<Blob | null>((res) => g.toBlob(res, "image/jpeg", 0.85));
        if (blob && running.current && gen.current === mine) {
          const form = new FormData();
          form.append("file", blob, "frame.jpg");
          try {
            const r = await v1.call<FrameResult>("POST", `/cameras/${encodeURIComponent(cameraId)}/frames`, form);
            interval.current = BASE_INTERVAL_MS;
            frames++;
            const reported = r.boxes.filter((b) => b.reported && b.plate);
            draw(r.boxes, r.alerts.length > 0);
            setModelNote(r.readsPlates ? null : "No OCR model loaded on the server: plates are boxed but not read.");
            if (reported.length) {
              setHits((h) => [...reported.map((b, i): Hit => ({
                id: `${Date.now()}-${i}`, at: new Date().toISOString(), plate: b.plate!, valid: b.plateValid, confidence: b.confidence,
                // one reported plate: the frame's alerts are its alerts; several: link exact matches only
                alert: reported.length === 1 ? (r.alerts[0] ?? null) : (r.alerts.find((a) => a.plate === b.plate) ?? null),
              })), ...h].slice(0, 40));
              void qc.invalidateQueries({ queryKey: ["reads"] });
            }
            if (r.alerts.length) {
              setAlarm(r.alerts[0]);
              void qc.invalidateQueries({ queryKey: opsKeys.alerts });
              void qc.invalidateQueries({ queryKey: opsKeys.overview });
              toast({ tone: "critical", title: `${r.alerts[0].reason === "stolen" ? "Stolen vehicle" : "Watchlist plate"} detected`, body: `${cameraName} · ${r.alerts[0].listName}. Alert opened for review.` });
            }
            const now = performance.now();
            setStats((s) => ({
              frames: s.frames + 1, plates: s.plates + reported.length, alerts: s.alerts + r.alerts.length, ms: r.inferenceMs,
              fps: now - since > 2000 ? Math.round((frames / ((now - since) / 1000)) * 10) / 10 : s.fps,
            }));
            if (now - since > 2000) { frames = 0; since = now; }
          } catch (e) {
            if (e instanceof ApiError && e.status === 429) {
              interval.current = Math.min(interval.current * 2, 8000);
            } else if (e instanceof ApiError && [403, 404, 409, 503].includes(e.status)) {
              if (gen.current !== mine) break;
              running.current = false;
              setState({ kind: "error", message: e.message });
              break;
            }
          }
        }
      }
      await new Promise((res) => setTimeout(res, Math.max(0, interval.current - (performance.now() - started))));
    }
  }, [cameraId, cameraName, draw, qc, toast, video]);

  const stop = useCallback(() => {
    gen.current++;
    running.current = false;
    stopStream(stream.current);
    stream.current = null;
    setCameraActive(false, owner);
    overlay.current?.getContext("2d")?.clearRect(0, 0, overlay.current.width, overlay.current.height);
    setState((s) => (s.kind === "error" ? s : { kind: "idle" }));
  }, [overlay, owner]);

  useEffect(() => () => { running.current = false; stopStream(stream.current); setCameraActive(false, owner); }, [owner]);

  const start = useCallback(async (dev = deviceId) => {
    const mine = ++gen.current;
    running.current = false;
    stopStream(stream.current);
    setState({ kind: "starting" });
    setAlarm(null);
    const { event, stream: s } = await requestCamera(media, { deviceId: dev || null });
    if (gen.current !== mine) return stopStream(s); // stopped or restarted while the browser asked
    if (event.type !== "GRANTED" || !s) return setState({ kind: "error", message: "message" in event ? event.message : "The camera could not start." });
    stream.current = s;
    if (video.current) video.current.srcObject = s;
    setCameraActive(true, owner);
    setState({ kind: "live" });
    void listCameras(media).then(setDevices);
    running.current = true;
    void loop(mine);
  }, [deviceId, loop, media, owner, video]);

  return {
    state, live: state.kind === "live", stats, hits, alarm, setAlarm, modelNote, devices, deviceId, setDeviceId, start, stop,
    supported: !!media?.getUserMedia,
  };
}
