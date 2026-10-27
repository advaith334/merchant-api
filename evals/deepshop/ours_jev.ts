// Our pipeline with Jev (TypeSafe's System One model) making the choices: Claude
// compiles the query, Jev checks every search result against each requirement,
// we verify more product pages than `ours` does (Jev makes each check cheap),
// Jev checks those pages and picks the variant. Claude writes the answer only
// when the task asks for information beyond the product.
// Same search and filters as ours.ts, so the difference is the choosing.
//
// ours_v2 adds, from the judge's reasons on tasks outside the published sample:
// Amazon's own price and Prime filters in the search, so sorted results are already
// filtered; a release-date window, checked on product pages; and Prime read from
// "ships from Amazon" on product pages.
//
// ours_v3 adds: a brand, model or author the task names is a hard requirement (search
// again when no result matches it), and the answer states only what was verified.
//
// ours_v4 stops fetching product pages at the first one that passes every check, instead of always
// fetching PAGES; the shortlist is already in pick order, so later pages could only tie it.
//
// ours_v5 keeps v3's search and Jev screening of every result, but Claude makes the final choice
// among the top V5_PAGES product pages (with Jev's checks alongside), picks the variant and writes
// the answer, as ours.ts does.
//
// ours_v6 adds the full product page's key sections (returns, sizes, ships-from, rank) to each
// shortlisted page, for Jev's checks and Claude's choice.
//
// ours_v7 fixes three misses on tasks outside the published sample: with a sort, Claude takes the
// first candidate in that order that meets the task's stated requirements rather than trading it for
// details the task doesn't ask for; a task asking for two products gets the second one searched,
// checked and reported too; and the answer covers only requirements the task states.
//
// ours_v8 is ours_v6 with fewer tokens: the final choice gets each structured field (bullets,
// specifications, description) only when the full page doesn't already carry that section.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MODEL, amazon, amazonPageText, client, postJson, requireEnv, trimSearchResult, usageOf, type Answer, type Task } from "./common.ts";
import { Plan, productWithVariants } from "./ours.ts";

const PAGES = 4; // product pages verified per task (ours.ts verifies 2)
const V5_PAGES = 3;
const FinalV5 = z.object({
  asin: z.string().describe("the chosen product, or the ASIN of its variant that matches the size/color/option the task names"),
  response: z.string(),
});
const LIKELY = 0.5; // a candidate whose requirement checks multiply to at least this counts as a likely match

const JevPlan = Plan.extend({
  option: z.string().nullable().describe("the size, color or other option the task names, e.g. 'Size: 10, Color: Black'; null if none"),
});
const PlanV2 = JevPlan.extend({
  released_within_days: z.number().nullable().describe("when the task asks for products launched, released or published in the last N days (or 'new releases'); null otherwise"),
});
const PlanV3 = PlanV2.extend({
  must_match: z.array(z.string()).describe("the brand, model, author, publisher or series the product must be, e.g. 'brand: Nike', 'model: Sony WF-1000XM4', 'author: Sam Harris'; empty if the task names none"),
});
const PlanV7 = PlanV3.extend({
  second_product: z.string().nullable().describe("when the task asks for two different products (e.g. sneakers and a backpack): an Amazon search term for the second one; null otherwise"),
});
const PRIME = "p_85:2470955011";
const VERIFIED = 0.7; // a Jev check at least this sure counts as verified in the answer

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

/** Released within the last `days` days, by the page's first-available or publication date. */
function releasedWithin(page: any, days: number) {
  const dated = [page.first_available, ...(page.specifications ?? []).filter((x: string) => /^(publication_date|release_date|date_first_available):/.test(x))];
  const ms = dated.map((d: string | null) => Date.parse(String(d ?? "").replace(/^[a-z_]+:\s*/, ""))).filter((t: number) => !Number.isNaN(t));
  return ms.some((t: number) => Date.now() - t <= days * 86_400_000);
}

export const runOursJev = oursJev("ours_jev", 1);
export const runOursV2 = oursJev("ours_v2", 2);
export const runOursV3 = oursJev("ours_v3", 3);
export const runOursV4 = oursJev("ours_v4", 4);
export const runOursV5 = oursJev("ours_v5", 5);
export const runOursV6 = oursJev("ours_v6", 6);
export const runOursV7 = oursJev("ours_v7", 7);
export const runOursV8 = oursJev("ours_v8", 8);

