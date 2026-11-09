# Caching policy

What is cached, where, for how long, and why. The principle: **cache what is public and
immutable for as long as possible; never let anything per-user or sensitive be stored outside
the server.**

## 1. Browser and intermediary caches (HTTP headers)

| What | Example | `Cache-Control` | Set by | Why |
|---|---|---|---|---|
| Built JS/CSS/fonts/images | `/assets/index-Cdv42ky3.js` | `public, max-age=31536000, immutable` | gateway | File names contain a content hash: a new build produces new names, so a cached copy can never be stale. One year = the maximum that matters. |
| SPA shell | `/`, `/index.html`, any client route | `no-cache` (+ `ETag`) | gateway | Always revalidated (a cheap 304 when unchanged), so a deploy is visible on the next load and the shell always points at the current asset names. |
| Other public files | `/favicon.svg` | `public, max-age=86400` | gateway | Rarely changes; one day bounds the staleness. |
| **Every API response** | `/api/v1/...` (data, errors, downloads, health) | `no-store` + `Pragma: no-cache` | backend middleware (`app/main.py`) | Per-user, permission-checked, frequently changing and partly sensitive (audit, costs, uploads). `no-store` forbids browsers, proxies and CDNs from keeping any copy, including the back/forward cache after sign-out. |
| Rate-limit answers (429) | | `no-store` | gateway | Never reuse a refusal. |
| phpMyAdmin (dev/uat) | `/phpmyadmin/...` | phpMyAdmin's own headers | phpMyAdmin | Tool-managed. |

The gateway does **not** run a proxy cache (`proxy_cache`): everything dynamic is per-user,
and the static files are served by the gateway itself, from its image, and cached by browsers.
Error responses (404, 401...) carry no caching header from the gateway.

The SPA also calls `fetch(..., { cache: "no-store" })` for API requests, so the browser HTTP
cache is bypassed even if a header were ever missing.

## 2. Client memory (React Query, in the SPA)

Server data is held in memory only while the tab is open, never in `localStorage` or
`sessionStorage`. The whole cache is **cleared on sign-out and when the session ends**
(`context/session.tsx`), so a following user never sees the previous user's data.

| Data | Freshness (`staleTime`) | Refresh |
|---|---|---|
| Default | 30 s | on demand |
| Paged lists (companies, PAMs, signals, rows) | 15 s | on demand; previous page kept while the next loads |
| Live run, its results, notifications, timeline | n/a | polled every 2-5 s **only while the run is active** |
| Dashboard, run list, queues | n/a | polled every 5-10 s |
| Telemetry, FinOps | n/a | polled every 10-30 s |
| Module catalogue, password policy | until reload | static per deployment |

## 3. Server-side cache (Redis, `app/core/cache.py`)

A read-through cache in front of expensive queries. It **fails open** (if Redis is down the API
computes the answer, so an outage slows things down but never breaks them) and is invalidated by
**namespace versions** (`bump(ns)` makes all old keys unreachable at once; they then expire by
TTL). It holds no per-user data: access is checked before the cache is read.

| Namespace | TTL (env var) | Default |
|---|---|---|
| A running job's progress | `CACHE_TTL_JOB_RUNNING` | 2 s |
| A finished job | `CACHE_TTL_JOB_FINISHED` | 300 s |
| Lists | `CACHE_TTL_LISTS` | 15 s |
| LLM model lists per provider + key fingerprint | `LLM_MODELS_CACHE_S` | 3600 s |

Research results are re-used (not re-bought) within `RESEARCH_WINDOW_DAYS` (default 10): that
is a business rule stored in the database, not a cache, and it is recorded in the cost ledger
as a cache hit with the estimated saving.

Redis requires a password (`REDIS_PASSWORD`), sits on the internal `data` network only, and has
`FLUSHALL`, `FLUSHDB`, `CONFIG`, `DEBUG` and `SHUTDOWN` disabled.

## 4. Sessions are not cached

Sessions are rows in the database (`user_sessions`), checked on every request, so revoking a
session (sign-out, password change, deactivation, admin action) takes effect on the very next
request, with no cache to wait out.

## Changing the policy

- Asset lifetimes: the `map $uri $cache_control` block in `deploy/nginx/nginx.conf`. Keep `/assets/` immutable only while file names stay hashed (Vite default).
- API headers: `create_app()` in `backend/app/main.py`. Do not relax `no-store` for authenticated data.
- Redis TTLs: the env vars above.
