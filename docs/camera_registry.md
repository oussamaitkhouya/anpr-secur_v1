# Camera registry (Cities & Cameras)

Dashboard page: `/admin/cameras`. API: `/api/v1` (see `docs/api.md`). Code:
`src/anpr/api/routes/{cameras,admin}.py`, `src/anpr/api/services/camera_import.py`,
`src/anpr/security/netprobe.py`, `dashboard/src/features/cameras/`.

## Fields

| Field | Notes |
|---|---|
| `city_id` | Required. A camera never moves city (create a new one instead). |
| `name` | 1-80 chars, unique per city. |
| `kind` | `fixed_cctv`, `ptz`, `anpr_camera`, `radar`. |
| `district`, `street_address`, `lane` | Free text, capped (80 / 200 / 20). |
| `latitude`, `longitude` | Required. -90..90, -180..180 (checked by the API and by a database CHECK). |
| `view_direction_deg` | 0..359, 0 = north, clockwise. Drawn as a 60 degree cone on maps. |
| `installed_on`, `owner`, `firmware_version`, `notes` | Optional. Notes capped at 2000 chars. |
| `protocol` | `rtsps` (recommended), `rtsp`, `onvif`, `webhook`, `mqtt`, `file`. |
| `host` | Hostname or IP only. No scheme, no `user@`, no port, no path. |
| `port` | 1..65535. Defaults by protocol (RTSPS 322, RTSP 554, ONVIF 80, MQTT 1883). |
| `stream_path` | Starts with `/`. No scheme, no `@`, no `user=`/`password=`/`token=` query keys. |
| `vlan` | 1..4094. |
| `credentials_encrypted`, `credentials_key_id` | Write-only. AES-256-GCM of `{"username","password"}`. The API exposes only `credentials_set: bool`. |
| `status` | `online`, `offline`, `degraded`, `maintenance`, `unknown` (default: never tested). |
| `last_frame_at` | Set by the camera worker. |
| `tls_not_after` | Captured by the RTSPS connection test; never typed in. |

Status changes are recorded in `camera_status_events` (detail drawer history).

**No stream URL is stored.** The camera worker assembles `scheme://user:pass@host:port/path` in
memory at connect time from the separate fields and the decrypted credentials. The UI only ever
shows a preview with credentials as `••••••`.

## Why locations are sensitive

A camera map is a map of where a city is watched, and of where it is not. In the wrong hands it
helps someone plan a route around ANPR coverage, find a camera to tamper with, or profile which
districts are monitored. Network details (host, VLAN, firmware) help an attacker reach and
exploit the devices. So the registry is need-to-know:

- Responses are city-scoped **in the SQL query** (`anpr.db.scoping`), not filtered afterwards
  and not hidden by the UI. An analyst's query gets `WHERE city_id IN (...)`.
- A camera in another city answers **404, not 403**, so ids cannot be probed.
- Auditors have **no** camera access: oversight works through the audit log, which records who
  changed what without exposing positions.
- Every registry route is rate limited per IP (`CAMERA_RATE_PER_MINUTE`, default 120;
  connection tests `PROBE_RATE_PER_MINUTE`, default 20) to slow bulk scraping.
- Map tiles come from your own tile server (`VITE_MAP_TILE_URL`). A public tile CDN would learn
  which areas operators look at.

## Access rules

| | Admin | Analyst | Auditor |
|---|---|---|---|
| List / view cameras, map, health | all cities | own cities only | no (403) |
| City list | all | own | all (names only) |
| Create / edit / delete cities and cameras | yes | no | no |
| Replace credentials (write-only) | yes | no | no |
| Test connection | yes | no | no |
| CSV import | yes | no | no |
| Camera audit entries | yes | no | via audit log |

Every create, update, delete, credential replace, import and connection test appends a signed,
hash-chained audit entry **in the same transaction**. Audit entries name the action, the camera
and changed field names, never field values and never credentials. Imports record the file's
SHA-256.

## Connection test

`POST /api/v1/admin/cameras/{id}/test-connection` (or `/admin/cameras/test-connection` for an
unsaved camera) does DNS, then TCP connect, then for RTSPS a TLS handshake that records the
certificate expiry. It answers **"Network reachable, stream not verified"**: it does not log in,
send RTSP commands or decode video. See `docs/security_design.md` for the SSRF controls.

## CSV import

Template: `GET /api/v1/admin/cameras/import/template`. `mode=preview` validates every row with the
same model as the API and writes nothing; `mode=confirm` inserts the accepted rows. Rejected rows
come back with line numbers and reasons. There are no credential columns: a file with one is
refused as a whole. Cells starting with `= + - @` are rejected (CSV injection).
