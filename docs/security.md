# Security controls (VAPT reference)

What protects TTBS Live News Feed, where each control lives, and how to verify it. Written for
the VAPT team and for whoever operates the deployment.

Scope note: **TLS is terminated outside this repository** (load balancer or reverse proxy in
front of the gateway). Until it is, findings about plain HTTP, the `Secure` cookie flag over
HTTP and missing HSTS are expected; see [Before go-live](#before-go-live).

## Architecture

```
 client ──> gateway (nginx, the only published port; serves the built SPA itself)
              ├── /               static SPA files (in the gateway image)
              ├── /api/           ──> api       (FastAPI)
              └── /phpmyadmin/    ──> phpmyadmin   dev/uat only, extra password gate
                                       api, worker, beat ──> MySQL, Redis (internal network)
```

Files: `compose.yml` (the stack), `compose.db.yml` (dev/uat MySQL + phpMyAdmin), `deploy.sh`,
`deploy/nginx/` (gateway). How to run it: [deploy/README.md](../deploy/README.md).

| Network | Members | Internet |
|---|---|---|
| `default` | gateway, api, worker, beat, migrate, phpmyadmin | yes (LLM providers, prod DB) |
| `data` | MySQL, Redis, api, worker, beat, migrate, phpmyadmin | **no** (`internal: true`) |

The gateway is only on `default`: it cannot reach MySQL or Redis at all. In dev/uat it is bound
to `127.0.0.1` only. MySQL, Redis, the API and phpMyAdmin publish no host ports.

## Authentication (OWASP ASVS V2/V3)

Code: `backend/app/services/auth.py`, `backend/app/services/passwords.py`, `backend/app/api/deps.py`.

| Control | Implementation |
|---|---|
| Credentials | Username + password. Passwords hashed with **Argon2id** (64 MiB, 3 passes, 4 lanes); parameters upgrade on next sign-in. Never logged, never returned. |
| Password policy | ≥ 12 chars (`PASSWORD_MIN_LENGTH`), ≤ 128; upper, lower, digit, symbol; no character 3× in a row; no common words (password, admin, welcome, qwerty, ttbs...); not the username or name; not one of the last 5 (`PASSWORD_HISTORY_COUNT`); expires after 90 days (`PASSWORD_MAX_AGE_DAYS`, 0 = never). Enforced server-side; the UI only mirrors it. |
| First admin | Created at startup only while no user exists, from `ADMIN_USERNAME` / `ADMIN_INITIAL_PASSWORD` (rejected if it fails the policy). Must change it at first sign-in. |
| Forced change | First sign-in, admin-issued temporary passwords, and expired passwords: the session can reach **only** `/auth/me`, `/auth/change-password`, `/auth/logout` (`403 password_change_required` elsewhere). |
| Brute force | 5 consecutive failures (`AUTH_MAX_FAILED_ATTEMPTS`) lock the account for 15 min (`AUTH_LOCKOUT_MINUTES`); plus gateway rate limit of 6 sign-ins/min per IP. |
| No enumeration | Unknown user, wrong password, locked and deactivated accounts all get the same `401` message, and take the same time (a dummy hash is verified for unknown users). |
| Sessions | Opaque 256-bit random token in cookie `ttbs_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api`, no `Max-Age` (dies with the browser). Only its SHA-256 is stored. Idle timeout 30 min, absolute 12 h (`SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`). |
| Fixation | A new token on every sign-in and on password change. |
| Revocation | Sign-out; password change (all sessions); admin password reset, deactivation, demotion, "sign out everywhere". Checked on every request (no cache). |
| CSRF | `SameSite=Strict` cookie **and** a per-session token that every POST/PUT/PATCH/DELETE must echo in `X-CSRF-Token` (`403 csrf_failed`). The token is kept in memory only, never in web storage. |
| Identity in audit | The actor is the signed-in user. The old `X-Actor` header is ignored (and refused by CORS). |

## Authorisation (ASVS V4)

Code: `backend/app/core/permissions.py`, `authorize()` in `backend/app/api/deps.py`.

- Roles: **admin** (everything, including user management) and **member** (per-module access chosen by an admin).
- Modules: dashboard, signals, runs, companies, pams, imports, integrations, costs, telemetry, audit. Levels: `view` (GET) and `manage` (create/change/delete/start/cancel/resend).
- One guard on every `/api/v1` router decides from the matched **route template**. It **fails closed**: a route without a rule is refused, and `tests/test_auth.py` fails the build if any route is uncovered.
- Public: only `/api/v1/health`, `/api/v1/auth/login`, `/api/v1/auth/password-policy`.
- User management (`/api/v1/users/*`) is admin-only. Admins cannot deactivate or demote themselves, and the last active admin cannot be removed.
- The SPA hides what a user cannot open, but the server enforces every request.

## Input, output and errors

- Request bodies are Pydantic models with `extra="forbid"`, length limits and patterns.
- SQL goes through SQLAlchemy (bound parameters only).
- Errors use one JSON envelope with a request id. No stack traces leave the server.
- Request size: 2 MB by default, 4 KB for sign-in, 1 GB only for dataset uploads (streamed).

## HTTP hardening (gateway: `deploy/nginx/nginx.conf`)

| Control | Value |
|---|---|
| Rate limits (per IP) | API 20 r/s (burst 40), sign-in 6 r/min (burst 5), static 30 r/s (burst 100), tools 10 r/s; 60 concurrent connections. JSON `429` with `Retry-After`. |
| Methods | GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS only (others `405`); static paths GET/HEAD only. |
| Timeouts | header 15 s, body 60 s (uploads 300 s), keep-alive 30 s. |
| Headers | `Content-Security-Policy` (self only, no inline scripts, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, mic, geolocation... off), `Cross-Origin-Opener-Policy`/`-Resource-Policy: same-origin`. |
| Disclosure | `server_tokens off`; upstream `Server`/`X-Powered-By` removed; dotfiles `404`; `/metrics` `404`; API docs (`/docs`, `/openapi.json`) disabled when `ENV=prod` (UAT and prod). |
| Client IP | `X-Forwarded-For` is **overwritten** with the real peer, so it cannot be spoofed into audit rows or lockout logs. |
| Caching | API: `Cache-Control: no-store`. See [caching-policy.md](caching-policy.md). |
| CORS | Disabled in deployments (`CORS_ORIGINS=[]`: same origin). Dev server only: an explicit origin list, never `*`. |

## Containers

| Control | Where |
|---|---|
| Non-root | api/worker/beat (uid 10001), gateway (nginx-unprivileged, uid 101, port 8080). |
| Read-only root FS + tmpfs `/tmp` | api, worker, beat, migrate, gateway |
| `cap_drop: ALL` | api, worker, beat, migrate, gateway |
| `no-new-privileges` | every service |
| `pids_limit` | backend services |
| Pinned, supported images | nginx 1.30.6 (stable), MySQL 8.4.13 (LTS), Redis 7.4.12, phpMyAdmin 5.2.3, Python 3.12, Node 24 (build stage only) |
| Secrets | Only in `.env.<stage>` files (mode 600, git-ignored, never in a build context). The gateway receives only `GATEWAY_PMA_HTPASSWD`, no application secrets. LLM API keys are AES-GCM encrypted in the DB with `SECRETS_KEY`. |
| Code protection | Backend code is obfuscated with PyArmor in the image. |

Data stores: MySQL with `local_infile=0` and `skip-name-resolve`, the app uses a non-root DB user.
Redis requires a password with dangerous admin commands disabled. Neither is reachable from outside
the `data` network.

## Database panel (dev/uat only)

phpMyAdmin is not part of prod images. In dev/uat it sits behind **two** logins: a gateway
password gate (bcrypt, `GATEWAY_PMA_HTPASSWD`), then MySQL credentials. MySQL `root` and
empty passwords are refused (`deploy/phpmyadmin.php`), and server/PHP info and version checks are off. Exclude
`/phpmyadmin/` from VAPT scope, or test it as an admin tool.

## Audit trail

Every sign-in, failed sign-in (with reason), lockout, sign-out, password change and admin action
(user created, updated with a field-level diff, password reset, unlocked, sessions revoked) is
written to the hash-chained audit log (`GET /api/v1/audit/verify` detects edits or deletions),
with request id, client IP and user agent.

## Verifying

```bash
# Backend unit tests, including the security tests in tests/test_auth.py
podman run --rm -v ./backend:/src:z ttbs-backend-test python -m pytest -q

# Headers, rate limit, auth (gateway on 127.0.0.1:5173 in dev)
curl -sI http://127.0.0.1:5173/                     # CSP, XFO, nosniff..., no version
curl -s  http://127.0.0.1:5173/api/v1/runs          # 401
for i in $(seq 8); do curl -s -o /dev/null -w '%{http_code} ' -X POST \
  -H 'Content-Type: application/json' -d '{"username":"x","password":"y"}' \
  http://127.0.0.1:5173/api/v1/auth/login; done     # 401 ... then 429
```

## Before go-live

1. **HTTPS**: terminate TLS in front of the gateway (TLS 1.2+ only). Then enable HSTS in
   `deploy/nginx/headers.conf` and, if a load balancer is in front, `real_ip` in
   `deploy/nginx/nginx.conf` (otherwise rate limits see the LB's IP).
2. Fill `.env.prod` from `.env.example` (the `[prod]` notes), then `./deploy.sh prod up`: unique `SECRETS_KEY`, `REDIS_PASSWORD`,
   `ADMIN_INITIAL_PASSWORD`; then sign in once, change the password, and delete
   `ADMIN_INITIAL_PASSWORD` from the file.
3. External database: a dedicated least-privilege user, TLS to the DB if it is on another host,
   backups.
4. Run an image scan (e.g. `trivy image ttbs-backend:prod`) and `npm audit` / `pip-audit` in CI.
5. Ship container logs somewhere central. The audit log is in the DB; gateway access logs are on
   stdout.

## Known limitations

- Rootless Podman port forwarding may hide client IPs from the gateway (all clients look like one
  address), which makes per-IP rate limits global. Rootful Docker/Podman or a load balancer with
  `real_ip` does not have this problem.
- No MFA yet. Company SSO (OIDC) in front of the gateway is the natural next step.
- Session cleanup: revoked and expired session rows are kept (an audit trail of sessions). Prune
  rows older than 90 days periodically if the table grows.
