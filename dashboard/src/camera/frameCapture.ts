/*
 * Grabs JPEG frames from a <video> at a fixed rate and hands each one to a callback.
 * Privacy: frames live only in memory for the duration of the callback. Nothing here stores,
 * uploads or logs them; whether a frame leaves the browser is decided by the callback
 * (in this build it goes to the mock API, which reads its size and drops it).
 */

export const DEFAULT_FPS = 2;
export const MIN_FPS = 0.2;
export const MAX_FPS = 10;

/** Milliseconds between captures for a requested rate, clamped to a sane range. */
export function captureIntervalMs(fps: number): number {
  const f = Number.isFinite(fps) ? Math.min(MAX_FPS, Math.max(MIN_FPS, fps)) : DEFAULT_FPS;
  return Math.round(1000 / f);
}

/** Output size that keeps the aspect ratio and does not exceed maxWidth. */
export function scaledSize(width: number, height: number, maxWidth: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.round((height * maxWidth) / width) };
}

export interface CapturedFrame {
  seq: number;
  capturedAt: string;
  width: number;
  height: number;
  jpeg: Blob;
}

export interface FrameCaptureOptions {
  fps?: number;
  /** JPEG quality 0..1 */
  quality?: number;
  maxWidth?: number;
}

export class FrameCapturer {
  private timer: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private seq = 0;
  private busy = false;

  /** Start capturing. A capture is skipped if the previous callback has not finished yet. */
  start(video: HTMLVideoElement, onFrame: (frame: CapturedFrame) => Promise<void> | void, options: FrameCaptureOptions = {}): void {
    this.stop();
    const { fps = DEFAULT_FPS, quality = 0.7, maxWidth = 1280 } = options;
    this.canvas ??= document.createElement("canvas");
    this.timer = window.setInterval(async () => {
      if (this.busy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const size = scaledSize(video.videoWidth, video.videoHeight, maxWidth);
      if (!size.width) return;
      this.busy = true;
      try {
        const canvas = this.canvas!;
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.getContext("2d")?.drawImage(video, 0, 0, size.width, size.height);
        const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (jpeg) await onFrame({ seq: ++this.seq, capturedAt: new Date().toISOString(), ...size, jpeg });
      } finally {
        this.busy = false;
      }
    }, captureIntervalMs(fps));
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    // drop the last frame's pixels too
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
  }
}
