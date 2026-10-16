# API (`/api/v1`)

FastAPI app: `python -m uvicorn anpr.api.main:create_app --factory --env-file .env --port 8000`.
Interactive docs at `/docs` outside production. JSON is camelCase. Errors are
`{"detail": "..."}` (422 lists field locations, never the submitted values).

Auth: httpOnly cookies. Browsers send them with `credentials: "include"`. State-changing requests
must come from an origin in `CORS_ORIGINS`.

## Auth

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auth/login` | public | `{username, password}` -> `{mfaRequired, mfaEnrolled}`; sets a 5-minute `mfa_pending` cookie |
| POST | `/auth/mfa/setup` | after login, first time | -> `{otpauthUri, secret}` (once) |
| POST | `/auth/mfa` | after login | `{code}` -> `{id, username, role, cityIds}`; sets access + refresh cookies |
| POST | `/auth/refresh` | refresh cookie | rotates the refresh token (reuse revokes the family) |
| POST | `/auth/logout` | any | revokes the refresh family, clears cookies |
| GET | `/auth/me` | signed in | current user |

## Cities and cameras

Rate limited per IP: `CAMERA_RATE_PER_MINUTE` (default 120), connection tests
`PROBE_RATE_PER_MINUTE` (default 20). Analysts only ever see their own cities; other cities' ids
answer 404. Auditors get 403 on every camera route.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/cities` | admin, analyst, auditor | scoped for analysts |
| POST | `/admin/cities` | admin | `{name, region}`; 409 if the name exists |
| PATCH | `/admin/cities/{id}` | admin | `{name?, region?}` |
| DELETE | `/admin/cities/{id}` | admin | 409 while it has cameras or assigned analysts |
| GET | `/cameras?city_id=&status=&limit=&offset=` | admin, analyst | scoped |
| GET | `/cameras/{id}` | admin, analyst | 404 outside scope |
| GET | `/cameras/map` | admin, analyst | `{id, name, kind, district, latitude, longitude, viewDirectionDeg, status, lastFrameAt, cityId, cityName}` |
| GET | `/cameras/{id}/status-events` | admin, analyst | newest first |
| POST | `/admin/cameras` | admin | camera body (see `docs/camera_registry.md`); 409 on duplicate name in the city |
| PATCH | `/admin/cameras/{id}` | admin | any field except `cityId` |
| DELETE | `/admin/cameras/{id}` | admin | 409 if detections reference it (use maintenance) |
| PUT | `/admin/cameras/{id}/credentials` | admin | `{username, password}`, 204, write-only |
| DELETE | `/admin/cameras/{id}/credentials` | admin | 204 |
| POST | `/admin/cameras/{id}/test-connection` | admin | -> `{reachable, verdict, latencyMs, steps[{name, ok, ms, detail}], tlsNotAfter, testedAt}` |
| POST | `/admin/cameras/test-connection` | admin | same, for an unsaved camera: `{protocol, host, port?}` |
| GET | `/admin/cameras/import/template` | admin | CSV header and one example row |
| POST | `/admin/cameras/import?mode=preview\|confirm` | admin | multipart `file`; -> `{mode, fileName, sha256, rowsTotal, rowsAccepted, rowsRejected, accepted[], rejected[{line, name, reasons}]}` |
| GET | `/admin/cameras/{id}/audit?limit=` | admin | recent audit entries for that camera |

Example camera body:

```json
{
  "cityId": "6f1c…", "name": "Agdal gate 1", "kind": "anpr_camera",
  "latitude": 34.0007, "longitude": -6.8498, "viewDirectionDeg": 90, "lane": "2",
  "protocol": "rtsps", "host": "10.20.0.11", "port": 322, "streamPath": "/stream1", "vlan": 120
}
```

Responses add `id`, `credentialsSet`, `status`, `lastFrameAt`, `tlsNotAfter`, `notes`,
`createdAt`, `updatedAt`. There is no credentials field in any response.

## Alerts and overview

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/alerts?status=&limit=` | admin, analyst, auditor | city-scoped; full plate for reviewers (analysts), masked for others |
| GET | `/alerts/{id}` | same | 404 outside scope |
| POST | `/alerts/{id}/review` | analyst | `{action: approve\|reject\|escalate, justification (20+ chars)}`; 409 once decided; audited |
| GET | `/overview` | all signed-in roles | today's reads, hits, pending, latency, cameras, 14-day and 24-hour series; audit integrity for admin/auditor |

## Detections (camera worker)

`POST /detections` with `Authorization: Bearer <DETECTION_TOKEN>` (not a user session; the
server stores only the token's SHA-256; `scripts/new_detection_token.py` issues one). Rate
limited by `DETECTION_RATE_PER_MINUTE`.

```json
{
  "cameraId": "…", "observedAt": "2026-10-09T10:15:00Z", "sourceKind": "video",
  "plateRaw": "12345|أ|6", "plateConfidence": 0.97, "charConfidences": [0.99, 0.98, 0.97, 0.99, 0.95, 0.96, 0.99],
  "observedColor": "white", "evidenceSha256": "…", "evidenceUri": "s3://bucket/frame.jpg"
}
```

-> `201 {id, plateValid, alertsCreated}`. Each watchlist match becomes a **pending** alert for a
person to decide. Repeats (same entry, same camera, still pending, within 60 s) are suppressed.
Cameras in maintenance record reads but raise no alerts. A reporting camera becomes `online`.
404 for an unknown camera, 422 for a capture time more than 5 minutes in the future.

## Users (admin)

`GET/POST /admin/users`, `PATCH /admin/users/{id}` (`role`, `isActive`, `cityIds`),
`PUT /admin/users/{id}/password`, `POST /admin/users/{id}/unlock`, `POST /admin/users/{id}/reset-mfa`.
Accounts are deactivated, never deleted, so their audit history stays intact.
