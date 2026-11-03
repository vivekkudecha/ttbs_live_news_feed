# Scale & live progress: design notes

Target: **10,000 logos · 5,000 PAMs · 40k+ research results**, with a UI that never blocks.

## What would break at this scale (before)

| Bottleneck | Where | Cost at 10k / 5k |
|---|---|---|
| Full lists fetched, joined in the browser with `.find()` | Companies, Signals, Dashboard, Digest, Runs | O(n²): ~100M ops (Signals), ~400M (Companies) → multi-second freezes |
| Unbounded rendering | Signals (~5.5k cards), PAMs (5k cards), run & dashboard tables (5k rows) | tens of thousands of DOM nodes |
| `<Select>` with every PAM / logo | Digest, Signals, Reassign, Users, Templates | 5,000–10,000 options mounted |
| Data work on the UI thread | mock API (`structuredClone` of large arrays) | blocks input and paint |

## What we do now

1. **Server-driven lists.** Every list is paged, filtered, sorted and *joined* on the server; the
   browser holds one page. Contract: `src/api/types.ts` (`CompanyQuery`, `SignalQuery`, `Page<T>`,
   `CompanyPage.facets`, `DashboardSummary`, `DigestData`, …).
2. **Summary endpoints** instead of client aggregation (`dashboard`, `getRun` roll-ups,
   `pamJobs` paged, `companyDetail` single call).
3. **Off-main-thread backend (mock).** The mock API runs in a Web Worker
   (`src/mock/server.worker.ts`, via Comlink). Results are columnar (1 byte per logo per run) and
   text is materialised only for returned rows — the same shape as SQL with `LIMIT`.
4. **Bounded rendering.** Window virtualisation + infinite query for the Signals feed
   (`@tanstack/react-virtual`); server pagination for tables and PAM cards; debounced, server-backed
   pickers (`src/components/pickers/Pickers.tsx`, max 30 results).
5. **Smooth transitions.** `keepPreviousData` keeps the current page visible while the next loads;
   searches are debounced (250 ms) before reaching a query key.
6. **Live progress, logo by logo.** A run streams batched events (250 ms); the client applies them
   to typed arrays and re-renders at most once per animation frame (`useLiveRun`). The logo map is a
   single `<canvas>` that repaints only changed cells (`LiveGrid`). Each PAM's digest is sent as soon
   as that PAM's logos finish.

## Measured (headless Chromium, production build)

| Scenario | Long tasks > 50 ms | Notes |
|---|---|---|
| First load → dashboard | 1 (65 ms) | JS parse + first mount; interactive in ~0.2 s |
| Companies: open, 15-char search, page ×7, sort 10k by signals | 0 | server query ~15–17 ms |
| Signals feed, 40 fast scrolls | 0 | 14 cards mounted of 4,193 |
| Live run (2.5k logos), 8 s | 0 | 60 fps |
| Live run (10,000 logos), 8 s | 0 | 60 fps |
| PAM picker over 5,000 PAMs | 0 | 30 results |

## Backend requirements (FastAPI phase)

- **Pagination:** offset for UI tables (≤ 100 rows/page); keyset (`WHERE (name, id) > (:n, :id)`)
  for infinite feeds and exports.
- **Indexes:** `pg_trgm` GIN on `companies.name`, `pams.name`/`email` (search);
  B-tree on `company_assignments(company_id) WHERE valid_to IS NULL`, `companies(pam_id)`,
  `company_research(run_id, status)`, `company_research(run_id, pam_id)`.
- **Pre-aggregation:** `company_signal_summary` (signals count, last signal, latest status) as a
  table refreshed incrementally when a company's research completes, not a per-query scan.
- **Facets:** computed in the same query (`COUNT(*) FILTER (WHERE …)`), cached in Redis for 60 s
  per filter combination.
- **Live stream:** `GET /api/v1/runs/{id}/events` as Server-Sent Events, fed by Redis pub/sub from
  the Celery research workers; events batched every 250 ms; snapshot endpoint returns a compact
  status array (1 byte per logo) for late joiners. Sticky-free: any API replica can serve SSE.
- **Per-PAM delivery:** when a PAM's last logo completes, enqueue that PAM's priority + digest
  task immediately (outbox), instead of waiting for the run.
- **Exports:** large Excel/CSV exports are generated asynchronously and delivered as a link.
- **Payloads:** gzip/brotli at nginx; `ETag` on list endpoints; HTTP/2.
