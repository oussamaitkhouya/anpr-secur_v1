import type { Detection } from "../api/types";

/** Read a design token, so the canvas uses the same colours as the rest of the UI. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Box in canvas pixels; mirrors the x axis when the preview is mirrored, keeping text readable. */
export function toCanvasBox(box: Detection["box"], width: number, height: number, mirrored: boolean) {
  const x = mirrored ? 1 - box.x - box.w : box.x;
  return { x: x * width, y: box.y * height, w: box.w * width, h: box.h * height };
}

/** Draw detection boxes, plate labels and confidence bars. Canvas is sized in CSS pixels × dpr. */
export function drawDetections(ctx: CanvasRenderingContext2D, detections: Detection[], opts: { width: number; height: number; dpr: number; mirrored: boolean }) {
  const { width, height, dpr, mirrored } = opts;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const accent = token("--accent") || "#3b3f8f";
  const gold = token("--gold") || "#b08d3c";
  const ink = token("--plate-ink") || "#15141b";
  const paper = token("--plate-bg") || "#fbfaf6";
  const mono = token("--font-mono") || "monospace";

  for (const d of detections) {
    const b = toCanvasBox(d.box, width, height, mirrored);
    const color = d.watchlistMatch ? gold : accent;
    const c = Math.min(14, b.w / 4, b.h / 2);

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 4);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(b.x, b.y + c); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x + c, b.y);
    ctx.moveTo(b.x + b.w - c, b.y); ctx.lineTo(b.x + b.w, b.y); ctx.lineTo(b.x + b.w, b.y + c);
    ctx.moveTo(b.x + b.w, b.y + b.h - c); ctx.lineTo(b.x + b.w, b.y + b.h); ctx.lineTo(b.x + b.w - c, b.y + b.h);
    ctx.moveTo(b.x + c, b.y + b.h); ctx.lineTo(b.x, b.y + b.h); ctx.lineTo(b.x, b.y + b.h - c);
    ctx.stroke();

    // label: plate text + confidence, above the box (below it if there is no room)
    const text = d.plate ? d.plate.split("|").join(" | ") : "Unreadable plate";
    ctx.font = `600 13px ${mono}`;
    const pct = `${Math.round(d.confidence * 100)}%`;
    const labelW = ctx.measureText(text).width + ctx.measureText(pct).width + 30;
    const labelH = 24;
    const lx = Math.min(Math.max(4, b.x), width - labelW - 4);
    const ly = b.y - labelH - 12 >= 4 ? b.y - labelH - 12 : b.y + b.h + 8;
    ctx.fillStyle = paper;
    ctx.beginPath();
    ctx.roundRect(lx, ly, labelW, labelH, 6);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.textBaseline = "middle";
    ctx.fillText(text, lx + 9, ly + labelH / 2 + 1);
    ctx.fillStyle = color;
    ctx.fillText(pct, lx + labelW - ctx.measureText(pct).width - 9, ly + labelH / 2 + 1);

    // confidence bar under the label
    ctx.fillStyle = paper;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(lx, ly + labelH + 3, labelW, 3);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly + labelH + 3, labelW * d.confidence, 3);

    if (d.watchlistMatch) {
      const tag = "WATCHLIST · NEEDS HUMAN REVIEW";
      ctx.font = `600 10px ${mono}`;
      const tw = ctx.measureText(tag).width + 14;
      const ty = b.y + b.h + 8 === ly ? ly + labelH + 10 : b.y + b.h + 8;
      ctx.fillStyle = gold;
      ctx.beginPath();
      ctx.roundRect(lx, ty, tw, 18, 4);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.fillText(tag, lx + 7, ty + 9.5);
    }
  }
}
