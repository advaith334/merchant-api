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

## Results (pilot, 10/150 tasks, 2026-10-27)

| | Success | 95% CI | Attribute | Filter | Sort | Median tokens/task | Median latency |
|---|---|---|---|---|---|---|---|
| **Ours** | **40%** | 17–69% | 70% | 63% | 20% | **~8k** | 27s |
| Baseline (Claude + web search) | 20% | 6–51% | 30% | 50% | 40% | ~99k | 51s |
| Browser Use (Opus 5, real browser) | 30% | 11–60% | 33% | 71% | 50% | ~380k | 105s |
| Channel3* | 20% | 6–51% | 50% | 50% | 20% | ~48k | 22s |
| Shopify Catalog* | 40% | 17–69% | 70% | 63% | 0% | ~26k | 20s |
| Paper's best published | 32% | | | | | | |

\*Not Amazon, and judged on the provider's own record; see [Adjacent products](#adjacent-products).

Success is over all 10 tasks: a task a system never answered counts as a failure (Browser Use hit a CAPTCHA on `Amazon--54`). The intervals all overlap, so **10 tasks can't separate these systems**; what the pilot does show is the token gap (3x fewer than Shopify's catalog, 12x fewer than the baseline, 50x fewer than Browser Use). Browser Use cost $13.44 in API fees for the 10 tasks. One of its tasks hit a browser start-up timeout on our machine and was re-run.

These 10 tasks are also our **dev set**: we looked at every failure and changed `ours.ts` because of them, so they overstate us. Report the test set (below), not these.

## Publishing a result

1. **Freeze the code.** Note the commit hash; no changes to any system or the judge after the test run starts.
2. **Run every system on the test set** (`--test`: the 140 tasks outside the pilot, never tuned on), in the same week, since Amazon listings change.
3. **Report success with its 95% CI** over all 140 tasks, unanswered tasks counted as failures. Lead with the comparison the intervals support.
4. **Check the judge.** It's Claude Opus 5.5, the same model our pipeline uses, so it may favor our answers. Hand-grade a random 30 verdicts across systems and report the agreement rate.
5. **Publish `results/`** (every answer and verdict) with the commit hash, so anyone can audit a task.
6. **Keep Channel3 and Shopify separate** from the Amazon systems, with the caveat below.

## How our pipeline works

1. **Compile the query** (1 LLM call, low effort) into a structured search. The camera example becomes: search term "compact digital camera 10x zoom", price $100–300, rating ≥ 4, sort featured, must-haves ["10x+ zoom", "compact"].
2. **Amazon search** via Rainforest, by relevance plus Amazon's own sort when one is asked for (including best sellers). Price, rating and review-count filters are applied in code, not by the LLM: products that pass every filter rank first, then near misses. Keep the top 15.
3. **Shortlist** (1 LLM call, low effort): the 2 most likely matches from titles, prices and ratings. If none is even the right kind of product, search once more with a better term.
4. **Verify and answer** (1 LLM call, medium effort): fetch those 2 full product pages (specs, bullets, reviews, size/color variants), pick the one that best satisfies the task, and the variant matching any size or color it names. Always answers: if nothing meets every requirement, it picks the closest and says what it misses.

3 to 5 small LLM calls and 3 to 4 Amazon lookups. The model only ever sees structured product data, never web pages, which is where the token savings come from.

## Known weaknesses

- **Sort (20%)**: we see one page of results, so "cheapest" or "highest rated" is judged from about 15 products, not the full set. "Best-selling" depends on a rank many product pages don't show.
- **Cheapest-item tasks** pull in junk listings (a $3 "running shoe" with no reviews).
- **Latency (35s)**: almost all of it is live Rainforest lookups. Pre-indexing products would bring it to a few seconds.

## Adjacent products

`providers.ts` wraps the products an agent builder would use instead of us. Each one is the only tool of the same Claude agent (`tool_agent.ts`: Claude Opus 5.5, up to 4 searches, then it must answer), so the difference between rows is the data, not the agent.

| System | What the agent searches | Key | Judged on |
|---|---|---|---|
| `channel3` | Channel3 catalog, any retailer | `CHANNEL3_API_KEY` | Channel3's own record |
| `shopify_catalog` | Shopify Global Catalog over UCP (Shopify merchants, no Amazon) | none | Shopify's own record |
| `google_shopping` | Google Shopping via SerpApi, any retailer | `SERPAPI_API_KEY` | Google's own record |
| `exa` | Exa web search, amazon.com only | `EXA_API_KEY` | Amazon page |
| `linkup` | Linkup web search, amazon.com only | `LINKUP_API_KEY` | Amazon page |
| `parallel` | Parallel web search, amazon.com only | `PARALLEL_API_KEY` | Amazon page |
| `tavily` | Tavily web search, amazon.com only | `TAVILY_API_KEY` | Amazon page |

Rye isn't here: its API checks out a product URL you already picked and has no search, so there is nothing to compare on choosing the product. ChatGPT and Perplexity shopping and Amazon's Rufus have no public API.

Things to know before quoting these:

- **`channel3`, `shopify_catalog` and `google_shopping` aren't apples to apples.** Neither returns Amazon products, so they pick from other retailers ("on Amazon" is dropped from the task), and the judge grades the provider's own record of the product instead of an independently fetched page. That favors them: the judge can't catch data the provider got wrong. Rating and review-count filters also use their review counts, not Amazon's.
- **Channel3 search has no Amazon offers** (checked 2026-10-27). amazon.com is in its website list, but filtering search on it, by domain or by website id, returns nothing, and unfiltered results come from Walmart, Best Buy, Adorama and others.
- **Shopify is keyless** and uses Shopify's example agent profile unless `SHOPIFY_AGENT_PROFILE` points to your own. Its terms forbid caching catalog results, so its searches are never cached and re-runs make live calls.
- **Cost:** each tool-agent task is up to 5 Opus calls plus up to 4 provider searches, then the judge. Other providers' responses are cached in `evals/.cache/<provider>/`.

## Amazon data source

Every Amazon search and product page, for our pipeline and for the judge, comes from one source per run:

- **Rainforest** (default): richer pages (specs, reviews, the selected size and color in the title). Used for the dev results above.
- **ScraperAPI** (`AMAZON_DATA=scraperapi`): what the test run uses, because its free trial covers it. Pages are thinner: often no specs or reviews, the star rating is computed from the star distribution, and sizes are often missing from the variant list. Results go to `results/scraperapi/`.

Thinner pages make the judge stricter for every Amazon system alike: it fails an answer when the page can't confirm a size or color. On the 10 dev tasks our pipeline scored 40% on Rainforest and 20% on ScraperAPI (picking a different product on 7 of 10, since search results differ too). Compare systems within one source, never across.

## Running it

Needs `ANTHROPIC_API_KEY` and `RAINFOREST_API_KEY` in `.env`. Rainforest responses are cached in `evals/.cache/` so re-runs cost no credits. A test-set run of ours needs about 600 Rainforest credits, and judging each Amazon system needs about 1 credit per task, so all systems together need roughly 1,200 (the free plan has 100 a month; Starter has 10,000).

```bash
node --env-file=.env evals/deepshop/run.ts --pilot            # dev set: 10 tasks, every system whose keys are set
node --env-file=.env evals/deepshop/run.ts --test             # test set: the other 140 tasks; report these
AMAZON_DATA=scraperapi node --env-file=.env evals/deepshop/run.ts --test --sample 70   # the published run: a fixed sample of 70 test tasks
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
