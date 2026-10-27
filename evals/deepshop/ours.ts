// Our pipeline: compile the query into a structured product search, run a
// filtered Amazon search (searching again once if it misses the product type),
// verify a short list on product pages, pick the matching variant, answer.
// No browsing, no screenshots: the agent only ever sees structured product data.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, amazon, client, trimProduct, trimSearchResult, usageOf, type Answer, type Task } from "./common.ts";

export const SORTS = ["featured", "bestseller_rankings", "price_low_to_high", "price_high_to_low", "average_review", "most_recent"] as const;

export const Plan = z.object({
  search_term: z.string().describe("Amazon search box text: product type plus the 1-3 most discriminating attributes"),
  sort_by: z.enum(SORTS).describe("bestseller_rankings for best-selling or most popular; featured when no order is asked for"),
  min_price: z.number().nullable(),
  max_price: z.number().nullable(),
  min_rating: z.number().nullable(),
  min_reviews: z.number().nullable(),
  prime_only: z.boolean(),
  must_have: z.array(z.string()).describe("attributes that must be verified on the product page"),
  also_report: z.string().nullable().describe("extra information the task asks for, e.g. the most helpful review"),
});

const Shortlist = z.object({
  asins: z.array(z.string()).describe("best candidates first, at most 3"),
  right_product_type: z.boolean().describe("false if no candidate is even the kind of product the task asks for"),
  retry_search_term: z.string().nullable().describe("when right_product_type is false: a better Amazon search term"),
});
const Final = z.object({
  asin: z.string().describe("the chosen product, or the ASIN of its variant that matches the size/color/option the task names"),
  response: z.string(),
});

/** A product page plus its variants (size, color, ...), each with its own ASIN. */
export async function productWithVariants(asin: string) {
  const p = (await amazon({ type: "product", asin })).product;
  const variants = (p?.variants ?? []).slice(0, 80).map((v: any) => ({
    asin: v.asin,
    options: (v.dimensions ?? []).map((d: any) => `${d.name}: ${d.value}`).join(", ") || v.title,
  }));
  return { ...trimProduct(p), variants };
}

export async function runOurs(task: Task): Promise<Answer> {
  const t0 = Date.now();
  let input = 0, output = 0, calls = 0;
  const tally = (m: Parameters<typeof usageOf>[0]) => { const u = usageOf(m); input += u.input; output += u.output; };

  // 1. Compile the request.
  const planMsg = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Plan) },
    messages: [{ role: "user", content: `Turn this Amazon shopping task into a structured search.\n\nTask: ${task.ques}` }],
  });
  tally(planMsg);
  const plan = planMsg.parsed_output!;

  // 2. Search by relevance (plus Amazon's own sort when one is asked for: a bare
  // price sort surfaces junk listings), then apply the numeric filters ourselves.
  const seen = new Set<string>();
  const all: any[] = [];
  const search = async (search_term: string, sort_by: string) => {
    const data = await amazon({ type: "search", search_term, sort_by });
    calls++;
    for (const r of (data.search_results ?? []).map(trimSearchResult)) {
      if (r.asin && !seen.has(r.asin)) { seen.add(r.asin); all.push(r); }
    }
  };
  // Amazon's own order first for the sorts we can't recompute (best sellers, newest).
  for (const sort_by of plan.sort_by === "featured" ? ["featured"] : [plan.sort_by, "featured"]) await search(plan.search_term, sort_by);

  const failures = (r: any) =>
    Number(plan.min_price != null && !(r.price != null && r.price >= plan.min_price)) +
    Number(plan.max_price != null && !(r.price != null && r.price <= plan.max_price)) +
    Number(plan.min_rating != null && !(r.rating != null && r.rating >= plan.min_rating)) +
    Number(plan.min_reviews != null && !(r.ratings_total != null && r.ratings_total >= plan.min_reviews)) +
    Number(plan.prime_only && !r.is_prime);
  const rank = () => {
    const pool = [...all];
    if (plan.sort_by === "price_low_to_high") pool.sort((a: any, b: any) => (a.price ?? 1e9) - (b.price ?? 1e9));
    if (plan.sort_by === "price_high_to_low") pool.sort((a: any, b: any) => (b.price ?? -1) - (a.price ?? -1));
    if (plan.sort_by === "average_review") pool.sort((a: any, b: any) => (b.rating ?? 0) - (a.rating ?? 0) || (b.ratings_total ?? 0) - (a.ratings_total ?? 0));
    // Products that pass every filter first, then the near misses, each group still in sort order.
    return pool.sort((a, b) => failures(a) - failures(b)).slice(0, 15);
  };

  // 3. Shortlist from titles. If nothing is even the right kind of product, search once more.
  const shortlistFrom = async (pool: any[]) => {
    const msg = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: "low", format: zodOutputFormat(Shortlist) },
      messages: [{
        role: "user",
        content: `Task: ${task.ques}\nRequired attributes: ${plan.must_have.join("; ") || "none"}\n` +
          `Sort preference: ${plan.sort_by}. The list below is in sort order with products that pass the task's filters first; prefer earlier items when they fit.\n\n` +
          `Candidates:\n${pool.map((r: any) => JSON.stringify(r)).join("\n")}\n\nPick up to 3 ASINs most likely to satisfy every requirement.`,
      }],
    });
    tally(msg);
    return msg.parsed_output!;
  };
  let pool = rank();
  let short = await shortlistFrom(pool);
  if (!short.right_product_type && short.retry_search_term) {
    await search(short.retry_search_term, "featured");
    pool = rank();
    short = await shortlistFrom(pool);
  }
  const shortlist = short.asins.filter((a) => pool.some((r: any) => r.asin === a)).slice(0, 2);
  if (shortlist.length === 0 && pool[0]) shortlist.push(pool[0].asin);

  // 4. Verify on product pages (with their size/color variants) and answer.
  const details: Awaited<ReturnType<typeof productWithVariants>>[] = [];
  for (const asin of shortlist) {
    details.push(await productWithVariants(asin));
    calls++;
  }
  const finalMsg = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium", format: zodOutputFormat(Final) },
    messages: [{
      role: "user",
      content: `Task: ${task.ques}\n\nProduct pages:\n${details.map((d) => JSON.stringify(d)).join("\n\n")}\n\n` +
        `Choose the one product that best satisfies the task (attributes, filters and sort preference), using only the data above. ` +
        `If the task names a size, color or other option, answer with the ASIN of the variant that matches it. ` +
        `Always choose a product: if none meets every requirement, choose the closest one and say what it misses. ` +
        `Write the response a shopper would get: the product, its price and rating, why it fits` +
        `${plan.also_report ? `, and ${plan.also_report}` : ""}.`,
    }],
  });
  tally(finalMsg);
  const final = finalMsg.parsed_output!;
  const known = (a: string) => details.some((d) => d?.asin === a || d?.variants.some((v: any) => v.asin === a));
  const asin = known(final.asin) ? final.asin : (details[0]?.asin ?? null);

  return {
    taskId: task.id,
    system: "ours",
    asin,
    url: asin ? `https://www.amazon.com/dp/${asin}` : null,
    response: final.response,
    inputTokens: input,
    outputTokens: output,
    latencyMs: Date.now() - t0,
    rainforestCalls: calls,
  };
}
