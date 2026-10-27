# DeepShop eval

## What the eval is

[DeepShop](https://arxiv.org/abs/2506.02839) is a 2025 academic benchmark of 150 Amazon shopping tasks written the way real people ask, e.g. *"compact digital camera, at least 10x zoom, 4+ stars, $100–300."* Tasks span 5 categories (Books, Electronics, Home, Fashion, Sports) and 3 difficulty levels. Each task can have three kinds of requirements:

- **attributes**: what the product is ("10x zoom")
- **filters**: price, rating, Prime, review count
- **sort**: "cheapest", "highest rated", "newest"

A judge grades each requirement separately; a task passes only if all of them pass. In the paper the best system scored 32%, and plain search + LLM scored under 8%.

`tasks.jsonl` is the paper's `deepshop_filter_150.jsonl` (CC BY 4.0).

## What we ran

A 10-task pilot (every 15th task: all 5 categories, easy and medium only; no hard tasks), three systems on the same tasks:

- **Ours** (`ours.ts`): the search pipeline below.
- **Baseline** (`baseline.ts`): Claude Opus 5.5 with web search and web fetch, told to shop on Amazon. This stands in for how agents shop today.
- **Browser Use** (`browser_use/run.py`): the open-source [browser-use](https://github.com/browser-use/browser-use) agent (0.13) driving a real headless Chromium on live Amazon, like the web agents in the paper. It runs on Claude Opus 5, not 5.5: browser-use forces a tool call on every step, which Opus 5.5 rejects. We set `use_thinking=False` because Opus 5 refuses to fill browser-use's `thinking` output field. Told to stop rather than solve a CAPTCHA.

**Judge** (`judge.ts`): the paper's judge prompt word for word, with one change. The paper's judge looks at screenshots of the agent browsing; we don't browse, so the judge gets data from the chosen product's Amazon page instead, fetched independently of every system. The judge model is Claude Opus 5.5 rather than GPT-4o (no OpenAI key yet). Report results as "DeepShop (product-page judge)".

## Results (pilot, 10/150 tasks, 2026-10-24)

| | Success | Attribute | Filter | Sort | Median tokens/task | Median latency |
|---|---|---|---|---|---|---|
| **Ours** | **40%** | 70% | 50% | 20% | **~6k** | 35s |
| Baseline (Claude + web search) | 20% | 30% | 50% | 40% | ~99k | 51s |
| Browser Use (Opus 5, real browser) | 30% | 33% | 71% | 50% | ~380k | 105s |
| Paper's best published | 32% | | | | | |

About the same or better success than either agent at 1/16 to 1/60 of the tokens. Browser Use cost $13.44 in API fees for the 10 tasks (about $1.34 per task). Amazon showed it a CAPTCHA on 1 of 10 tasks (`Amazon--54`), which counts as a failure; its other per-requirement rates are over the 9 tasks it finished. One task hit a browser start-up timeout on our machine and was re-run. Ten tasks is directional, not a result.

The Ours row predates the relevance-search change in `ours.ts` (`97efb05`); re-run it before quoting these numbers.

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

## Adjacent products

`providers.ts` wraps the products an agent builder would use instead of us. Each one is the only tool of the same Claude agent (`tool_agent.ts`: Claude Opus 5.5, up to 4 searches, then it must answer), so the difference between rows is the data, not the agent.

| System | What the agent searches | Key | Judged on |
|---|---|---|---|
| `channel3` | Channel3 catalog, any retailer | `CHANNEL3_API_KEY` | Channel3's own record |
| `shopify_catalog` | Shopify Global Catalog over UCP (Shopify merchants, no Amazon) | none | Shopify's own record |
| `exa` | Exa web search, amazon.com only | `EXA_API_KEY` | Amazon page |
| `linkup` | Linkup web search, amazon.com only | `LINKUP_API_KEY` | Amazon page |
| `parallel` | Parallel web search, amazon.com only | `PARALLEL_API_KEY` | Amazon page |

Rye isn't here: its API checks out a product URL you already picked and has no search, so there is nothing to compare on choosing the product.

Things to know before quoting these:

- **`channel3` and `shopify_catalog` aren't apples to apples.** Neither returns Amazon products, so they pick from other retailers ("on Amazon" is dropped from the task), and the judge grades the provider's own record of the product instead of an independently fetched page. That favors them: the judge can't catch data the provider got wrong. Rating and review-count filters also use their review counts, not Amazon's.
- **Channel3 search has no Amazon offers** (checked 2026-10-27). amazon.com is in its website list, but filtering search on it, by domain or by website id, returns nothing, and unfiltered results come from Walmart, Best Buy, Adorama and others.
- **Shopify is keyless** and uses Shopify's example agent profile unless `SHOPIFY_AGENT_PROFILE` points to your own. Its terms forbid caching catalog results, so its searches are never cached and re-runs make live calls.
- **Cost:** each tool-agent task is up to 5 Opus calls plus up to 4 provider searches, then the judge. Other providers' responses are cached in `evals/.cache/<provider>/`.

## Running it

Needs `ANTHROPIC_API_KEY` and `RAINFOREST_API_KEY` in `.env`. Rainforest responses are cached in `evals/.cache/` so re-runs cost no credits. A full 150-task run needs about 600 Rainforest credits.

```bash
node --env-file=.env evals/deepshop/run.ts --pilot            # 10 tasks, every system whose keys are set
node --env-file=.env evals/deepshop/run.ts --system ours      # all 150, ours only
node --env-file=.env evals/deepshop/run.ts --pilot --system channel3,shopify_catalog   # a comma-separated subset
node --env-file=.env evals/deepshop/run.ts --pilot --report   # print the table without running
```

The adjacent-product systems also need the keys in the table above; `--system all` skips any whose keys are missing and says so.

Browser Use runs from Python (3.12) with its own Chromium:

```bash
uv venv -p 3.12 .venv-bu && VIRTUAL_ENV=.venv-bu uv pip install browser-use && .venv-bu/bin/browser-use install
set -a; . ./.env; set +a
BROWSER_PATH="<path to Chromium binary>" .venv-bu/bin/python evals/deepshop/browser_use/run.py --pilot
node --env-file=.env evals/deepshop/run.ts --pilot --judge-pending   # judge its answers, print the table
```

Answers and verdicts append to `results/`; finished tasks are skipped on re-run.
