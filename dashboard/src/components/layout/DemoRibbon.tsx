import { demoMode } from "../../api/client";

/** Only with VITE_APP_ENV=demo: a ribbon and a note so fictional data is never mistaken for real. */
export function DemoRibbon() {
  if (!demoMode) return null;
  return (
    <>
      <div className="pointer-events-none fixed right-0 top-0 z-[45] h-28 w-28 overflow-hidden" aria-hidden>
        <span className="absolute right-[-38px] top-[26px] w-[150px] rotate-45 bg-gold py-1 text-center font-mono text-[10px] font-bold tracking-[0.2em] text-plate-ink shadow-2">
          DEMO DATA
        </span>
      </div>
      <p role="note" className="mb-5 rounded-sm border border-gold bg-gold-soft px-4 py-2.5 text-sm text-gold-strong">
        Demo mode (VITE_APP_ENV=demo): every city, camera, plate and alert here is fictional; connection tests are simulated.
      </p>
    </>
  );
}
