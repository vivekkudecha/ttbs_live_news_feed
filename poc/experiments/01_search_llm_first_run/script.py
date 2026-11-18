"""PoC: research logos with the Perplexity Search API + one plain LLM call, using the app's research prompt.

For each logo:
  1. POST /search    5 queries (one per thing the prompt looks for), limited to the research window.
  2. POST /v1/agent  the same model and the app's research prompt (backend/app/research/prompts.py), WITHOUT the
                     web_search tool, given only the search results as evidence.

The output is only the model's answer, in the format the research prompt asks for:

  COMPANY NAME
  Category: ...
  Key signals: ...
  Opportunity type: ...
  Recommended outreach approach: ...

Nothing is written to the app's database, cache or cost ledger. This calls the paid Perplexity API.

  poc/.venv/bin/python poc/search_mode_poc.py --model <model id> --companies "Infosys" "Zomato"
  poc/.venv/bin/python poc/search_mode_poc.py --model <model id> --file upload.xlsx --limit 20
  poc/.venv/bin/python poc/search_mode_poc.py --companies "Infosys" --search-only   # just the /search results
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.research.prompts import default_spec  # the app's research prompt (pure module: no settings, DB or Redis)

HERE = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    """KEY=value lines from poc/.env; variables already set in the shell win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))


_load_dotenv(HERE / ".env")

BASE_URL = "https://api.perplexity.ai"
SEARCH_PRICE = 0.005  # USD per successful POST /search (up to 5 queries in one request)

# One query per indicator in the research prompt, plus a general one. {company} is filled in per logo.
SEARCH_QUERIES = (
    '"{company}" news',
    "{company} funding OR acquisition OR investment OR contract OR order",
    "{company} expansion new plant OR facility OR office OR data center",
    '{company} appoints CIO OR CTO OR CISO OR CDO OR "head of IT"',
    "{company} digital transformation OR cloud OR AI OR cybersecurity OR ERP",
)

SEARCH_GROUNDING = (
    "\n\nYou cannot browse the web in this task. Use ONLY the numbered search results given after the "
    "research request. Cite the URL of each result you rely on inline. Ignore results that are about a "
    "different company or fall outside the research window. If no result qualifies, answer exactly with the "
    "'Details not found' format."
)

NOT_FOUND = ("Category: None\nKey signals: Details not found\nOpportunity type: Details not found\n"
             "Recommended outreach approach: Details not found")

# Company column names the app accepts on upload (services/imports.py HEADER_ALIASES).
COMPANY_HEADERS = ("company", "company name", "logo", "account", "account name")


@dataclass
class Hit:
    title: str
    url: str
    snippet: str
    date: str | None


@dataclass
class Result:
    company: str
    answer: str = ""
    cost: float = 0.0
    latency_ms: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    search_hits: int = 0
    hits_used: int = 0
    error: str | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)


# ------------------------------------------------------------------------------------------ http


