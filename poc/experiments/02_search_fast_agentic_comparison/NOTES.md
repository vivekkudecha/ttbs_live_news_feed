# 02 · Standard search vs fast search vs agentic (today's app)

- **Date:** 2026-11-18
- **Logos:** the 15 in `poc/sample_logos.csv`
- **Model:** `anthropic/claude-haiku-5-5`
- **Script:** not kept as a copy. It is the version from just before experiment 03, with these differences:
  - The date rule in `SEARCH_GROUNDING` was strict: "use a result only if its own text shows the event happened
    inside the research window".
  - There was no company-line clean-up.
- **Changes since 01:**
  - `max_results` raised to 20.
  - India-focused queries mapped to the prompt's indicators, plus the Industry column.
  - Share-price sites and headlines filtered out.
  - The prompt asks for 1-2 lines per section and plain URLs.

## Result
| Mode | Cost / logo | Signals | Time / logo |
|---|---|---|---|
| agentic (app today) | $0.0046 | 12 / 15 | 10.3s |
| search + LLM | $0.0073 | 10 / 15 | 10.7s |
| fast search + LLM | $0.0033 | 10 / 15 | 10.9s |

- **Signal only with agentic:** Infosys, Zomato, Asian Paints, Mahindra Logistics.
- **Signal only with search modes:** Tata Motors, Nykaa.

## Learned
- **Agentic is already cheap.** The app's call makes only one web search per logo, because `max_steps` defaults to 1
  when a model is passed.
- **Fast search + LLM is the only cheaper option,** at about -28% per logo.
- **Search dates are unreliable.** The Search API's `date` and `last_updated` both look like crawl dates. The 2021
  Asian Paints Rs 960 cr Ankleshwar story and a 2016 Infosys Hyderabad campus story both came back dated November
  2026.
- **The app is affected too.** Agentic search uses the same search, so it presented two years-old stories (Asian
  Paints Ankleshwar, Infosys–Daimler) as new signals.
- **The strict date rule went too far.** It dropped real recent news whose text does not state a date (Infosys
  Vizag campus, Zomato). Relaxed in 03.
