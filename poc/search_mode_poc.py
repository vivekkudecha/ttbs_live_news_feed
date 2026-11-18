"""PoC: research logos with the Perplexity Search API + one plain LLM call, using the app's research prompt,
and compare it with the app's agentic call across models and settings.

Modes (--modes, comma-separated; default "search"):
  search           POST /search (standard, $0.005): 5 India-focused queries in the research window, then
                   POST /v1/agent with the app's research prompt and NO tools, given only those results.
  fast             the same with Fast Search ($0.001).
  agentic          what the app does today: one POST /v1/agent call with a plain web_search tool.
  agentic_lean     agentic, with the web_search tool set up like our search step: fast search, research-window
                   date filter, share-price sites excluded, India location.
  agentic_finance  agentic with web_search + finance_search (market data, financials, earnings; $0.005/call).

--model takes one or more model ids (comma-separated); every mode runs with every model.

With one mode and model the output is only the model's answers, in the format the research prompt asks for:

  COMPANY NAME
  Category: ...
  Key signals: ...
  Opportunity type: ...
  Recommended outreach approach: ...

Otherwise it prints each logo's answers side by side, then a cost / outcome table per mode and model.
--experiment NAME saves everything (a copy of this script, the command, answers, CSV, raw JSON) in
poc/experiments/NN_NAME/. Nothing is written to the app. This calls the paid Perplexity API.

  poc/.venv/bin/python poc/search_mode_poc.py --model <model id> --companies "Infosys" "Zomato"
  poc/.venv/bin/python poc/search_mode_poc.py --model a,b --file poc/sample_logos.csv --modes fast,agentic \\
      --experiment cheap_models
  poc/.venv/bin/python poc/search_mode_poc.py --companies "Infosys" --search-only   # just the /search results
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shlex
import shutil
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
from app.research.parser import parse_research  # the app's parser and research prompt (pure modules)
from app.research.prompts import default_spec

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
SEARCH_PRICE = {"search": 0.005, "fast": 0.001}  # USD per successful POST /search (up to 5 queries per request)
MODES = ("search", "fast", "agentic", "agentic_lean", "agentic_finance")

# Mapped to the research prompt's indicators, India-focused (the prompt excludes news from outside India).
# {company} and {industry} are filled in per logo; {industry} is blank when the input has no Industry column.
SEARCH_QUERIES = (
    "{company} India new office OR campus OR plant OR facility OR warehouse OR branch OR data center",
    "{company} India funding OR acquisition OR investment OR capex OR contract OR order win",
    '{company} appoints CIO OR CTO OR CISO OR CDO OR "head of IT" OR "chief digital officer"',
    "{company} digital transformation OR cloud OR AI OR cybersecurity OR ERP OR SAP OR data breach",
    "{company} {industry} India expansion OR partnership OR rollout OR launch",
)

# Market-data sites: share-price pages the prompt excludes anyway; they only cost tokens.
EXCLUDED_DOMAINS = (
    "finance.yahoo.com", "investing.com", "in.investing.com", "marketscreener.com", "tradingview.com",
    "stockanalysis.com", "simplywall.st", "marketsmojo.com", "trendlyne.com", "tickertape.in", "screener.in",
    "zeebiz.com/markets", "moneycontrol.com/stocks", "groww.in", "5paisa.com", "angelone.in",
)
STOCK_TITLE = re.compile(
    r"\b(share price|stock price|target price|shares? (fall|falls|rise|rises|jump|jumps|slip|slips|gain|gains|surge|"
    r"surges|drop|drops|tank|tanks)|stock (falls|rises|jumps|slips|gains)|downgrade[sd]?|upgrade[sd]?|"
    r"(buy|sell|hold) rating|technical analysis)\b", re.IGNORECASE)

# Search dates are often the crawl date, so the model is asked to check the event date in the text itself.
# (Experiment 02 asked for an explicit in-window date and dropped real recent news; this version only drops
# results whose text points to an older event.)
SEARCH_GROUNDING = (
    "\n\nYou cannot browse the web in this task. Use ONLY the numbered search results given after the "
    "research request. Ignore results that are about a different company. The date shown next to a result is "
    "often when the page was crawled, not when the event happened: ignore a result when its text points to an "
    "event before the research window (an older year, quarter or date). If no result qualifies, answer exactly "
    "with the 'Details not found' format. Keep every section to 1-2 short lines and write each source as a plain "
    "URL, once."
)

NOT_FOUND = ("Category: None\nKey signals: Details not found\nOpportunity type: Details not found\n"
             "Recommended outreach approach: Details not found")

# Column names the app accepts on upload (services/imports.py HEADER_ALIASES).
COMPANY_HEADERS = ("company", "company name", "logo", "account", "account name")
INDUSTRY_HEADERS = ("industry", "sector")


@dataclass
class Logo:
    company: str
    industry: str = ""


@dataclass
class Hit:
    title: str
    url: str
    snippet: str
    date: str | None


@dataclass
class Result:
    company: str
    mode: str
    model: str
    answer: str = ""
    status: str = "failed"  # signal | no_signal | failed (as parsed by the app's parser)
    category: str | None = None
    cost: float = 0.0
    search_cost: float = 0.0
    llm_cost: float = 0.0
    tool_cost: float = 0.0
    latency_ms: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    tool_calls: int = 0
    search_hits: int = 0
    hits_used: int = 0
    error: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    evidence: list[dict[str, Any]] = field(default_factory=list)

    @property
    def label(self) -> str:
        return f"{self.mode} · {self.model.split('/')[-1]}"


# ------------------------------------------------------------------------------------------ http


def _post(client: httpx.Client, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    resp = None
    for attempt in range(5):
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


def agent_tools(mode: str, start: date) -> tuple[list[dict[str, Any]], int | None]:
    """(tools, max_steps) for the agentic modes."""
    if mode == "agentic":  # exactly what the app sends today
        return [{"type": "web_search"}], None
    web = {"type": "web_search", "search_type": "fast", "user_location": {"country": "IN"},
           "filters": {"search_domain_filter": [f"-{d}" for d in EXCLUDED_DOMAINS][:20],
                       "search_after_date_filter": start.strftime("%m/%d/%Y")}}
    if mode == "agentic_lean":
        return [web], None
    return [{"type": "web_search"}, {"type": "finance_search"}], 3  # finance_search needs max_steps >= 3


def _agent(client: httpx.Client, model: str, prompt: str, instructions: str, args: argparse.Namespace,
           r: Result, tools: list[dict[str, Any]] | None = None, max_steps: int | None = None) -> str:
    payload: dict[str, Any] = {"model": model, "input": prompt, "instructions": instructions,
                               "max_output_tokens": args.max_output_tokens}
    if tools:
        payload["tools"] = tools
    if max_steps:
        payload["max_steps"] = max_steps
    if args.reasoning:
        payload["reasoning"] = {"effort": args.reasoning}
    data = _post(client, "/v1/agent", payload)
    u = data.get("usage") or {}
    r.usage = u
    r.tokens_in = int(u.get("input_tokens") or 0)
    r.tokens_out = int(u.get("output_tokens") or 0)
    r.tool_calls += sum(int(t.get("invocation") or 0) for t in (u.get("tool_calls_details") or {}).values()
                        if isinstance(t, dict))
    c = u.get("cost")
    r.llm_cost = float((c.get("total_cost", c.get("total")) if isinstance(c, dict) else c) or 0)
    r.tool_cost = float((c or {}).get("tool_calls_cost") or 0) if isinstance(c, dict) else 0.0
    return _output_text(data)


# ------------------------------------------------------------------------------------------ search


def search(client: httpx.Client, logo: Logo, start: date, args: argparse.Namespace, search_type: str) -> list[Hit]:
    queries = [re.sub(r"\s+", " ", q.replace("{company}", logo.company).replace("{industry}", logo.industry)).strip()
               for q in SEARCH_QUERIES]
    payload: dict[str, Any] = {"query": queries, "max_results": args.max_results,
                               "search_after_date_filter": start.strftime("%m/%d/%Y"),
                               "search_domain_filter": [f"-{d}" for d in EXCLUDED_DOMAINS][:20]}
    if search_type == "fast":
        payload["search_type"] = "fast"
    if args.country:
        payload["country"] = args.country
    results = _post(client, "/search", payload).get("results") or []
    # Multi-query responses may come back flat or as one list per query; handle both.
    flat = [h for g in results for h in g] if results and isinstance(results[0], list) else results
    return [Hit(h.get("title") or "", h.get("url") or "", h.get("snippet") or "", h.get("date") or h.get("last_updated"))
            for h in flat]


def select_hits(hits: list[Hit], start: date, limit: int, chars: int) -> list[Hit]:
    """Dedupe by URL; drop share-price pages and results dated before the window (keep undated); trim the text."""
    seen: set[str] = set()
    out: list[Hit] = []
    for h in hits:
        if not h.url or h.url in seen or STOCK_TITLE.search(h.title):
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


def research(client: httpx.Client, logo: Logo, mode: str, model: str, start: date, end: date,
             args: argparse.Namespace) -> Result:
    spec = default_spec(args.window_days)
    prompt = spec.render(logo.company, start.isoformat(), end.isoformat())
    r = Result(company=logo.company, mode=mode, model=model)
    t0 = time.perf_counter()
    try:
        if mode.startswith("agentic"):
            tools, steps = agent_tools(mode, start)
            r.answer = _agent(client, model, prompt, spec.system, args, r, tools, steps)
        else:
            hits = search(client, logo, start, args, mode)
            r.search_cost, r.tool_calls = SEARCH_PRICE[mode], 1
            used = select_hits(hits, start, args.hits, args.snippet_chars)
            r.search_hits, r.hits_used, r.evidence = len(hits), len(used), [asdict(h) for h in used]
            if used:  # no tools: the model only sees the search results
                r.answer = _agent(client, model, prompt + "\n\nSearch results:\n\n" + evidence_block(used),
                                  spec.system + SEARCH_GROUNDING, args, r)
            else:  # nothing usable in the window: no LLM call, the answer the prompt asks for
                r.answer = NOT_FOUND
        p = parse_research(r.answer, spec.categories)
        r.status, r.category = p.status, p.category
    except Exception as e:  # noqa: BLE001  (a PoC: record the failure and carry on)
        r.error = str(e)[:500]
    r.cost = round(r.search_cost + r.llm_cost, 6)
    r.latency_ms = int((time.perf_counter() - t0) * 1000)
    r.answer = with_company_line(r.answer, logo.company)
    return r


def with_company_line(answer: str, company: str) -> str:
    """The format starts with one company-name line. Models sometimes bold it, write 'COMPANY NAME: X', leave a
    blank line, or (in the no-signal form the prompt asks for) skip it; normalise all of those."""
    if not answer:
        return answer
    label = re.compile(r"(category|key signals|opportunity type|recommended outreach approach)\s*:", re.IGNORECASE)
    lines = [ln for ln in answer.strip().splitlines() if ln.strip()]
    name = ""
    while lines and not label.match(lines[0].strip().strip("*").strip()):  # name line(s) before the first label
        name = re.sub(r"^company name\s*:\s*", "", lines.pop(0).strip().strip("*#").strip(), flags=re.IGNORECASE)
    return f"{name or company}\n" + "\n".join(lines)


# ------------------------------------------------------------------------------------------ input / output


def load_logos(args: argparse.Namespace) -> list[Logo]:
    logos = [Logo(c) for c in args.companies or []]
    if args.file:
        if args.file.lower().endswith((".xlsx", ".xlsm")):
            from openpyxl import load_workbook

            ws = load_workbook(args.file, read_only=True, data_only=True).active
            rows = [list(r) for r in ws.iter_rows(values_only=True)]
        else:
            with open(args.file, newline="", encoding="utf-8-sig") as f:
                rows = list(csv.reader(f))
        rows = [[re.sub(r"\s+", " ", str(c if c is not None else "")).strip() for c in r] for r in rows]
        rows = [r for r in rows if any(r)]
        col, ind = 0, None
        if rows:  # an upload file: find columns by header; a plain list: first column
            header = [c.lower() for c in rows[0]]
            idx = next((i for i, h in enumerate(header) if h in COMPANY_HEADERS), None)
            if idx is not None:
                col, rows = idx, rows[1:]
                ind = next((i for i, h in enumerate(header) if h in INDUSTRY_HEADERS), None)
        logos += [Logo(r[col], r[ind] if ind is not None and ind < len(r) else "") for r in rows if col < len(r) and r[col]]
    seen: set[str] = set()
    unique = []
    for lg in logos:  # one research per logo, like the app
        k = re.sub(r"[^A-Z0-9]", "", lg.company.upper())
        if k and k not in seen:
            seen.add(k)
            unique.append(lg)
    return unique[: args.limit] if args.limit else unique


def block(r: Result) -> str:
    return r.answer if not r.error else f"{r.company.upper()}\nERROR: {r.error}"


def summary(results: list[Result], labels: list[str], baseline: str | None) -> str:
    lines = [("| Mode · model | Logos | Signals | No signal | Failed | Total cost | Cost / logo | Time / logo "
              "| Tokens in / out (avg) | Searches |"), "|" + "---|" * 10]
    for lb in labels:
        rs = [r for r in results if r.label == lb]
        ok = [r for r in rs if not r.error]
        n = max(len(ok), 1)
        searches = (f"{sum(r.hits_used for r in ok) / n:.1f} results used" if not rs[0].mode.startswith("agentic")
                    else f"{sum(r.tool_calls for r in ok) / n:.1f} tool calls")
        lines.append(
            f"| {lb} | {len(rs)} | {sum(r.status == 'signal' for r in ok)} | {sum(r.status == 'no_signal' for r in ok)} "
            f"| {len(rs) - len(ok)} | ${sum(r.cost for r in rs):.4f} | ${sum(r.cost for r in ok) / n:.4f} "
            f"| {sum(r.latency_ms for r in ok) / n / 1000:.1f}s | {sum(r.tokens_in for r in ok) // n} / "
            f"{sum(r.tokens_out for r in ok) // n} | {searches} |")
    if baseline:
        base = {r.company: r for r in results if r.label == baseline and not r.error}
        for lb in (lb for lb in labels if lb != baseline):
            pairs = [(base[r.company], r) for r in results if r.label == lb and not r.error and r.company in base]
            if not pairs:
                continue
            same = sum(a.status == b.status for a, b in pairs)
            both = [(a, b) for a, b in pairs if a.status == b.status == "signal"]
            only_base = ", ".join(a.company for a, b in pairs if a.status == "signal" and b.status != "signal")
            only_new = ", ".join(b.company for a, b in pairs if b.status == "signal" and a.status != "signal")
            lines += ["", (f"**{lb} vs {baseline}** ({len(pairs)} logos): signal / no-signal agree on {same}; category "
                           f"agrees on {sum(a.category == b.category for a, b in both)} of {len(both)} where both "
                           "found a signal."),
                      f"- signal only with {baseline}: {only_base or '-'}",
                      f"- signal only with {lb}: {only_new or '-'}"]
    return "\n".join(lines)


def output_dir(experiment: str | None) -> Path:
    if not experiment:
        return HERE / "out" / datetime.now().strftime("%Y%m%d-%H%M%S")
    root = HERE / "experiments"
    root.mkdir(exist_ok=True)
    nums = [int(m.group(1)) for p in root.iterdir() if (m := re.match(r"(\d+)_", p.name))]
    slug = re.sub(r"[^a-z0-9]+", "_", experiment.lower()).strip("_")
    return root / f"{max(nums, default=0) + 1:02d}_{slug}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--companies", nargs="*", help="logo names")
    ap.add_argument("--file", help="the Excel/CSV you upload to the app (Company/Logo and Industry columns), or a list")
    ap.add_argument("--limit", type=int, default=0, help="only the first N logos")
    ap.add_argument("--model", help="model id(s), comma-separated, e.g. the one selected in Providers & channels")
    ap.add_argument("--modes", default="search", help=f"comma-separated: {', '.join(MODES)} (default search)")
    ap.add_argument("--baseline", help='mode · model label to compare against (default: "agentic · <first model>")')
    ap.add_argument("--experiment", help="save everything in poc/experiments/NN_<name>/")
    ap.add_argument("--reasoning", choices=["minimal", "low", "medium", "high"], help="reasoning effort (default: model's)")
    ap.add_argument("--search-only", action="store_true", help="print /search results only, no LLM call")
    ap.add_argument("--search-type", choices=["search", "fast"], default="search", help="for --search-only")
    ap.add_argument("--window-days", type=int, default=10)
    ap.add_argument("--timezone", default="Asia/Kolkata")
    ap.add_argument("--country", default="IN", help='ISO country for /search, "" for none (default IN)')
    ap.add_argument("--max-results", type=int, default=20, help="/search max_results (caps the whole request; 1-20)")
    ap.add_argument("--hits", type=int, default=20, help="search results passed to the LLM")
    ap.add_argument("--snippet-chars", type=int, default=1500, help="characters kept per search result")
    ap.add_argument("--max-output-tokens", type=int, default=50_000)
    ap.add_argument("--workers", type=int, default=2, help="calls in parallel")
    ap.add_argument("--timeout", type=float, default=300)
    args = ap.parse_args()

    key = os.environ.get("PERPLEXITY_API_KEY")
    if not key:
        ap.error("set PERPLEXITY_API_KEY in poc/.env or the shell")
    logos = load_logos(args)
    if not logos:
        ap.error("give --companies or --file")
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    if bad := [m for m in modes if m not in MODES]:
        ap.error(f"unknown mode(s): {', '.join(bad)}")
    models = [m.strip() for m in (args.model or "").split(",") if m.strip()]
    if not args.search_only and not models:
        ap.error("--model is required (unless --search-only)")

    end = datetime.now(ZoneInfo(args.timezone)).date()
    start = end - timedelta(days=args.window_days)
    client = httpx.Client(base_url=BASE_URL, timeout=httpx.Timeout(args.timeout, connect=10),
                          headers={"Authorization": f"Bearer {key}"})

    if args.search_only:
        for lg in logos:
            hits = search(client, lg, start, args, args.search_type)
            used = select_hits(hits, start, args.hits, args.snippet_chars)
            print(f"\n### {lg.company}: {len(hits)} results, {len(used)} kept after filters")
            for i, h in enumerate(used, 1):
                print(f"  [{i}] {h.date or 'undated'}  {h.title[:90]}\n      {h.url}\n"
                      f"      {len(h.snippet)} chars: {h.snippet[:200].replace(chr(10), ' ')}")
        return

    print(f"Researching {len(logos)} logos ({start} to {end}) · modes: {', '.join(modes)} · models: "
          f"{', '.join(models)}" + (f" · reasoning {args.reasoning}" if args.reasoning else "") + "…", file=sys.stderr)
    jobs = [(lg, m, md) for lg in logos for m in modes for md in models]
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        results = list(pool.map(lambda j: research(client, j[0], j[1], j[2], start, end, args), jobs))

    labels = list(dict.fromkeys(r.label for r in results))
    if len(labels) == 1:
        text = "\n\n".join(block(r) for r in results) + "\n"
    else:
        baseline = args.baseline or f"agentic · {models[0].split('/')[-1]}"
        parts = []
        for lg in logos:
            parts.append(f"## {lg.company}" + (f" ({lg.industry})" if lg.industry else ""))
            for r in (r for r in results if r.company == lg.company):
                parts.append(f"### {r.label} · ${r.cost:.4f} · {r.latency_ms / 1000:.1f}s\n```\n{block(r)}\n```")
        text = ("\n\n".join(parts) + "\n\n## Summary\n\n"
                + summary(results, labels, baseline if baseline in labels else None) + "\n")
    print(text)

    out = output_dir(args.experiment)
    out.mkdir(parents=True)
    (out / ("answers.txt" if len(labels) == 1 else "comparison.md")).write_text(text, encoding="utf-8")
    cols = ["company", "mode", "model", "status", "category", "answer", "cost", "search_cost", "llm_cost", "tool_cost",
            "latency_ms", "tokens_in", "tokens_out", "tool_calls", "search_hits", "hits_used", "error"]
    with open(out / "results.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(asdict(r) for r in results)
    meta = {"models": models, "modes": modes, "reasoning": args.reasoning, "window": [str(start), str(end)],
            "queries": SEARCH_QUERIES, "excluded_domains": EXCLUDED_DOMAINS, "country": args.country,
            "max_results": args.max_results, "hits": args.hits, "snippet_chars": args.snippet_chars}
    (out / "raw.json").write_text(json.dumps({"meta": meta, "results": [asdict(r) for r in results]},
                                             indent=2, ensure_ascii=False), encoding="utf-8")
    if args.experiment:  # keep the exact script and command that produced these results
        shutil.copy2(__file__, out / "script.py")
        (out / "command.txt").write_text(shlex.join(["poc/.venv/bin/python", *sys.argv]) + "\n")
    print(f"Saved to {out}/ · total cost ${sum(r.cost for r in results):.4f}", file=sys.stderr)


if __name__ == "__main__":
    main()
