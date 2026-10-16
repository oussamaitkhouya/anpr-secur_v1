# Security design

## Camera registry: threats and controls

| Threat | Control | Where | Test |
|---|---|---|---|
| **Credential theft from the database** (backup leak, SQL injection, read-only DB access) | Camera credentials are AES-256-GCM encrypted with a key from a `KeyProvider` (env in dev, Vault/KMS stub documented). The associated data binds each ciphertext to its row, so a ciphertext copied to another camera does not decrypt. Key ids allow rotation (`crypto.reencrypt`). | `security/crypto.py`, `security/keys.py` | `test_ciphertext_copied_to_another_camera_does_not_decrypt`, `test_key_rotation_round_trip` |
| **Credential leak through the API** | Write-only `PUT /credentials`. No response model has a credentials field; responses say `credentialsSet` only. 422 errors never echo submitted values. | `routes/admin.py`, `schemas.py`, `main.py` | `test_credentials_are_write_only_and_never_leak`, `test_no_response_model_has_a_credentials_field` |
| **Credential leak through logs, audit or URLs** | Log redaction filter loaded with the app's secrets; audit entries carry field names, never values; credentials are never stored in the stream URL or accepted in host/path/query. The UI clears typed credentials from state as soon as they are sent and never prefills them. | `security/redaction.py`, `schemas.py` (`_host`, `_stream_path`), `CameraWizard.tsx` | log-canary assertions in the registry test; `CameraWizard.test.tsx` |
| **SSRF via test-connection** (an admin, or a stolen admin session, aims the server at internal services) | Host resolved once; every answer checked; refused: loopback, link-local, cloud metadata (169.254.169.254, fd00:ec2::254, 100.100.100.200, 169.254.170.2), multicast, unspecified, reserved, unless `ALLOWED_CAMERA_NETWORKS` lists the range. The socket connects to the checked IP (no DNS rebinding). TCP/TLS only: no HTTP, no redirects, nothing received is returned. 3 s timeouts; DNS in a worker thread. Rate limited (20/min). | `security/netprobe.py` | `test_netprobe.py`, `test_connection_test_refuses_internal_targets` |
| **Camera location leakage** | City scoping in the SQL query; 404 for other cities; auditors denied; per-IP rate limits; no third-party tile server. | `db/scoping.py`, `rbac.py`, `routes/cameras.py` | `test_analyst_only_sees_allowed_cities_everywhere`, `test_scoping_is_a_where_clause_in_the_sql`, `test_rbac_matrix` |
| **Tampered records** (someone edits a camera or hides a change) | Every write appends an Ed25519-signed, hash-chained audit entry in the same transaction. `audit_entries` is append-only (trigger, plus the app role has no UPDATE/DELETE). | `security/audit_chain.py`, migration `0001` | `test_every_change_is_in_a_valid_signed_chain` |
| **Malicious CSV** | Size and row caps, UTF-8 only, exact header, per-row Pydantic validation, CSV-injection prefixes refused, no credential columns, SHA-256 audited. | `services/camera_import.py` | `test_import_*` |
| **Privilege misuse** | RBAC map enforced by the API on every route; the UI hides controls only as a convenience. | `rbac.py`, `deps.require` | `test_rbac_matrix`, `CamerasPage.test.tsx` |
| **Session theft in the browser** | httpOnly, Secure, SameSite=Strict cookies; Origin check on state-changing requests; TOTP MFA at every sign-in; no token in localStorage. | `routes/auth.py`, `main.py`, `dashboard/src/api/v1.ts` | `test_auth_api.py` |

## Not covered yet

- **Stream verification**: the connection test proves network reachability only. Verifying the
  RTSP handshake or decoding a frame needs the camera worker (an optional OpenCV check would run
  in a worker thread with a timeout). Not built.
- **Certificate validation**: the RTSPS test records the expiry date but does not verify the
  chain (cameras are usually self-signed). Pinning per-camera certificates is future work.
- **Credential use**: the camera worker that decrypts credentials and connects does not exist
  yet, so in-memory handling at connect time is not reviewed.
- **Vault/KMS**: `VaultKeyProvider` is a documented stub; dev keys live in `.env`.
- **Rate limiter** is in-process memory: it resets on restart and is per instance. A shared
  store (Redis) is needed behind a load balancer.
- **Uptime history**: no heartbeat history is collected, so the Health tab shows current state only.
- **Insider with database owner access** can still rewrite rows; the signed audit chain makes
  that detectable, not impossible.
- **Address policy at stream time**: a camera's host can resolve differently later; the future
  camera worker must apply the same address policy as the connection test.
