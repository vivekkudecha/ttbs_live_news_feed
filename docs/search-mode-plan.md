# Plan: Search mode option — Agentic search (default) vs Perplexity Search + LLM

Status: **parked** (saved 2026-11-18). A standalone proof of concept lives in [`poc/search_mode_poc.py`](../poc/search_mode_poc.py); run it before building the feature.

## Context
Today every logo is researched with one Perplexity **Agent API** call (`POST /v1/agent`, `tools:[web_search]`) in
`PerplexityProvider.research` (`backend/app/research/providers.py:176`). The model decides what to search, reads
results and writes the answer in our fixed text format, which `parse_research` turns into a signal. It works well;
it stays exactly as is and remains the default.

We add a second, opt-in mode, **"Search + LLM"**: our code calls the Perplexity **Search API** (`POST /search`)
with a fixed set of queries per logo, then calls the **same configured model** through `/v1/agent` *without
tools*, giving it the search results as evidence plus the same research prompt and output rules. Output format,
parser, storage, digests and costs stay identical, so the outcome is comparable 1:1.

Why: predictable, lower and inspectable cost (Search API = $0.005 per request, up to 5 queries in one request;
no tool-call fan-out), evidence we can see and tune, and a fallback if agent behaviour changes.

Decisions taken: synthesis uses the **same model** as agentic mode; the mode is a **setting on the Perplexity
provider card** (Providers & channels), pinned on each run.

## Honest view on "without compromising the outcome"
- Agentic mode can follow up (search again, refine, read more); Search + LLM is one search round, so **recall on
  thin or ambiguous logos is the main risk**. Precision should be equal or better (model only sees dated, filtered
  evidence and is told not to go beyond it).
- The levers that protect quality: 5 targeted queries mapped to the prompt's four indicators, the research
  window as a date filter, enough results/snippet text in context, and an editable query list per prompt version.
- We don't switch blindly: a comparison script runs both modes on a sample of real logos and reports agreement
  and cost. Mode 2 becomes a real option only if it meets agreed thresholds (see Verification).

## Design

### 1. Data model — migration `0018_search_mode.py`
Pattern: `0016_priority_actions.py` (`batch_alter_table`, dialect branches).
- `llm_provider_configs.search_mode` String(20), not null, server_default `'agent'` (values `agent` | `search_llm`).
- `runs.search_mode` String(20), not null, default `'agent'` — pinned at run creation like `provider`/`model`.
- `cost_ledger.search_mode` String(20), nullable — so FinOps can compare cost per mode.
- `research_prompt_versions.search_queries` Text, nullable — newline-separated query templates with `{company}`
  (null → built-in defaults). It is a research field, so editing it bumps `research_version` (cache stays honest).
- Update `LlmProviderConfig`, `Run`, `CostEntry`, `ResearchPromptVersion` in `backend/app/db/models.py`.

### 2. Provider — `backend/app/research/providers.py` (+ new `backend/app/research/search.py`)
- `ActiveConfig` / `load_active` (`services/llm_config.py:32,74`) carry `search_mode`; `get_provider` /
  `_build` (`providers.py:351,358`) pass it into `PerplexityProvider(api_key, model, search_mode)` (add to the
  `lru_cache` key). `ResearchProvider` protocol gains `search_mode: str` (Fake/Gemini = `"agent"`).
- `PerplexityProvider.research` branches: `agent` → current code untouched; `search_llm` → `_research_search_llm`.
- New `search.py`:
  - `run_search(client, queries, window_start, s) -> list[Hit]`: one `POST /search` with
    `query=[≤5 rendered queries]`, `max_results=s.perplexity_search_max_results` (default 10),
    `search_after_date_filter=window_start (MM/DD/YYYY)`, optional `country` / `search_language_filter` from
    settings. Same error mapping as `_raise_for`; network errors → `RetryableProviderError`.
  - `select_hits(hits, window_start, limit, chars)`: dedupe by URL, drop hits dated before the window (keep
    undated), keep top N (default 25), trim each snippet (default 1,500 chars).
  - `evidence_block(hits) -> str`: numbered `[n] title — url — date\nsnippet` blocks.
