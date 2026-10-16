import { useSyncExternalStore } from "react";

/*
 * App-wide "is a camera on?" flag, so the top bar can show a persistent badge while any
 * stream is active. Several streams can be open at once (the Live wall), so each one registers
 * under its own owner key; the flag is on while at least one owner is.
 */
const owners = new Set<string>();
let active = false;
const listeners = new Set<() => void>();

export function setCameraActive(next: boolean, owner = "default"): void {
  if (next) owners.add(owner);
  else owners.delete(owner);
  if (owners.size > 0 === active) return;
  active = owners.size > 0;
  listeners.forEach((l) => l());
}

export function useCameraActive(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => active,
  );
}