/** ours_v8: a page without the structured fields its full-page text already covers. */
function lean(page: any) {
  const fp: string = page.full_page ?? "";
  const { feature_bullets, specifications, description, ...rest } = page;
  return {
    ...rest,
    ...(fp.includes("[feature-bullets]") ? {} : { feature_bullets }),
    ...(/\[(productDetails_|detailBullets_feature_div)/.test(fp) ? {} : { specifications }),
    ...(fp.includes("[bookDescription_feature_div]") ? {} : { description }),
  };
}

function oursJev(system: string, version: number) {
  const v2 = version >= 2, v3 = version >= 3, v4 = version === 4, v5 = version >= 5, v6 = version >= 6, v7 = version === 7, v8 = version === 8;
  return async function run(task: Task): Promise<Answer> {
    const t0 = Date.now();
    let input = 0, output = 0, calls = 0, jevTokens = 0;
    const tally = (m: Parameters<typeof usageOf>[0]) => { const u = usageOf(m); input += u.input; output += u.output; };

    // 1. Compile the request (Claude: it has to write a search term).
    const planMsg = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: "low", format: zodOutputFormat(v7 ? PlanV7 : v3 ? PlanV3 : v2 ? PlanV2 : JevPlan) },
      messages: [{ role: "user", content: `Turn this Amazon shopping task into a structured search.\n\nTask: ${task.ques}` }],
    });
    tally(planMsg);
    const plan: z.infer<typeof PlanV7> = { released_within_days: null, must_match: [], second_product: null, ...planMsg.parsed_output! };

    /**
     * Separate Jev questions about one product: the right kind of product, each required attribute,
     * and (ours_v3) each named brand/model/author. score: P(kind) times P(each attribute); identity: P(each name).
     */
    const check = async (product: unknown) => {
      const questions: Questions = {
        type: { type: "noul", instructions: "The product is the kind of product the task asks for" },
        ...Object.fromEntries(plan.must_have.map((m, i) => [`must_${i}`, { type: "noul" as const, instructions: `The product has this required attribute: ${m}` }])),
        ...Object.fromEntries(plan.must_match.map((m, i) => [`id_${i}`, { type: "noul" as const, instructions: `The product is exactly this (not a similar or related one): ${m}` }])),
      };
      const res = await jev({ task: task.ques, product }, questions);
      jevTokens += (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0);
      const p = (key: string) => res.answers[key].noul as number;
      const attributes = plan.must_have.map((m, i) => [m, p(`must_${i}`)] as const);
      const names = plan.must_match.map((m, i) => [m, p(`id_${i}`)] as const);
      return {
        type: p("type"),
        score: attributes.reduce((s, [, x]) => s * x, p("type")),
        identity: names.reduce((s, [, x]) => s * x, 1),
        checks: [...names, ...attributes],
      };
    };

    const failures = (r: any) =>
      Number(plan.min_price != null && !(r.price != null && r.price >= plan.min_price)) +
      Number(plan.max_price != null && !(r.price != null && r.price <= plan.max_price)) +
      Number(plan.min_rating != null && !(r.rating != null && r.rating >= plan.min_rating)) +
      Number(plan.min_reviews != null && !(r.ratings_total != null && r.ratings_total >= plan.min_reviews)) +
      Number(plan.prime_only && !(r.is_prime || (v2 && (r.fulfilled_by_amazon || /amazon/i.test(r.ships_from ?? ""))))) +
      Number(v2 && plan.released_within_days != null && r.specifications != null && !releasedWithin(r, plan.released_within_days));
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
    const pick = <T extends { r: any; score: number; identity: number }>(xs: T[]) =>
      [...xs].sort((a, b) =>
        // ours_v3: the named brand/model/author before everything else.
        (v3 ? Number(b.identity >= LIKELY) - Number(a.identity >= LIKELY) : 0) ||
        failures(a.r) - failures(b.r) ||
        (plan.sort_by === "featured" ? b.score - a.score : Number(b.score >= LIKELY) - Number(a.score >= LIKELY)),
      );

    // 2. Search, as in ours.ts.
    const seen = new Set<string>();
    const all: any[] = [];
    const refinements = [
      plan.min_price != null || plan.max_price != null ? `p_36:${Math.round((plan.min_price ?? 0) * 100)}-${plan.max_price != null ? Math.round(plan.max_price * 100) : ""}` : null,
      plan.prime_only ? PRIME : null,
    ].filter(Boolean).join(",");
    const search = async (search_term: string, sort_by: string, refine = v2) => {
      const data = await amazon({ type: "search", search_term, sort_by, ...(refine && refinements ? { refinements } : {}) });
      calls++;
      for (const r of (data.search_results ?? []).map(trimSearchResult)) {
        if (r.asin && !seen.has(r.asin)) { seen.add(r.asin); all.push(r); }
      }
    };
    // ours_v2: newest first when the task asks for recent releases.
    const sort = v2 && plan.sort_by === "featured" && plan.released_within_days != null ? "most_recent" : plan.sort_by;
    for (const sort_by of sort === "featured" ? ["featured"] : [sort, "featured"]) await search(plan.search_term, sort_by);
    // Amazon's filters can leave too little to choose from: fall back to the plain search.
    if (v2 && refinements && all.length < 5) await search(plan.search_term, "featured", false);

    // 3. Jev checks every search result (titles, prices, ratings), not just a short list.
    let checked = order(await Promise.all(all.map(async (r) => ({ r, ...(await check(r)) }))));
    if (!checked.some((c) => c.type >= LIKELY && (!v3 || c.identity >= LIKELY))) {
      // Nothing is even the right kind of product (or, for ours_v3, the named one): Claude writes a better search term.
      const retry = await client.messages.parse({
        model: MODEL,
        max_tokens: 1000,
        output_config: { effort: "low", format: zodOutputFormat(z.object({ search_term: z.string() })) },
        messages: [{
          role: "user",
          content: `Task: ${task.ques}\nThe Amazon search "${plan.search_term}" returned none of the right ` +
            `${v3 && plan.must_match.length ? `product (it must be: ${plan.must_match.join("; ")})` : "kind of product"}:\n` +
            `${all.slice(0, 10).map((r) => r.title).join("\n")}\n\nWrite a better Amazon search term.`,
        }],
      });
      tally(retry);
      const before = all.length;
      await search(retry.parsed_output!.search_term, "featured");
      const added = await Promise.all(all.slice(before).map(async (r) => ({ r, ...(await check(r)) })));
      checked = order([...checked, ...added]);
    }
    const shortlist = pick(checked).slice(0, v5 ? V5_PAGES : PAGES).map((c) => c.r.asin as string);

    // 4. Verify on product pages: Jev checks attributes, our code checks filters on the page's own numbers.
    // One page at a time: ScraperAPI's free plan limits simultaneous requests.
    const pages = [];
    for (const asin of shortlist) {
      const page: any = await productWithVariants(asin);
      calls++;
      if (v6 && page.asin) {
        page.full_page = await amazonPageText(asin).catch(() => null);
        calls++;
      }
      const { variants, ...product } = page;
      const checked = { r: page, ...(await check(product)) };
      pages.push(checked);
      if (v4 && page.asin && failures(page) === 0 && checked.type >= VERIFIED && checked.checks.every(([, p]) => p >= VERIFIED)) break;
    }
    const ranked = pick(pages.filter((p) => p.r?.asin));
    const best = ranked[0];
    let chosen = best?.r ?? null;
    let asin: string | null = chosen?.asin ?? null;
    let response: string | null = null;

    // ours_v7: the second product a two-product task asks for, from its own search (likeliest Jev match).
    let second: any = null;
    if (v7 && plan.second_product) {
      const data = await amazon({ type: "search", search_term: plan.second_product, sort_by: "featured" });
      calls++;
      const results = (data.search_results ?? []).map(trimSearchResult).filter((r: any) => r.asin).slice(0, 10);
      const scored = await Promise.all(results.map(async (r: any) => {
        const res = await jev({ task: task.ques, product: r }, {
          fit: { type: "noul", instructions: `The product is the "${plan.second_product}" the task asks for and meets the task's requirements for it` },
        });
        jevTokens += (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0);
        return { r, p: res.answers.fit.noul as number };
      }));
      const top = scored.sort((a, b) => b.p - a.p)[0];
      if (top) {
        second = await productWithVariants(top.r.asin);
        calls++;
        second.full_page = await amazonPageText(top.r.asin).catch(() => null);
        calls++;
      }
    }

    // ours_v5: Claude chooses among the verified pages, with Jev's checks alongside, and writes the answer.
    if (v5 && chosen) {
      const finalMsg = await client.messages.parse({
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: "medium", format: zodOutputFormat(FinalV5) },
        messages: [{
          role: "user",
          content: `Task: ${task.ques}\n\nCandidate product pages, best first by our checks:\n` +
            ranked.map((p) => `${JSON.stringify(v8 ? lean(p.r) : p.r)}\nAutomated checks: ${verifiedAnswer(p.r, p.checks, p.r.asin).replace(/^.*?ratings\.\s*/, "")}`).join("\n\n") +
            (v7 ? (second ? `\n\nThe task's second product, best match from its own search:\n${JSON.stringify(second)}` : "") +
              `\n\nChoose the one product that best satisfies the task, using only the data above. ` +
              (plan.sort_by !== "featured"
                ? `The task orders products (${plan.sort_by.replace(/_/g, " ")}): the candidates are in that order, so take the first one that meets the requirements the task states, and don't pass it over for anything the task doesn't ask for. `
                : "") +
              `If the task names a size, color or other option, answer with the ASIN of the variant that matches it. ` +
              `Write the response a shopper would get: the product${second ? " (and the second product, with its price, rating and url)" : ""}, its price and rating, and how it meets each requirement the task states` +
              `${plan.also_report ? `, and ${plan.also_report}` : ""}. State only what the data shows. Say a requirement is unconfirmed only if the task states it; add no requirements of your own.`
            : `\n\nChoose the one product that best satisfies the task (attributes, filters and sort preference), using only the data above. ` +
              `If the task names a size, color or other option, answer with the ASIN of the variant that matches it. ` +
              `Write the response a shopper would get: the product, its price and rating, and why it fits` +
              `${plan.also_report ? `, and ${plan.also_report}` : ""}. State only what the data shows; name any requirement it doesn't confirm.`),
        }],
      });
      tally(finalMsg);
      const final = finalMsg.parsed_output!;
      const owner = ranked.find((p) => p.r.asin === final.asin || p.r.variants.some((v: any) => v.asin === final.asin));
      if (owner) { chosen = owner.r; asin = final.asin; }
      response = final.response;
    }

    // 5. The variant matching the option the task names.
    if (!v5 && chosen && plan.option && chosen.variants.length > 1) {
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

    /** ours_v3: the answer states what the product page verifies and names what it doesn't. */
    function verifiedAnswer(page: any, checks: (readonly [string, number])[], selected: string | null) {
      const verified: string[] = [], unconfirmed: string[] = [];
      const note = (ok: boolean, text: string) => (ok ? verified : unconfirmed).push(text);
      if (plan.min_price != null || plan.max_price != null) {
        note(page.price != null && page.price >= (plan.min_price ?? 0) && page.price <= (plan.max_price ?? Infinity), `price $${page.price ?? "?"} (asked: ${plan.min_price ?? 0}–${plan.max_price ?? "any"})`);
      }
      if (plan.min_rating != null) note(page.rating != null && page.rating >= plan.min_rating, `rating ${page.rating ?? "?"} (asked: ${plan.min_rating}+)`);
      if (plan.min_reviews != null) note(page.ratings_total != null && page.ratings_total >= plan.min_reviews, `${page.ratings_total ?? "?"} ratings (asked: ${plan.min_reviews}+)`);
      if (plan.prime_only) note(!!(page.is_prime || page.fulfilled_by_amazon || /amazon/i.test(page.ships_from ?? "")), "Prime (ships from Amazon)");
      if (plan.released_within_days != null) note(releasedWithin(page, plan.released_within_days), `released in the last ${plan.released_within_days} days`);
      for (const [label, p] of checks) note(p >= VERIFIED, label);
      const variant = page.variants?.find((v: any) => v.asin === selected && selected !== page.asin)?.options;
      return `${page.title} (ASIN ${selected ?? page.asin}). $${page.price ?? "?"}, rated ${page.rating ?? "?"} from ${page.ratings_total ?? "?"} ratings.` +
        `${variant ? ` Selected variant: ${variant}.` : ""}` +
        `${verified.length ? ` Verified on the product page: ${verified.join("; ")}.` : ""}` +
        `${unconfirmed.length ? ` Not confirmed by the product page: ${unconfirmed.join("; ")}.` : ""}` +
        `${plan.sort_by !== "featured" ? ` Chosen as the first match in Amazon's ${plan.sort_by.replace(/_/g, " ")} order among the ${all.length} results checked.` : ""}`;
    }

    // 6. The answer. Claude only when the task asks for more than the product.
    response ??= chosen && v3
      ? verifiedAnswer(chosen, best.checks, asin)
      : chosen
      ? `${chosen.title}. $${chosen.price ?? "?"}, rated ${chosen.rating ?? "?"} from ${chosen.ratings_total ?? "?"} ratings` +
        `${plan.option ? `, ${plan.option}` : ""}. Matches: ${plan.must_have.join("; ") || "the request"}.` +
        `${plan.sort_by !== "featured" ? ` Chosen as the first match in ${plan.sort_by.replace(/_/g, " ")} order.` : ""}`
      : "No matching product found.";
    if (!v5 && chosen && plan.also_report) {
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        output_config: { effort: "low" },
        messages: [{
          role: "user",
          content: `Task: ${task.ques}\n\nProduct page:\n${JSON.stringify({ ...chosen, variants: undefined })}\n\n` +
            `In a few sentences, using only this data, give the shopper: ${plan.also_report}.` +
            (v3 ? " Answer only that; don't restate or judge the task's other requirements." : ""),
        }],
      });
      tally(msg);
      response += " " + msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    }

    return {
      taskId: task.id,
      system,
      asin,
      url: asin ? `https://www.amazon.com/dp/${asin}` : null,
      response,
      inputTokens: input,
      outputTokens: output,
      jevTokens,
      latencyMs: Date.now() - t0,
      rainforestCalls: calls,
    };
  };
}
