/*
 * Leaflet maps for the registry. No hardcoded tile server: tiles come from VITE_MAP_TILE_URL
 * (self-hosted, see README). Without it the maps still work on a plain grid, with a note.
 * Markers and popups are built from DOM nodes with textContent, never HTML strings, so a
 * camera name cannot inject markup. No external images: icons are inline SVG.
 */
import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import { MapContainer, Marker, Polygon, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { KIND_LABELS, STATUS_LABELS } from "./logic";
import { cameraIcon, MAX_ZOOM, MIN_ZOOM, MOROCCO_CENTER, TILE_ATTRIBUTION, TILE_URL, viewCone } from "./mapUtils";
import type { CameraKind, RegistryCamera } from "./types";

function Tiles() {
  return TILE_URL ? <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={MAX_ZOOM} /> : null;
}

export function NoTilesNote() {
  if (TILE_URL) return null;
  return (
    <p className="pointer-events-none absolute bottom-2 left-2 z-[500] max-w-[70%] rounded-sm bg-surface-raised/90 px-2.5 py-1.5 text-[11px] text-muted shadow-1">
      No tile server configured (VITE_MAP_TILE_URL). Positions are exact; the background is a plain grid.
    </p>
  );
}

const mapClass = "anpr-map h-full w-full rounded-md [background:repeating-linear-gradient(0deg,var(--bg-subtle)_0_1px,transparent_1px_40px),repeating-linear-gradient(90deg,var(--bg-subtle)_0_1px,transparent_1px_40px),var(--surface)]";

// ---- location picker (wizard step 2) ----------------------------------------------------------

function ClickToSet({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

function FollowPin({ position }: { position: [number, number] | null }) {
  const map = useMap();
  const first = useRef(true);
  useEffect(() => {
    if (!position) return;
    if (first.current) map.setView(position, 16);
    else if (!map.getBounds().contains(position)) map.panTo(position);
    first.current = false;
  }, [map, position]);
  return null;
}

export function LocationPickerMap({ position, bearing, kind, onPick }: {
  position: [number, number] | null;
  bearing: number | null;
  kind: CameraKind;
  onPick: (lat: number, lon: number) => void;
}) {
  const icon = useMemo(() => cameraIcon(kind, "online", true), [kind]);
  return (
    <div className="relative h-full min-h-64">
      <MapContainer minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} center={position ?? MOROCCO_CENTER} zoom={position ? 16 : 5} className={mapClass} attributionControl={!!TILE_URL}>
        <Tiles />
        <ClickToSet onPick={onPick} />
        <FollowPin position={position} />
        {position && bearing !== null && (
          <Polygon positions={viewCone(position[0], position[1], bearing)} pathOptions={{ className: "anpr-cone", weight: 1 }} />
        )}
        {position && (
          <Marker
            position={position}
            icon={icon}
            draggable
            keyboard
            title={`Camera position. Drag to move. ${KIND_LABELS[kind]}`}
            eventHandlers={{ dragend: (e) => { const p = (e.target as L.Marker).getLatLng(); onPick(p.lat, p.lng); } }}
          />
        )}
      </MapContainer>
      <NoTilesNote />
    </div>
  );
}

// ---- registry map (Map tab, detail drawer) -----------------------------------------------------

function popupNode(c: RegistryCamera, cityName: string, onOpen: (id: string) => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "anpr-popup";
  const title = document.createElement("p");
  title.className = "anpr-popup-title";
  title.textContent = c.name;
  const meta = document.createElement("p");
  meta.className = "anpr-popup-meta";
  meta.textContent = `${KIND_LABELS[c.kind]} · ${STATUS_LABELS[c.status]} · ${cityName}${c.district ? ` · ${c.district}` : ""}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "anpr-popup-btn";
  button.textContent = "Open details";
  button.addEventListener("click", () => onOpen(c.id));
  root.append(title, meta, button);
  return root;
}

function ClusterLayer({ cameras, cityName, onOpen, fit }: {
  cameras: RegistryCamera[];
  cityName: (id: string) => string;
  onOpen: (id: string) => void;
  fit: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    const group = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 48,
      iconCreateFunction: (cluster) => {
        const n = cluster.getChildCount();
        const el = document.createElement("span");
        el.className = "anpr-cluster";
        el.textContent = String(n);
        return L.divIcon({ html: el, className: "", iconSize: [38, 38] });
      },
    });
    for (const c of cameras) {
      const m = L.marker([c.latitude, c.longitude], { icon: cameraIcon(c.kind, c.status), title: c.name, keyboard: true });
      m.bindPopup(() => popupNode(c, cityName(c.cityId), onOpen));
      group.addLayer(m);
    }
    map.addLayer(group);
    if (fit && cameras.length) map.fitBounds(L.latLngBounds(cameras.map((c) => [c.latitude, c.longitude])), { padding: [40, 40], maxZoom: 16 });
    return () => {
      map.removeLayer(group);
    };
  }, [map, cameras, cityName, onOpen, fit]);
  return null;
}

export function RegistryMap({ cameras, cityName, onOpen, className }: {
  cameras: RegistryCamera[];
  cityName: (id: string) => string;
  onOpen: (id: string) => void;
  className?: string;
}) {
  return (
    <div className={`relative ${className ?? "h-full"}`}>
      <MapContainer minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} center={MOROCCO_CENTER} zoom={5} className={mapClass} attributionControl={!!TILE_URL}>
        <Tiles />
        <ClusterLayer cameras={cameras} cityName={cityName} onOpen={onOpen} fit />
      </MapContainer>
      <NoTilesNote />
    </div>
  );
}

/** Small non-interactive map for the detail drawer. */
export function MiniMap({ camera }: { camera: RegistryCamera }) {
  const pos: [number, number] = [camera.latitude, camera.longitude];
  const icon = useMemo(() => cameraIcon(camera.kind, camera.status, true), [camera.kind, camera.status]);
  return (
    <div className="relative h-44">
      <MapContainer minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} center={pos} zoom={16} className={mapClass} dragging={false} scrollWheelZoom={false} doubleClickZoom={false} zoomControl={false} attributionControl={!!TILE_URL} keyboard={false}>
        <Tiles />
        {camera.viewDirectionDeg !== null && (
          <Polygon positions={viewCone(pos[0], pos[1], camera.viewDirectionDeg)} pathOptions={{ className: "anpr-cone", weight: 1 }} />
        )}
        <Marker position={pos} icon={icon} interactive={false} />
      </MapContainer>
      <NoTilesNote />
    </div>
  );
}