- `_research_search_llm`:
  1. `ratelimit.acquire("perplexity-search")` (own bucket; Search API rate-limits per query), then `run_search`.
  2. No usable hits → return text `"<COMPANY>\nCategory: None\nKey signals: Details not found"` without an LLM
     call (cost = search fee only); parser already maps this to `no_signal`.
  3. Otherwise `POST /v1/agent` with no `tools`: `instructions = spec.system + SEARCH_GROUNDING` (fixed addendum:
     "You cannot browse. Use only the numbered search results below; cite their URLs inline; if none is relevant
     and inside the window, answer 'Details not found'."), `input = spec.render(...) + "\n\nSearch results:\n" +
     evidence_block`. Reuse the body of `generate()` (refactor its HTTP part into a private `_agent_call`).
  4. `Usage`: tokens/cost from `_usage` + Search fee: `tool_calls += 1`, `tool_cost += s.perplexity_search_price`
     (0.005), `cost += fee`, `raw["search"] = {"requests":1,"queries":n,"hits":k}`.
  5. `sources` = hits whose URL appears in the answer (real titles instead of netloc) — `_merge_sources`
     (`worker/tasks.py:121`) already merges them.
- Settings in `backend/app/core/config.py`: `perplexity_search_price=0.005`, `perplexity_search_max_results=10`,
  `perplexity_search_hits=25`, `perplexity_search_snippet_chars=1500`, `perplexity_search_country=""`,
  `perplexity_search_languages=[]`.
- Default queries in `backend/app/research/prompts.py` (`SEARCH_QUERIES`), one per indicator + a general one:
  `"{company}" news` · `{company} funding OR acquisition OR investment OR contract OR order` ·
  `{company} expansion new plant OR facility OR office OR data center` ·
  `{company} appoints CIO OR CTO OR CISO OR CDO OR "head of IT"` ·
  `{company} digital transformation OR cloud OR AI OR cybersecurity OR ERP`.
  `PromptSpec` gains `search_queries: tuple[str, ...]`; `research_prompts.clean()` validates ≤5 lines, each
  contains `{company}`, ≤200 chars.

### 3. Pipeline — `backend/app/worker/tasks.py`, `backend/app/services/runs.py`, `finops.py`
- Cache key (`tasks.py:71`): append `:{provider.search_mode}` **only when it is not `agent`**, so existing
  agentic cache entries stay valid and the two modes never serve each other's answers.
- `ctx`/telemetry gets `search_mode`; `create_run` (`runs.py:193`) stores `run.search_mode`; `run.queue` audit and
  `run.queued` telemetry include it.
- `finops.record_research` (`finops.py:69`) writes `search_mode`; `report()` `byModel` groups by it too
  (`finops.py:283`); add it to `LEDGER_COLUMNS` CSV.

### 4. Settings API + audit — `backend/app/api/routes.py`, `schemas.py`, `services/llm_config.py`
- New `PUT /api/v1/settings/llm/perplexity/search-mode` body `{searchMode: "agent"|"search_llm"}` →
  `llm_config.save_search_mode` (pattern: `save_priority_model`, `llm_config.py:198`): audit
  `llm.search_mode` with before/after, `cache.bump("llm")`. "manage" on module `integrations` (already covered by
  the `/api/v1/settings/llm` prefix in `core/permissions.py:79`).
- `llm_config_out` (`schemas.py:201`) adds `searchMode`; `run_out` (`schemas.py:95`) adds `searchMode`.
- `test` endpoint: when mode is `search_llm`, also ping `/search` with one query so a key without Search access
  fails at save time, not mid-run.

### 5. Frontend
- `frontend/src/components/integrations/AiProviderSettings.tsx`: on the Perplexity card, a "Search mode" shadcn
  `Select` (Agentic search — default · Perplexity Search + LLM) with a one-line explanation of each; new hook
  `useSaveSearchMode` in `src/api/hooks.ts` + `backend.saveSearchMode` in `src/api/http.ts`; types in
  `src/api/types.ts` (`LlmConfig.searchMode`, `Run.searchMode`, ledger `byModel.searchMode`).
- Prompt editor: a "Search queries (Search + LLM mode)" textarea for the version's `search_queries`, prefilled
  with defaults.
- Show the mode on run rows (`pages/Runs.tsx:442`, next to `ModelName`) and in Costs `byModel` labels
  (`pages/Costs.tsx:295`).

### 6. Comparison tool — `backend/scripts/compare_search_modes.py`
`--import-id N --sample 50 [--seed]`: picks logos from an upload, runs both modes with the active key/model
(directly via the provider, no run/DB writes), parses with `parse_research`, writes a CSV (company, per mode:
status, category, key signals, sources, cost, latency) plus a summary: signal/no-signal agreement, category
agreement, signals found only by one mode, cost and latency per logo. Costs real money: it prints the estimate
and asks for confirmation first.

## Rollout
0. **Spike (before coding):** call `/search` by hand for ~5 known logos to confirm snippet depth, date quality
   and Search access on our key; adjust defaults (hits, snippet chars, queries) from what we see.
1. Backend + migration + tests (mode stays `agent` → zero behaviour change on deploy).
2. Frontend toggle + query editor + run/cost labels.
3. Run the comparison on 50–100 real logos in UAT; review mismatches by hand; tune queries.
4. Switch modes per environment only if thresholds below are met.

Per CLAUDE.md: run GitNexus `impact` (upstream) on `PerplexityProvider.research`, `get_provider`, `_build`,
`research_company`, `create_run`, `record_research`, `llm_config_out`, `run_out` before editing, report risk,
and `detect_changes --scope all` before committing.

## Verification
- **Unit (respx, `backend/tests/test_perplexity.py` style):** `/search` payload (queries, date filter, max
  results); hit selection (dedupe, window filter, trim); grounded `/v1/agent` call has no `tools` and contains the
  evidence; cost = agent cost + $0.005 with `tool_calls=1`; zero hits → no LLM call and `no_signal`; 429/5xx on
  `/search` → retryable; agent mode payload unchanged (regression).
- **Settings (`test_llm_config.py` style):** save/read `searchMode`, audit row, run pins `search_mode`, cache key
  differs per mode and is unchanged for `agent`.
- **Migration:** `alembic upgrade head` / `downgrade -1` on SQLite and on the local MySQL container.
- `cd backend && pytest -q && ruff check app tests`; `cd frontend && npm run lint && npm run build`.
- **End to end locally:** `LLM_PROVIDER=perplexity`, set mode in the UI, run a 5-logo upload, check run rows,
  signals with real source titles, ledger rows with `search_mode` and the $0.005 tool cost, Costs page grouping.
- **Quality gate (comparison script):** proposed — signal/no-signal agreement ≥ 90%, signals found only by
  agentic ≤ 5% of logos (each reviewed), cost per logo clearly lower. Final thresholds are yours to set.
