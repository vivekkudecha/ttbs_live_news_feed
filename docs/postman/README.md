# Postman collection: TTBS Live News Feed API

| File | What it is |
|---|---|
| `TTBS-Live-News-Feed.postman_collection.json` | 120 requests (every `/api/v1` endpoint) in 17 folders, with 128 saved request/response examples |
| `TTBS-UAT.postman_environment.json` | `baseUrl` = `https://live-news-feed-uat.ai.tatatel.co.in` |
| `TTBS-Local.postman_environment.json` | `baseUrl` = `http://localhost:5173` (local compose gateway) |
| `sample-data/*.xlsx` | Sample company → PAM mapping uploads used by the upload requests |

## Use it
1. In Postman: **Import**, then select the collection and both environment files. Choose **TTBS · UAT**.
2. Enter `username` and `password` in the environment's **current value** column. The current value stays on your machine; the initial value is shared when you export.
3. Run **02 · Auth & Session → Login**. It stores `csrfToken`, and Postman keeps the `ttbs_session` cookie.
4. For upload requests, re-select the file under **Body → form-data** if Postman can't find `sample-data/…`. Setting Postman's working directory to this folder also fixes it.

Requests that create something save the new id (`importId`, `scheduleId`, `runId`, `templateId`, …) to the environment, so later requests use it. The collection has **no test cases**. The only scripts are small post-response scripts that store those values.

## Notes
- The saved examples are real responses from the application code. They come from a local in-process run that used fictional companies and people, with Perplexity and Microsoft Graph mocked. Ids, timestamps and costs on UAT will be different.
- The collection-level description covers authentication (session cookie + `X-CSRF-Token`), paging, sort and filter syntax, the error envelope and gateway rate limits. Each request also states the permission it needs.
- The Collection Runner can run the folders in order: everything destructive is in **17 · Cleanup & Sign-out**. Don't run that folder against UAT unless you mean to remove the email and AI settings.
- Local environment: the session cookie is `Secure`. Over plain HTTP, set `SESSION_COOKIE_SECURE=false` in `.env.dev`, or call the gateway over HTTPS.
