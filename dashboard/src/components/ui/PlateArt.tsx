import { useId } from "react";
import type { Condition } from "../../api/types";
import { Rng } from "../../api/mock/rng";

/*
 * Generated placeholder imagery: no real photos exist in this project. Both views are drawn
 * from the plate text and a seed, so the same capture always looks the same.
 */

function PlateShape({ text, x, y, w, h }: { text: string; x: number; y: number; w: number; h: number }) {
  const [number, letter, region] = text.split("|");
  const fs = h * 0.56;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={h * 0.12} fill="var(--plate-bg)" stroke="var(--plate-ink)" strokeWidth={Math.max(1, h * 0.04)} />
      <g fill="var(--plate-ink)" fontFamily="var(--font-mono)" fontWeight={600} fontSize={fs} textAnchor="middle" dominantBaseline="central">
        <text x={x + w * 0.31} y={y + h / 2} letterSpacing={h * 0.04}>{number}</text>
        <text x={x + w * 0.68} y={y + h / 2} fontFamily="var(--font-sans)">{letter}</text>
        <text x={x + w * 0.88} y={y + h / 2}>{region}</text>
      </g>
      <g stroke="var(--plate-ink)" strokeWidth={Math.max(1, h * 0.035)}>
        <line x1={x + w * 0.6} x2={x + w * 0.6} y1={y + h * 0.18} y2={y + h * 0.82} />
        <line x1={x + w * 0.77} x2={x + w * 0.77} y1={y + h * 0.18} y2={y + h * 0.82} />
      </g>
    </g>
  );
}

function Weather({ condition, width, height, seed, id }: { condition: Condition; width: number; height: number; seed: number; id: string }) {
  if (condition === "night") return <rect width={width} height={height} fill="var(--plate-ink)" opacity={0.38} />;
  if (condition !== "rain") return null;
  const rng = new Rng(seed);
  return (
    <g stroke="var(--scene-sky)" strokeWidth={1.2} opacity={0.55} clipPath={`url(#${id}-clip)`}>
      {Array.from({ length: 70 }, (_, i) => {
        const x = rng.int(0, width);
        const y = rng.int(-20, height);
        return <line key={i} x1={x} y1={y} x2={x - 6} y2={y + 22} />;
      })}
    </g>
  );
}

/** Close-up of the plate region, as the OCR saw it. */
export function PlateCrop({ text, condition = "day", seed = 1, label }: { text: string; condition?: Condition; seed?: number; label: string }) {
  const id = useId().replace(/:/g, "");
  const W = 520;
  const H = 150;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full rounded-md">
      <defs>
        <clipPath id={`${id}-clip`}><rect width={W} height={H} rx={14} /></clipPath>
        <filter id={`${id}-blur`}><feGaussianBlur stdDeviation={condition === "blur" ? 2.4 : 0} /></filter>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <rect width={W} height={H} fill="var(--scene-car)" />
        <g filter={`url(#${id}-blur)`} transform={`rotate(${((seed % 7) - 3) * 0.6} ${W / 2} ${H / 2})`}>
          <PlateShape text={text} x={30} y={24} w={W - 60} h={H - 48} />
        </g>
        <Weather condition={condition} width={W} height={H} seed={seed} id={id} />
      </g>
    </svg>
  );
}

/** Full camera frame: a road scene with a car and the detector's box around the plate. */
export function SceneFrame({ text, condition = "day", seed = 1, cameraId, capturedAt, confidence, label }: {
  text: string;
  condition?: Condition;
  seed?: number;
  cameraId: string;
  capturedAt: string;
  confidence: number;
  label: string;
}) {
  const id = useId().replace(/:/g, "");
  const rng = new Rng(seed);
  const W = 640;
  const H = 360;
  const carX = rng.int(170, 300);
  const carW = 300;
  const plate = { x: carX + carW / 2 - 52, y: 248, w: 104, h: 26 };
  const box = { x: plate.x - 8, y: plate.y - 7, w: plate.w + 16, h: plate.h + 14 };
  const c = 9; // bracket length
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full rounded-md">
      <defs>
        <clipPath id={`${id}-clip`}><rect width={W} height={H} rx={16} /></clipPath>
        <linearGradient id={`${id}-sky`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--scene-sky)" />
          <stop offset="1" stopColor="var(--scene-road)" />
        </linearGradient>
        <filter id={`${id}-blur`}><feGaussianBlur stdDeviation={condition === "blur" ? 1.6 : 0} /></filter>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <rect width={W} height={H} fill={`url(#${id}-sky)`} />
        <path d={`M0 ${H} L${W * 0.38} 150 L${W * 0.62} 150 L${W} ${H} Z`} fill="var(--scene-road)" />
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={W / 2 - 2 - i} y={170 + i * 48} width={4 + i * 2} height={18 + i * 8} fill="var(--plate-bg)" opacity={0.5} />
        ))}
        <g filter={`url(#${id}-blur)`}>
          {/* car, seen from behind */}
          <rect x={carX + 30} y={140} width={carW - 60} height={70} rx={26} fill="var(--scene-car)" />
          <rect x={carX + 52} y={152} width={carW - 104} height={44} rx={12} fill="var(--scene-sky)" opacity={0.55} />
          <rect x={carX} y={196} width={carW} height={98} rx={22} fill="var(--scene-car)" />
          <rect x={carX + 14} y={212} width={46} height={16} rx={6} fill="var(--danger)" opacity={0.75} />
          <rect x={carX + carW - 60} y={212} width={46} height={16} rx={6} fill="var(--danger)" opacity={0.75} />
          <rect x={carX + 18} y={290} width={44} height={28} rx={8} fill="var(--plate-ink)" />
          <rect x={carX + carW - 62} y={290} width={44} height={28} rx={8} fill="var(--plate-ink)" />
          <PlateShape text={text} {...plate} />
        </g>
        <Weather condition={condition} width={W} height={H} seed={seed} id={id} />
        {/* detector box */}
        <g stroke="var(--accent)" strokeWidth={2.5} fill="none" strokeLinecap="round">
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={4} strokeOpacity={0.35} />
          <path d={`M${box.x} ${box.y + c} V${box.y} H${box.x + c} M${box.x + box.w - c} ${box.y} H${box.x + box.w} V${box.y + c} M${box.x + box.w} ${box.y + box.h - c} V${box.y + box.h} H${box.x + box.w - c} M${box.x + c} ${box.y + box.h} H${box.x} V${box.y + box.h - c}`} />
        </g>
        <g fontFamily="var(--font-mono)" fontSize={11}>
          <rect x={box.x} y={box.y - 22} width={92} height={18} rx={4} fill="var(--accent)" />
          <text x={box.x + 6} y={box.y - 9} fill="var(--accent-fg)">plate {confidence.toFixed(2)}</text>
          <rect x={12} y={12} width={240} height={22} rx={6} fill="var(--plate-ink)" opacity={0.7} />
          <text x={22} y={27} fill="var(--plate-bg)">{cameraId.toUpperCase()} · {capturedAt.replace("T", " ").slice(0, 19)}Z</text>
        </g>
      </g>
    </svg>
  );
}
