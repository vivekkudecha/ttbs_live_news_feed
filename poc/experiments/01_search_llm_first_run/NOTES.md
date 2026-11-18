# 01 · Search + LLM, first run

- **Date:** 2026-11-18
- **Logos:** Infosys, Zomato
- **Model:** `anthropic/claude-haiku-5-5`
- **Mode:** standard Search API, then one LLM call with no tools
- **Script:** `script.py` (commit `6831e0a`)
- **Search settings:** 5 general queries, `max_results` 10, research window as a date filter, country IN

## Result
| Logo | Answer | Cost | Time |
|---|---|---|---|
| Infosys | No signal ("Details not found") | $0.0066 | 7.7s |
| Zomato | Expansion (Eternal: 12 lakh riders, EV fleet plans) | $0.0069 | 12.2s |

## Learned
- The pipeline works end to end, and the output is in the app's research-prompt format.
- `max_results` caps the **whole request**, not each query, so 5 queries returned only 10 results in total.
- The general `"X" news` query pulled share-price pages (Yahoo Finance, Investing.com). They are noise for this
  prompt, which excludes stock commentary.
- About 75% of the cost is the $0.005 search fee.
