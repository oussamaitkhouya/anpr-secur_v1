import L from "leaflet";
import { STATUS_COLOR } from "./style";
import type { CameraKind, CameraStatus } from "./types";

export const TILE_URL: string | undefined = import.meta.env.VITE_MAP_TILE_URL || undefined;
export const TILE_ATTRIBUTION: string = import.meta.env.VITE_MAP_ATTRIBUTION ?? "";
/**
 * Zoom limits set on every map. Leaflet normally takes maxZoom from the tile layer; without a
 * tile server (no VITE_MAP_TILE_URL) the map has none, and marker clustering refuses to run.
 */
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 19;
export const MOROCCO_CENTER: [number, number] = [31.8, -7.1];

const KIND_GLYPH: Record<CameraKind, string> = {
  // tiny 12x12 glyphs drawn inside the marker
  fixed_cctv: '<rect x="2" y="4" width="7" height="4" rx="1"/><path d="M9 5l2-1v4l-2-1"/>',
  ptz: '<circle cx="6" cy="6" r="3.2"/><circle cx="6" cy="6" r="1"/>',
  anpr_camera: '<rect x="1.5" y="3.5" width="9" height="5" rx="1"/><path d="M3.5 6h5"/>',
  radar: '<path d="M2 9a5 5 0 0 1 8 0M4 9a2.5 2.5 0 0 1 4 0"/><circle cx="6" cy="9" r=".8"/>',
};

function markerSvg(kind: CameraKind, status: CameraStatus, selected = false): string {
  const color = STATUS_COLOR[status];
  // SVG built only from fixed strings above and token names: no user data inside. Colours go in
  // style="" because SVG presentation attributes cannot resolve CSS variables.
  return `<svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <path d="M17 41s13-12.5 13-23A13 13 0 0 0 4 18c0 10.5 13 23 13 23z" style="fill:var(--surface-raised);stroke:${color};stroke-width:${selected ? 3 : 2}"/>
    <circle cx="17" cy="18" r="9" style="fill:${color};opacity:0.16"/>
    <g transform="translate(11 12)" style="fill:none;stroke:${color};stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round">${KIND_GLYPH[kind]}</g>
  </svg>`;
}

export function cameraIcon(kind: CameraKind, status: CameraStatus, selected = false): L.DivIcon {
  return L.divIcon({ html: markerSvg(kind, status, selected), className: "anpr-marker", iconSize: [34, 42], iconAnchor: [17, 41], popupAnchor: [0, -36] });
}

/** Direction-of-view cone: a 60 degree wedge, `meters` long, pointing at `bearing` (0 = north). */
export function viewCone(lat: number, lon: number, bearing: number, meters = 70): [number, number][] {
  const toPoint = (b: number): [number, number] => {
    const rad = (b * Math.PI) / 180;
    return [lat + (meters * Math.cos(rad)) / 111_320, lon + (meters * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180))];
  };
  return [[lat, lon], ...[-30, -15, 0, 15, 30].map((d) => toPoint(bearing + d))];
}
