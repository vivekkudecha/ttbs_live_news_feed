# Search + LLM PoC

Researches logos the candidate way from [docs/search-mode-plan.md](../docs/search-mode-plan.md), outside the app:

1. `POST /search`: 5 queries per logo (general news, funding/contracts, expansion, IT leadership, digital/security),
   limited to the research window.
2. `POST /v1/agent` with the same model and the app's research prompt, **without** the web search tool, given only
   those search results.
3. The app's own parser turns the answer into what the app stores per logo.

The output is only the model's answer, in the exact format the app's research prompt asks for:

```
COMPANY NAME
Category: <Expansion | Funding | Leadership | Cybersecurity | Digital | Contract | None>
Key signals: ...
Opportunity type: ...
Recommended outreach approach: ...
```

Nothing is written to the app's database, cache or cost ledger. It calls the paid Perplexity API.

## Setup (once)
```bash
cd poc && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt && cd ..
```
Put the key in `poc/.env` (ignored by git):
```bash
echo 'PERPLEXITY_API_KEY=pplx-...' > poc/.env && chmod 600 poc/.env
```

## Run
With the same Excel/CSV you upload to the app (the `Logo`/`Company` column is used), with the model id selected
under Providers & channels:
```bash
poc/.venv/bin/python poc/search_mode_poc.py --model <model-id> --file upload.xlsx --limit 20
```
Or a few names:
```bash
poc/.venv/bin/python poc/search_mode_poc.py --model <model-id> --companies "Infosys" "Zomato"
```
Compare against today's agentic call and Fast Search on the sample list (`poc/sample_logos.csv`, 15 logos):
```bash
poc/.venv/bin/python poc/search_mode_poc.py --model <model-id> --file poc/sample_logos.csv --modes search,fast,agentic --workers 4
```
Modes: `search` (standard Search API, $0.005), `fast` (Fast Search, $0.001), `agentic` (what the app does today).
With several modes the output is each logo's answers side by side plus a cost / outcome table (`comparison.md`).

Only look at what the Search API returns (no LLM call):
```bash
poc/.venv/bin/python poc/search_mode_poc.py --search-only --companies "Infosys"
```
Files are saved in `poc/out/<timestamp>/` (ignored by git): `answers.txt` (exactly what is printed),
`results.csv` (answer, cost, time per logo) and `raw.json` (plus the search results each answer was based on).

Knobs: `--window-days` (10), `--country` (`IN`; `""` for none), `--max-results` for the whole request (20), `--hits`
passed to the LLM (20), `--reasoning` effort, `--snippet-chars` per result (1500), `--workers` (2).

Notes:
- The prompt is the app's built-in default (version 1). If the prompt was edited in the app, the app uses that
  version instead.
- Cost per logo = $0.005 for the search + the LLM cost Perplexity reports. A logo with no search results in the
  window costs only the search.