def _post(client: httpx.Client, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    resp = None
    for attempt in range(4):
        resp = client.post(path, json=payload)
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = float(resp.headers.get("retry-after") or 2 ** (attempt + 1))
            print(f"  {path}: HTTP {resp.status_code}, retrying in {wait:.0f}s", file=sys.stderr)
            time.sleep(min(wait, 60))
            continue
        if resp.status_code != 200:
            raise RuntimeError(f"{path}: HTTP {resp.status_code}: {resp.text[:300]}")
        return resp.json()
    raise RuntimeError(f"{path}: gave up after retries (last HTTP {resp.status_code if resp else '?'})")


def _output_text(data: dict[str, Any]) -> str:
    for item in data.get("output") or []:
        if item.get("type") == "message":
            for c in item.get("content") or []:
                if c.get("type") == "output_text" and c.get("text"):
                    return c["text"].strip()
    if isinstance(data.get("output_text"), str):
        return data["output_text"].strip()
    raise RuntimeError(f"no output text (status={data.get('status')})")


# ------------------------------------------------------------------------------------------ search


def search(client: httpx.Client, company: str, start: date, args: argparse.Namespace) -> list[Hit]:
    payload: dict[str, Any] = {"query": [q.replace("{company}", company) for q in SEARCH_QUERIES],
                               "max_results": args.max_results,
                               "search_after_date_filter": start.strftime("%m/%d/%Y")}
    if args.country:
        payload["country"] = args.country
    results = _post(client, "/search", payload).get("results") or []
    # Multi-query responses may come back flat or as one list per query; handle both.
    flat = [h for g in results for h in g] if results and isinstance(results[0], list) else results
    return [Hit(h.get("title") or "", h.get("url") or "", h.get("snippet") or "", h.get("date") or h.get("last_updated"))
            for h in flat]


def select_hits(hits: list[Hit], start: date, limit: int, chars: int) -> list[Hit]:
    """Dedupe by URL, drop results dated before the window (keep undated ones), trim the text."""
    seen: set[str] = set()
    out: list[Hit] = []
    for h in hits:
        if not h.url or h.url in seen:
            continue
        try:
            if h.date and date.fromisoformat(h.date[:10]) < start:
                continue
        except ValueError:
            pass
        seen.add(h.url)
        out.append(Hit(h.title, h.url, h.snippet[:chars], h.date))
        if len(out) >= limit:
            break
    return out


def evidence_block(hits: list[Hit]) -> str:
    return "\n\n".join(f"[{i}] {h.title} — {h.url} — {h.date or 'undated'}\n{h.snippet}"
                       for i, h in enumerate(hits, 1))


# ------------------------------------------------------------------------------------------ research


def research(client: httpx.Client, company: str, start: date, end: date, args: argparse.Namespace) -> Result:
    spec = default_spec(args.window_days)
    r = Result(company=company)
    t0 = time.perf_counter()
    try:
        hits = search(client, company, start, args)
        r.cost = SEARCH_PRICE
        used = select_hits(hits, start, args.hits, args.snippet_chars)
        r.search_hits, r.hits_used, r.evidence = len(hits), len(used), [asdict(h) for h in used]
        if used:
            payload = {
                "model": args.model,
                "input": spec.render(company, start.isoformat(), end.isoformat())
                + "\n\nSearch results:\n\n" + evidence_block(used),
                "instructions": spec.system + SEARCH_GROUNDING,
                "max_output_tokens": args.max_output_tokens,
            }  # no "tools": the model only sees the search results above
            data = _post(client, "/v1/agent", payload)
            u = data.get("usage") or {}
            r.tokens_in = int(u.get("input_tokens") or u.get("prompt_tokens") or 0)
            r.tokens_out = int(u.get("output_tokens") or u.get("completion_tokens") or 0)
            c = u.get("cost")
            r.cost = round(r.cost + float((c.get("total_cost", c.get("total")) if isinstance(c, dict) else c) or 0), 6)
            r.answer = _output_text(data)
        else:  # nothing in the window: no LLM call, the answer the prompt asks for
            r.answer = NOT_FOUND
    except Exception as e:  # noqa: BLE001  (a PoC: record the failure and carry on)
        r.error = str(e)[:500]
    r.latency_ms = int((time.perf_counter() - t0) * 1000)
    # The format starts with the company name; the no-signal form the prompt asks for doesn't, so add it.
    if r.answer and not r.answer.upper().startswith(company.upper()):
        r.answer = f"{company.upper()}\n{r.answer}"
    return r


# ------------------------------------------------------------------------------------------ input / output


def load_companies(args: argparse.Namespace) -> list[str]:
    names = list(args.companies or [])
    if args.file:
        if args.file.lower().endswith((".xlsx", ".xlsm")):
            from openpyxl import load_workbook

            rows = [list(r) for r in load_workbook(args.file, read_only=True, data_only=True).active.iter_rows(values_only=True)]
        else:
            with open(args.file, newline="", encoding="utf-8-sig") as f:
                rows = list(csv.reader(f))
        rows = [[re.sub(r"\s+", " ", str(c if c is not None else "")).strip() for c in r] for r in rows]
        rows = [r for r in rows if any(r)]
        col = 0
        if rows:  # an upload file: find the company column by its header; a plain list: first column
            header = [c.lower() for c in rows[0]]
            idx = next((i for i, h in enumerate(header) if h in COMPANY_HEADERS), None)
            if idx is not None:
                col, rows = idx, rows[1:]
        names += [r[col] for r in rows if col < len(r) and r[col]]
    seen: set[str] = set()
    unique = []
    for n in names:  # one research per logo, like the app
        k = re.sub(r"[^A-Z0-9]", "", n.upper())
        if k and k not in seen:
            seen.add(k)
            unique.append(n)
    return unique[: args.limit] if args.limit else unique


def save(results: list[Result], text: str, meta: dict[str, Any]) -> Path:
    out = HERE / "out" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)
    (out / "answers.txt").write_text(text, encoding="utf-8")
    cols = ["company", "answer", "cost", "latency_ms", "tokens_in", "tokens_out", "search_hits", "hits_used", "error"]
    with open(out / "results.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(asdict(r) for r in results)
    (out / "raw.json").write_text(json.dumps({"meta": meta, "results": [asdict(r) for r in results]},
                                             indent=2, ensure_ascii=False), encoding="utf-8")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--companies", nargs="*", help="logo names")
    ap.add_argument("--file", help="the Excel/CSV you upload to the app (Logo/Company column), or a plain list")
    ap.add_argument("--limit", type=int, default=0, help="only the first N logos")
    ap.add_argument("--model", help="model id, the same one selected in Providers & channels")
    ap.add_argument("--search-only", action="store_true", help="print /search results only, no LLM call")
    ap.add_argument("--window-days", type=int, default=10)
    ap.add_argument("--timezone", default="Asia/Kolkata")
    ap.add_argument("--country", default="IN", help='ISO country for /search, "" for none (default IN)')
    ap.add_argument("--max-results", type=int, default=10, help="/search results per query (1-20)")
    ap.add_argument("--hits", type=int, default=25, help="search results passed to the LLM")
    ap.add_argument("--snippet-chars", type=int, default=1500, help="characters kept per search result")
    ap.add_argument("--max-output-tokens", type=int, default=50_000)
    ap.add_argument("--workers", type=int, default=2, help="logos researched in parallel")
    ap.add_argument("--timeout", type=float, default=300)
    args = ap.parse_args()

    key = os.environ.get("PERPLEXITY_API_KEY")
    if not key:
        ap.error("set PERPLEXITY_API_KEY in poc/.env or the shell")
    companies = load_companies(args)
    if not companies:
        ap.error("give --companies or --file")
    if not args.search_only and not args.model:
        ap.error("--model is required (unless --search-only)")

    end = datetime.now(ZoneInfo(args.timezone)).date()
    start = end - timedelta(days=args.window_days)
    client = httpx.Client(base_url=BASE_URL, timeout=httpx.Timeout(args.timeout, connect=10),
                          headers={"Authorization": f"Bearer {key}"})

    if args.search_only:
        for c in companies:
            hits = search(client, c, start, args)
            used = select_hits(hits, start, args.hits, args.snippet_chars)
            print(f"\n### {c}: {len(hits)} results, {len(used)} kept after dedupe and window filter")
            for i, h in enumerate(used, 1):
                print(f"  [{i}] {h.date or 'undated'}  {h.title[:90]}\n      {h.url}\n"
                      f"      {len(h.snippet)} chars: {h.snippet[:200].replace(chr(10), ' ')}")
        return

    print(f"Researching {len(companies)} logos ({start} to {end}) with {args.model}…", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        results = list(pool.map(lambda c: research(client, c, start, end, args), companies))

    blocks = [r.answer if not r.error else f"{r.company.upper()}\nERROR: {r.error}" for r in results]
    text = "\n\n".join(blocks) + "\n"
    print(text)

    meta = {"model": args.model, "window": [start.isoformat(), end.isoformat()], "queries": SEARCH_QUERIES,
            "country": args.country, "max_results": args.max_results, "hits": args.hits,
            "snippet_chars": args.snippet_chars}
    out = save(results, text, meta)
    print(f"Saved to {out}/ · total cost ${sum(r.cost for r in results):.4f}", file=sys.stderr)


if __name__ == "__main__":
    main()
