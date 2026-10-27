// Our pipeline with Jev (TypeSafe's System One model) making the choices: Claude
// compiles the query, Jev checks every search result against each requirement,
// we verify more product pages than `ours` does (Jev makes each check cheap),
// Jev checks those pages and picks the variant. Claude writes the answer only
// when the task asks for information beyond the product.
// Same search and filters as ours.ts, so the difference is the choosing.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, amazon, client, postJson, requireEnv, trimSearchResult, usageOf, type Answer, type Task } from "./common.ts";
import { Plan, productWithVariants } from "./ours.ts";

const PAGES = 4; // product pages verified per task (ours.ts verifies 2)
const LIKELY = 0.5; // a candidate whose requirement checks multiply to at least this counts as a likely match

const JevPlan = Plan.extend({
  option: z.string().nullable().describe("the size, color or other option the task names, e.g. 'Size: 10, Color: Black'; null if none"),
});

type Questions = Record<string, { type: "noul"; instructions: string } | { type: "choice"; instructions: string; criteria: Record<string, string> }>;

/** One Jev call (https://docs.typesafe.ai/api/system-one), retried on rate limits and overload. */
async function jev(state: unknown, questions: Questions) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postJson(
        "typesafe",
        "https://api.typesafe.ai/v1/systemone",
        { Authorization: `Bearer ${requireEnv("TYPESAFE_API_KEY")}` },
        { model: "jev-latest", state, questions },
      );
    } catch (err) {
      if (attempt >= 5 || !/typesafe (429|5\d\d)|fetch failed|terminated|timeout/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

export async function runOursJev(task: Task): Promise<Answer> {
  const t0 = Date.now();
  let input = 0, output = 0, calls = 0, jevTokens = 0;
  const tally = (m: Parameters<typeof usageOf>[0]) => { const u = usageOf(m); input += u.input; output += u.output; };

  // 1. Compile the request (Claude: it has to write a search term).
  const planMsg = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(JevPlan) },
    messages: [{ role: "user", content: `Turn this Amazon shopping task into a structured search.\n\nTask: ${task.ques}` }],
  });
  tally(planMsg);
  const plan = planMsg.parsed_output!;

  /** P(right kind of product) times P(each required attribute), each a separate Jev question about one product. */
  const check = async (product: unknown) => {
    const questions: Questions = {
      type: { type: "noul", instructions: "The product is the kind of product the task asks for" },
      ...Object.fromEntries(plan.must_have.map((m, i) => [`must_${i}`, { type: "noul" as const, instructions: `The product has this required attribute: ${m}` }])),
    };
    const res = await jev({ task: task.ques, product }, questions);
    jevTokens += (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0);
    const p = Object.values(res.answers).map((a: any) => a.noul as number);
    return { type: p[0], score: p.reduce((s, x) => s * x, 1) };
  };

  const failures = (r: any) =>
    Number(plan.min_price != null && !(r.price != null && r.price >= plan.min_price)) +
    Number(plan.max_price != null && !(r.price != null && r.price <= plan.max_price)) +
    Number(plan.min_rating != null && !(r.rating != null && r.rating >= plan.min_rating)) +
    Number(plan.min_reviews != null && !(r.ratings_total != null && r.ratings_total >= plan.min_reviews)) +
    Number(plan.prime_only && !r.is_prime);
  /** Search results in the requested order (Amazon's own order for best sellers and newest). */
  const order = <T extends { r: any }>(xs: T[]) => {
    const pool = [...xs];
    if (plan.sort_by === "price_low_to_high") pool.sort((a, b) => (a.r.price ?? 1e9) - (b.r.price ?? 1e9));
    if (plan.sort_by === "price_high_to_low") pool.sort((a, b) => (b.r.price ?? -1) - (a.r.price ?? -1));
    if (plan.sort_by === "average_review") pool.sort((a, b) => (b.r.rating ?? 0) - (a.r.rating ?? 0) || (b.r.ratings_total ?? 0) - (a.r.ratings_total ?? 0));
    return pool;
  };
  /**
   * With a sort: the earliest likely match in sort order wins. Without one: the likeliest match.
   * Either way, products that pass every filter come first.
   */
  const pick = <T extends { r: any; score: number }>(xs: T[]) =>
    [...xs].sort((a, b) =>
      failures(a.r) - failures(b.r) ||
      (plan.sort_by === "featured" ? b.score - a.score : Number(b.score >= LIKELY) - Number(a.score >= LIKELY)),
    );

  // 2. Search, as in ours.ts.
  const seen = new Set<string>();
  const all: any[] = [];
  const search = async (search_term: string, sort_by: string) => {
    const data = await amazon({ type: "search", search_term, sort_by });
    calls++;
    for (const r of (data.search_results ?? []).map(trimSearchResult)) {
      if (r.asin && !seen.has(r.asin)) { seen.add(r.asin); all.push(r); }
    }
  };
  for (const sort_by of plan.sort_by === "featured" ? ["featured"] : [plan.sort_by, "featured"]) await search(plan.search_term, sort_by);

  // 3. Jev checks every search result (titles, prices, ratings), not just a short list.
  let checked = order(await Promise.all(all.map(async (r) => ({ r, ...(await check(r)) }))));
  if (!checked.some((c) => c.type >= LIKELY)) {
    // Nothing is even the right kind of product: Claude writes a better search term.
    const retry = await client.messages.parse({
      model: MODEL,
      max_tokens: 1000,
      output_config: { effort: "low", format: zodOutputFormat(z.object({ search_term: z.string() })) },
      messages: [{
        role: "user",
        content: `Task: ${task.ques}\nThe Amazon search "${plan.search_term}" returned none of the right kind of product:\n` +
          `${all.slice(0, 10).map((r) => r.title).join("\n")}\n\nWrite a better Amazon search term.`,
      }],
    });
    tally(retry);
    const before = all.length;
    await search(retry.parsed_output!.search_term, "featured");
    const added = await Promise.all(all.slice(before).map(async (r) => ({ r, ...(await check(r)) })));
    checked = order([...checked, ...added]);
  }
  const shortlist = pick(checked).slice(0, PAGES).map((c) => c.r.asin as string);

  // 4. Verify on product pages: Jev checks attributes, our code checks filters on the page's own numbers.
  // One page at a time: ScraperAPI's free plan limits simultaneous requests.
  const pages = [];
  for (const asin of shortlist) {
    const page = await productWithVariants(asin);
    calls++;
    const { variants, ...product } = page;
    pages.push({ r: page, ...(await check(product)) });
  }
  const chosen = pick(pages.filter((p) => p.r?.asin))[0]?.r ?? null;

  // 5. The variant matching the option the task names.
  let asin: string | null = chosen?.asin ?? null;
  if (chosen && plan.option && chosen.variants.length > 1) {
    const res = await jev({ task: task.ques, product: chosen.title }, {
      variant: {
        type: "choice",
        instructions: `Which variant matches: ${plan.option}`,
        criteria: Object.fromEntries(chosen.variants.map((v: any) => [v.asin, v.options])),
      },
    });
    jevTokens += (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0);
    asin = res.answers.variant.choice ?? asin;
  }

  // 6. The answer. Claude only when the task asks for more than the product.
  let response = chosen
    ? `${chosen.title}. $${chosen.price ?? "?"}, rated ${chosen.rating ?? "?"} from ${chosen.ratings_total ?? "?"} ratings` +
      `${plan.option ? `, ${plan.option}` : ""}. Matches: ${plan.must_have.join("; ") || "the request"}.` +
      `${plan.sort_by !== "featured" ? ` Chosen as the first match in ${plan.sort_by.replace(/_/g, " ")} order.` : ""}`
    : "No matching product found.";
  if (chosen && plan.also_report) {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: "low" },
      messages: [{
        role: "user",
        content: `Task: ${task.ques}\n\nProduct page:\n${JSON.stringify({ ...chosen, variants: undefined })}\n\n` +
          `In a few sentences, using only this data, give the shopper: ${plan.also_report}.`,
      }],
    });
    tally(msg);
    response += " " + msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  return {
    taskId: task.id,
    system: "ours_jev",
    asin,
    url: asin ? `https://www.amazon.com/dp/${asin}` : null,
    response,
    inputTokens: input,
    outputTokens: output,
    jevTokens,
    latencyMs: Date.now() - t0,
    rainforestCalls: calls,
  };
}
