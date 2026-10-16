# ANPR Secure: dashboard

SIEM-style web dashboard for the ANPR Secure platform. React 19, TypeScript, Vite, Tailwind CSS 4,
Framer Motion, Recharts, TanStack Table, React Router, lucide-react.

There is no backend yet: every screen runs on a typed mock API with seeded **synthetic** data
(fictional cameras, plates, users and IPs). No real people, plates or photos; all images are
generated inline SVG.

## Run

Requires Node 20+ (developed on Node 24).

```bash
cd dashboard
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run lint
npm test           # Vitest
```

Optional: copy `.env.example` to `.env.local`. No secrets belong in either file.

The project `.npmrc` keeps npm's cache and logs on drive E.

## Swapping in the real API

`src/api/client.ts` is the only file that chooses the implementation. Set `VITE_API_MODE=http`
and `VITE_API_BASE_URL` in `.env.local`, and the UI calls the FastAPI routes listed in
`src/api/http.ts` instead of `src/api/mock/`. Both implement `AnprApi` in `src/api/types.ts`.

## Layout

```
src/
  api/          types.ts (contract), client.ts (the switch), http.ts, mock/ (seeded data + mock server)
  app/          routes, nav, session (role + theme)
  camera/       live camera: permission state machine, frame capture, overlay, mock detections
  components/   layout/ (shell), ui/ (building blocks), charts/
  lib/          rbac, masking, plate parsing, hash chain + Ed25519, formatting
  pages/        one file per page
  styles/       tokens.css (all colours, radii, shadows, fonts, motion) + Tailwind theme
```

## Security model of the demo

| | Admin | Analyst | Auditor |
|---|:-:|:-:|:-:|
| Overview, evidence, models | ✓ | ✓ | ✓ |
| Live alerts: view and decide | ✓ | ✓ | |
| Plate search / reveal a plate | ✓ / ✓ | ✓ / ✓ | ✓ / masked only |
| Live camera | ✓ | ✓ | |
| Audit log, security center | ✓ | | ✓ |
| Cameras | ✓ | ✓ | |
| Edit settings | ✓ | | |

- **RBAC** lives in `src/lib/rbac.ts` and is enforced by the mock API too (403), not only by
  hiding UI. The real backend must enforce it server-side.
- **Human in the loop:** a watchlist match is only a suggestion. Confirm, reject or escalate
  each need a written justification and create an audit entry.
- **Masking:** plates are masked by default (`••••5|ب|6`); revealing one needs a reason and is audited.
- **Integrity:** evidence records are SHA-256 hash-chained and Ed25519-signed with WebCrypto;
  one demo record is deliberately tampered so verification has something to find.
- **Audit log:** append-only and hash-chained, in memory for the demo.

## Live camera (`/camera`)

Tests plate detection with a browser camera.

- Permission flow with clear states: idle, requesting, live, denied, no camera, error.
- Device selector, start/stop, resolution and FPS readout, mirrored preview, pulsing LIVE marker,
  and a "Camera is on" badge in the top bar while a stream is active.
- Detection modes: **Off**, **Mock** (fictional boxes, clearly labelled as not from the video),
  **Model** (disabled until the backend exists, see `docs/live_camera.md`).
- `FrameCapturer` grabs a JPEG at 2 fps by default and hands it to `api.sendFrame`.

Privacy rules:
- Video only, never audio. Frames stay in the browser: never stored, uploaded or logged. The
  mock API reads a frame's size and drops it.
- No face recognition anywhere. "Blur faces" is a disabled placeholder.
- Admin or Analyst only. Starting and stopping the camera writes to the audit chain; if the
  start cannot be audited, the camera is stopped.
- All tracks stop when you leave the page, hide the tab, or unplug the camera.

Browsers only allow camera access on `https://` or `localhost`.

## Tests

`npm test` runs Vitest on the logic that matters most:

- `src/lib/rbac.test.ts`: who can do what, including the camera.
- `src/lib/mask.test.ts`: masking, reveal-reason rules, plate parsing.
- `src/lib/chain.test.ts`: hash chain and Ed25519, edited, deleted and forged records.
- `src/api/mock/mock.test.ts`: the mock API's 403s, reveal and review auditing, the camera audit.
- `src/camera/permission.test.ts`: the camera permission state machine with a mocked `getUserMedia`.

## Screenshot checklist

For a portfolio or interview deck, capture in light mode at 1440 px wide unless noted:

- [ ] Overview with the KPI row, reads-per-hour chart and the camera grid
- [ ] Overview in dark mode
- [ ] Live alerts: a near-match (gold mismatched digit) with the justification dialog open
- [ ] Live alerts: a decided alert showing reviewer, justification and audit ID
- [ ] Live camera: idle state, then live with mock boxes and the "Camera is on" badge
- [ ] Command palette (Ctrl+K) open
- [ ] The same page as Analyst and as Auditor, to show RBAC
- [ ] Tablet width (about 820 px) with the sidebar collapsed
