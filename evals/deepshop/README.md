# DeepShop eval

## What the eval is

[DeepShop](https://arxiv.org/abs/2506.02839) is a 2025 academic benchmark of 150 Amazon shopping tasks written the way real people ask, e.g. *"compact digital camera, at least 10x zoom, 4+ stars, $100–300."* Tasks span 5 categories (Books, Electronics, Home, Fashion, Sports) and 3 difficulty levels. Each task can have three kinds of requirements:

- **attributes**: what the product is ("10x zoom")
- **filters**: price, rating, Prime, review count
- **sort**: "cheapest", "highest rated", "newest"

A judge grades each requirement separately; a task passes only if all of them pass. In the paper the best system scored 32%, and plain search + LLM scored under 8%.

`tasks.jsonl` is the paper's `deepshop_filter_150.jsonl` (CC BY 4.0).

## What we ran

A 10-task pilot (every 15th task: all 5 categories, easy and medium only; no hard tasks), two systems on the same tasks:

- **Ours** (`ours.ts`): the search pipeline below.
- **Baseline** (`baseline.ts`): Claude Opus 5.5 with web search and web fetch, told to shop on Amazon. This stands in for how agents shop today.

**Judge** (`judge.ts`): the paper's judge prompt word for word, with one change. The paper's judge looks at screenshots of the agent browsing; we don't browse, so the judge gets data from the chosen product's Amazon page instead, fetched independently of both systems. The judge model is Claude Opus 5.5 rather than GPT-4o (no OpenAI key yet). Report results as "DeepShop (product-page judge)".

## Results (pilot, 10/150 tasks, 2026-10-24)

| | Success | Attribute | Filter | Sort | Median tokens/task | Median latency |
|---|---|---|---|---|---|---|
| **Ours** | **40%** | 70% | 50% | 20% | **~6k** | 35s |
| Baseline (Claude + web search) | 20% | 30% | 50% | 40% | ~99k | 51s |
| Paper's best published | 32% | | | | | |

About 2x the success rate at about 1/16 the tokens. Ten tasks is directional, not a result.

## How our pipeline works

1. **Compile the query** (1 LLM call, low effort) into a structured search. The camera example becomes: search term "compact digital camera 10x zoom", price $100–300, rating ≥ 4, sort featured, must-haves ["10x+ zoom", "compact"].
2. **One Amazon search** via Rainforest, sorted as asked. Price, rating and review-count filters are applied in code, not by the LLM. Keep the top 15.
3. **Shortlist** (1 LLM call, low effort): the 2 most likely matches from titles, prices and ratings.
4. **Verify and answer** (1 LLM call, medium effort): fetch those 2 full product pages (specs, bullets, reviews), pick the one that satisfies every requirement, write the answer.

3 small LLM calls and about 3 Amazon lookups. The model only ever sees structured product data, never web pages, which is where the token savings come from.

## Known weaknesses

- **Sort (20%)**: we see one page of results, so "cheapest" or "highest rated" is judged from about 15 products, not the full set.
- **No product found (2/10)**: no retry with a different query when the first search misses.
- **Latency (35s)**: almost all of it is live Rainforest lookups. Pre-indexing products would bring it to a few seconds.

## Running it

Needs `ANTHROPIC_API_KEY` and `RAINFOREST_API_KEY` in `.env`. Rainforest responses are cached in `evals/.cache/` so re-runs cost no credits. A full 150-task run needs about 600 Rainforest credits.

```bash
node --env-file=.env evals/deepshop/run.ts --pilot            # 10 tasks, both systems
node --env-file=.env evals/deepshop/run.ts --system ours      # all 150, ours only
node --env-file=.env evals/deepshop/run.ts --pilot --report   # print the table without running
```

Answers and verdicts append to `results/`; finished tasks are skipped on re-run.
