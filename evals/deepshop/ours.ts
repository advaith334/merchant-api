// Our pipeline: compile the query into a structured product search, run one
// filtered Amazon search, verify a short list on product pages, answer.
// No browsing, no screenshots: the agent only ever sees structured product data.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, client, getProduct, rainforest, trimSearchResult, usageOf, type Answer, type Task } from "./common.ts";

const SORTS = ["featured", "price_low_to_high", "price_high_to_low", "average_review", "most_recent"] as const;

const Plan = z.object({
  search_term: z.string().describe("Amazon search box text: product type plus the 1-3 most discriminating attributes"),
  sort_by: z.enum(SORTS),
  min_price: z.number().nullable(),
  max_price: z.number().nullable(),
  min_rating: z.number().nullable(),
  min_reviews: z.number().nullable(),
  prime_only: z.boolean(),
  must_have: z.array(z.string()).describe("attributes that must be verified on the product page"),
  also_report: z.string().nullable().describe("extra information the task asks for, e.g. the most helpful review"),
});

const Shortlist = z.object({ asins: z.array(z.string()).describe("best candidates first, at most 3") });
const Final = z.object({ asin: z.string().nullable(), response: z.string() });

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

  // 2. One search, then apply the numeric filters ourselves.
  const search = await rainforest({ type: "search", search_term: plan.search_term, sort_by: plan.sort_by });
  calls++;
  const all = (search.search_results ?? []).map(trimSearchResult).filter((r: any) => r.asin);
  const passes = (r: any) =>
    (plan.min_price == null || (r.price != null && r.price >= plan.min_price)) &&
    (plan.max_price == null || (r.price != null && r.price <= plan.max_price)) &&
    (plan.min_rating == null || (r.rating != null && r.rating >= plan.min_rating)) &&
    (plan.min_reviews == null || (r.ratings_total != null && r.ratings_total >= plan.min_reviews)) &&
    (!plan.prime_only || r.is_prime);
  let pool = all.filter(passes);
  if (pool.length === 0) pool = all;
  if (plan.sort_by === "price_low_to_high") pool.sort((a: any, b: any) => (a.price ?? 1e9) - (b.price ?? 1e9));
  if (plan.sort_by === "price_high_to_low") pool.sort((a: any, b: any) => (b.price ?? -1) - (a.price ?? -1));
  if (plan.sort_by === "average_review") pool.sort((a: any, b: any) => (b.rating ?? 0) - (a.rating ?? 0) || (b.ratings_total ?? 0) - (a.ratings_total ?? 0));
  pool = pool.slice(0, 15);

  // 3. Shortlist from titles.
  const shortMsg = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Shortlist) },
    messages: [{
      role: "user",
      content: `Task: ${task.ques}\nRequired attributes: ${plan.must_have.join("; ") || "none"}\n` +
        `Sort preference: ${plan.sort_by}. The list below is already filtered and in sort order; prefer earlier items when they fit.\n\n` +
        `Candidates:\n${pool.map((r: any) => JSON.stringify(r)).join("\n")}\n\nPick up to 3 ASINs most likely to satisfy every requirement.`,
    }],
  });
  tally(shortMsg);
  const shortlist = shortMsg.parsed_output!.asins.filter((a) => pool.some((r: any) => r.asin === a)).slice(0, 2);
  if (shortlist.length === 0 && pool[0]) shortlist.push(pool[0].asin);

  // 4. Verify on product pages and answer.
  const details = [];
  for (const asin of shortlist) {
    details.push(await getProduct(asin));
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
        `Write the response a shopper would get: the product, its price and rating, why it fits` +
        `${plan.also_report ? `, and ${plan.also_report}` : ""}. Set asin to null only if none of them can work.`,
    }],
  });
  tally(finalMsg);
  const final = finalMsg.parsed_output!;
  const asin = final.asin && details.some((d) => d?.asin === final.asin) ? final.asin : null;

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
