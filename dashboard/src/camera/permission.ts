/*
 * Camera permission state machine, kept free of React and of the real browser so it can be
 * tested with a fake `mediaDevices`.
 *
 *   idle ──START──> requesting ──GRANTED──> live ──STOP──> idle
 *                       │                      └──ENDED──> error   (device unplugged, revoked)
 *                       ├──DENIED────> denied      (user or browser policy said no)
 *                       ├──NO_CAMERA─> no_camera   (no video input device)
 *                       └──FAILED────> error       (in use, insecure context, ...)
 *   denied / no_camera / error ──START──> requesting   (retry)
 */

export type CameraState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "live"; deviceId: string | null; label: string }
  | { status: "denied"; message: string }
  | { status: "no_camera"; message: string }
  | { status: "error"; message: string };

export type CameraEvent =
  | { type: "START" }
  | { type: "GRANTED"; deviceId: string | null; label: string }
  | { type: "DENIED"; message: string }
  | { type: "NO_CAMERA"; message: string }
  | { type: "FAILED"; message: string }
  | { type: "ENDED"; message: string }
  | { type: "STOP" };

export const INITIAL_CAMERA_STATE: CameraState = { status: "idle" };

export function cameraReducer(state: CameraState, event: CameraEvent): CameraState {
  switch (event.type) {
    case "START":
      return state.status === "requesting" || state.status === "live" ? state : { status: "requesting" };
    case "GRANTED":
      return state.status === "requesting" ? { status: "live", deviceId: event.deviceId, label: event.label } : state;
    case "DENIED":
      return state.status === "requesting" ? { status: "denied", message: event.message } : state;
    case "NO_CAMERA":
      return state.status === "requesting" ? { status: "no_camera", message: event.message } : state;
    case "FAILED":
      return state.status === "requesting" ? { status: "error", message: event.message } : state;
    case "ENDED":
      return state.status === "live" ? { status: "error", message: event.message } : state;
    case "STOP":
      return { status: "idle" };
  }
}

/** Map a getUserMedia rejection to a state-machine event with a message a person can act on. */
export function classifyMediaError(err: unknown): Exclude<CameraEvent, { type: "START" | "GRANTED" | "STOP" | "ENDED" }> {
  const name = err instanceof Error || (typeof err === "object" && err !== null && "name" in err) ? String((err as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return { type: "DENIED", message: "Camera access was blocked. Allow it in the browser's site settings, then try again." };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { type: "NO_CAMERA", message: "No camera was found. Connect a camera or pick another device." };
    case "NotReadableError":
    case "TrackStartError":
      return { type: "FAILED", message: "The camera is in use by another application or could not start." };
    case "AbortError":
      return { type: "FAILED", message: "Starting the camera was interrupted. Try again." };
    default:
      return { type: "FAILED", message: err instanceof Error && err.message ? err.message : "The camera could not be started." };
  }
}

export interface CameraRequest {
  deviceId?: string | null;
  width?: number;
  height?: number;
}

/** The subset of MediaDevices this module uses, so tests can pass a fake. */
export type MediaDevicesLike = Pick<MediaDevices, "getUserMedia" | "enumerateDevices">;

/**
 * Ask for a video-only stream (never audio). Resolves to the event to dispatch and, when
 * granted, the stream. Never throws.
 */
export async function requestCamera(
  devices: MediaDevicesLike | undefined,
  request: CameraRequest = {},
): Promise<{ event: CameraEvent; stream: MediaStream | null }> {
  if (!devices?.getUserMedia) {
    return { event: { type: "FAILED", message: "This browser cannot use a camera here. Use HTTPS or localhost in a current browser." }, stream: null };
  }
  try {
    const stream = await devices.getUserMedia({
      audio: false,
      video: {
        deviceId: request.deviceId ? { exact: request.deviceId } : undefined,
        width: { ideal: request.width ?? 1280 },
        height: { ideal: request.height ?? 720 },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stopStream(stream);
      return { event: { type: "NO_CAMERA", message: "The stream had no video track." }, stream: null };
    }
    const settings = track.getSettings?.() ?? {};
    return { event: { type: "GRANTED", deviceId: settings.deviceId ?? null, label: track.label || "Camera" }, stream };
  } catch (err) {
    return { event: classifyMediaError(err), stream: null };
  }
}

/** Stop every track so the browser's camera light goes off. Safe to call twice or with null. */
export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Video input devices. Labels are empty until the user has granted permission once. */
export async function listCameras(devices: MediaDevicesLike | undefined): Promise<{ deviceId: string; label: string }[]> {
  if (!devices?.enumerateDevices) return [];
  try {
    const all = await devices.enumerateDevices();
    return all
      .filter((d) => d.kind === "videoinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch {
    return [];
  }
}
