/* Vitest setup: DOM matchers, and the browser APIs jsdom does not implement. */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

if (typeof window !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
  window.matchMedia ??= ((query: string) => ({
    matches: query.includes("reduce"), // tests run with reduced motion: no animation timing to wait for
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo ??= () => {};
}
