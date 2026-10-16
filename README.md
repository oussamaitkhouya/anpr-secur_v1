# ANPR Secure

Moroccan plate recognition with a security-first platform around it: signed audit chain,
write-only encrypted camera credentials, city-scoped access, and a human confirming every
watchlist match. See `CLAUDE.md` for the rules and `docs/` for design notes.

## Run it (Windows, PowerShell, from the repo root)

Prerequisites: Python 3.11+ with `.venv`, Node 22+, PostgreSQL 14+ (native or Docker).

```powershell
# 1. secrets: copy the example and fill in fresh values
Copy-Item .env.example .env
.venv\Scripts\python -m anpr.security.keys        # prints values to paste into .env

# 2. database: EITHER Docker ...
docker compose up -d db
#    ... OR a native PostgreSQL (creates roles + databases, points .env at them)
.venv\Scripts\python scripts\setup_local_postgres.py --port 5432

# 3. schema (Alembic config lives in pyproject.toml, hence -c)
.venv\Scripts\alembic -c pyproject.toml upgrade head

# 4. first admin (password asked at a hidden prompt; MFA is set up at first sign-in)
$env:PYTHONPATH = "src"
.venv\Scripts\python -m anpr.db.create_admin --username <you>

# 5. API
.venv\Scripts\python -m uvicorn anpr.api.main:create_app --factory --env-file .env --port 8000

# 6. dashboard (another terminal)
cd dashboard
npm install
npm run dev        # http://localhost:5173
```

Sign in, scan the setup key into an authenticator app, then open **Cities & Cameras**.

Send a test plate read (the camera worker uses the same endpoint):

```powershell
.venv\Scripts\python scripts\new_detection_token.py      # prints a token once; restart the API
$env:DETECTION_TOKEN = "<that token>"
.venv\Scripts\python scripts\send_detection.py --camera <camera id> --plate "12345|أ|6"
```

If the plate is on an active watchlist, a pending alert appears in **Live alerts**.

### Webcam camera worker

Register the webcam in **Cities & Cameras** first (protocol **File**: a local source the server
never connects to; use the real position of the PC), then copy its id from the detail panel.

```powershell
$env:PYTHONPATH = "src"
$env:DETECTION_TOKEN = "<token from new_detection_token.py>"
.venv\Scripts\python -m anpr.worker.webcam --camera-id <camera id> --show
```

It analyses ~4 frames/s with the YOLO detector and the CRNN reader (`ANPR_DETECTOR_WEIGHTS`,
`ANPR_OCR_WEIGHTS`), reports each plate once per 10 s, and keeps the JPEG of reported frames
only, in `var/evidence/` (git-ignored, deleted after 30 days). The API receives the frame's
SHA-256, never the image. Video is not recorded; audio is never opened.

`VITE_APP_ENV=demo` in `dashboard/.env.local` runs the dashboard on fictional in-browser data
with a "DEMO DATA" ribbon. Real mode never shows fictional data on ported pages.

## Tests

```powershell
.venv\Scripts\ruff check src tests
.venv\Scripts\python -m pytest            # Postgres tests skip unless TEST_DATABASE_URL is reachable
cd dashboard; npm run lint; npx vitest run; npm run build
```

## Map tiles (self-hosted)

The dashboard has no hardcoded tile server: a public tile CDN would learn which streets
operators look at. Set `VITE_MAP_TILE_URL` in `dashboard/.env.local`, for example:

```
VITE_MAP_TILE_URL=http://localhost:8080/styles/basic/{z}/{x}/{y}.png
VITE_MAP_ATTRIBUTION=© OpenStreetMap contributors
```

A simple way to self-host: download a Morocco extract as MBTiles (OpenMapTiles or
Geofabrik + `tilemaker`), then serve it with
`docker run -p 8080:8080 -v ${PWD}\tiles:/data maptiler/tileserver-gl`. Keep the attribution
the data license requires. Without a tile URL the maps still work on a plain grid.

## Docs

- `docs/camera_registry.md`: camera fields, why locations are sensitive, access rules
- `docs/security_design.md`: threat-to-control tables, what is not covered yet
- `docs/api.md`: `/api/v1` endpoints
- `docs/live_camera.md`, `docs/data_sources.md`
