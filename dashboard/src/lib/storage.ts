/** localStorage for per-viewer UI conveniences only (theme, sidebar). May be unavailable. */

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(`anpr.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(`anpr.${key}`, value);
  } catch {
    // private mode or blocked storage: the preference just isn't remembered
  }
}
