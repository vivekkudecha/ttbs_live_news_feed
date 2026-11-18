# 03 · Cheap models on Fast Search + LLM

- **Date:** 2026-11-18
- **Logos:** the 15 in `poc/sample_logos.csv`
- **Mode:** `fast` (Fast Search, $0.001, then one LLM call)
- **Total cost:** $0.24
- **Script:** `script.py`
- **Change since 02:** the date rule is relaxed. A result is dropped only when its text points to an event before
  the research window; it no longer has to show an in-window date.

## Result
| Model | Cost / logo | Signals | Time / logo | Out tokens | Verdict |
|---|---|---|---|---|---|
| claude-haiku-5-5 (current) | $0.0033 | 14 | 11.3s | 2,071 | Good recall, but it accepted the stale 2021 Asian Paints Rs 960 cr story again |
| **gpt-6-luna** | **$0.0022** | 12 | 12.4s | 807 | **Cheapest; conservative.** Rejected stale Asian Paints and the unclear Shreeji match. Short answers |
| nemotron-3.5-super | $0.0027 | 14 | 6.9s | 555 | Matched a different "Shreeji" company. One answer's status does not match its text (Bajaj) |
| gemini-3.1-flash-lite | $0.0032 | 15 | 3.5s | 310 | Fastest, but finds a "signal" everywhere, including the wrong Shreeji company |
| glm-5.3-flash | $0.0052 | 9 (3 failed) | 113s | 6,459 | Slow, timeouts, expensive: rejected |

## Learned
- **The relaxed date rule restores recall** (haiku: 10 to 14 signals), but stale stories come back with it.
  The date problem needs a code-side fix: check the cited article's real published date.
- **Generic names are risky.** Shreeji Logistics has no clear news, and two models attached news about another
  "Shreeji" company. The Industry column alone does not prevent this.
- **`gpt-6-luna` is the best price/quality candidate:** -33% per logo vs haiku on the same pipeline, and -52% vs
  today's agentic call ($0.0046 in 02). It is more conservative (2 fewer signals than haiku), so its recall should
  be checked on more logos.
