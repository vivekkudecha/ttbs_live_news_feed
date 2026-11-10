# Deployment

One stack, three environments, one command.

```
                 ┌──────────────────────── gateway (nginx) ────────────────────────┐
 browser ──────> │  /             the React SPA (built into this image)            │
 (only port)     │  /api/         ──> api ─────┐                                   │
                 │  /phpmyadmin/  ──> phpMyAdmin (dev/uat, password gate)          │
                 └─────────────────────────────┼───────────────────────────────────┘
                          worker, beat ────────┴──> Redis, MySQL   (network "data": no internet)
```

## Run it

```bash
cp .env.example .env.uat && chmod 600 .env.uat    # once per environment: fill CHANGE_ME + secrets
./deploy.sh uat up                                # build + start (data volumes are kept)
./deploy.sh uat ps | logs | down                  # status, follow logs, stop
```

| Stage | Settings | Database | Open at |
|---|---|---|---|
| dev  | `.env.dev`  | MySQL container + phpMyAdmin | http://localhost:5173 |
| uat  | `.env.uat`  | MySQL container + phpMyAdmin | http://localhost:5175 |
| prod | `.env.prod` | external server (`DATABASE_URL`) | `GATEWAY_BIND:GATEWAY_PORT` (default `0.0.0.0:80`), behind HTTPS |

dev and uat listen on `127.0.0.1` only; from another machine use an SSH tunnel
(`ssh -L 5175:localhost:5175 server`). The first admin comes from `ADMIN_INITIAL_PASSWORD` and must
change it at first sign-in.

## Where things live

| File | What it holds |
|---|---|
| `compose.yml` | The app: redis, migrate, api, worker, beat, gateway. Same for every stage. |
| `compose.db.yml` | dev/uat only: the MySQL container and phpMyAdmin. |
| `deploy.sh` | Picks the env file, port and add-ons for a stage, then runs podman-compose. |
| `.env.example` | Every setting, with notes on what differs per stage. |
| `deploy/nginx/nginx.conf` | Gateway: routing, rate limits, size limits, CSP, caching policy. |
| `deploy/nginx/headers.conf` | Security headers (and the HSTS line to enable with HTTPS). |
| `deploy/nginx/tools.conf` | dev/uat routes: `/phpmyadmin/`, `/docs`. Left out of prod images. |
| `deploy/phpmyadmin.php` | phpMyAdmin hardening (no root login, no server info). |
| `backend/Dockerfile`, `deploy/nginx/Dockerfile` | The two images built from this repo. |

Security controls and how to verify them: [docs/security.md](../docs/security.md).
Caching: [docs/caching-policy.md](../docs/caching-policy.md).
Monthly partitions, soft delete, indexes and MySQL sizing (read before deploying migration 0011:
it rebuilds the high-volume tables once): [docs/data-partitioning.md](../docs/data-partitioning.md).
