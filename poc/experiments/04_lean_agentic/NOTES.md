# 04 · Today's agentic call vs "lean" agentic, haiku vs gpt-6-luna

- **Date:** 2026-11-18
- **Logos:** the 15 in `poc/sample_logos.csv`
- **Total cost:** $0.21
- **Script:** `script.py`
- **`agentic`:** exactly the app's call, `tools: [{"type": "web_search"}]`.
- **`agentic_lean`:** the same single call, with the web_search tool configured: `search_type: fast`,
  `user_location: IN`, `filters.search_after_date_filter` set to the window start, and share-price sites excluded.
  No pipeline change: it is only tool settings in the app's existing request.

## Result
| Mode · model | Cost / logo | Signals | Time / logo |
|---|---|---|---|
| agentic · haiku (app today) | $0.0047 | 12 | 9.9s |
| agentic · gpt-6-luna | $0.0039 | 13 | 12.6s |
| agentic_lean · haiku | $0.0032 | 13 | 8.8s |
| **agentic_lean · gpt-6-luna** | **$0.0024** | 13 | 12.1s |

Spot checks:

| Logo | Today (agentic · haiku) | agentic_lean · luna |
|---|---|---|
| Infosys | Stale Daimler deal (about 2020) | Rs 290 cr Mohali expansion, which is in the window |
| Shreeji Logistics | News about a different "Shreeji" company | Details not found |
| Asian Paints | No signal | Rejected the stale 2021 Rs 960 cr story |
| Mahindra Logistics | No signal | Real, recent Bhiwandi and Agartala warehouses |

## Learned
- **Lean agentic is the cheapest option so far without changing the architecture:** about **-49% per logo** vs
  today, with equal or better answers on the spot checks. It only changes the tool settings and the model id.
- **The agentic calls still make only one search** (`max_steps` defaults to 1), so "agentic" here is one search
  plus one answer. That matches the Search + LLM pipeline in cost and behaviour, but needs no extra code.
- **Answers vary from run to run.** Today's agentic · haiku found Asian Paints in 02 but not here, and Shreeji
  here but not in 02. Compare on more logos and repeat runs before deciding.
- **The date filter does not stop all stale news,** because publication dates are unreliable. haiku-lean still
  used the 2021 Asian Paints story; luna rejected it.
