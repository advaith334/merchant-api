import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";
export const client = new Anthropic();

export interface Task {
  id: string;
  ques: string;
  attribute: string;
  filter: string;
  sort: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
}

/** What every system under test returns for one task. */
export interface Answer {
  taskId: string;
  system: string;
  asin: string | null;
  url: string | null;
  response: string; // final text answer, as the paper's "Result Response"
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  rainforestCalls: number;
  apiCalls?: number; // calls to the provider's search API (tool-agent systems)
  jevTokens?: number; // tokens sent to Jev (ours_jev), not counted in inputTokens/outputTokens
  page?: unknown; // the provider's own record of a non-Amazon pick, which the judge grades instead of an Amazon page
  error?: string;
}

export function loadTasks(path = new URL("./tasks.jsonl", import.meta.url)): Task[] {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

export function asinFromUrl(url: string | null | undefined): string | null {
  return url?.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/)([A-Z0-9]{10})/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Amazon data, from Rainforest (default) or ScraperAPI (AMAZON_DATA=scraperapi,
// converted to Rainforest's shape). One source per run: the pipeline and the
// judge must see the same data. Every response is cached on disk: free-plan
// credits are scarce and re-runs while tuning should cost nothing.

export const AMAZON_DATA = process.env.AMAZON_DATA === "scraperapi" ? "scraperapi" : "rainforest";
let liveCalls = 0;
export const amazonLiveCalls = () => liveCalls;
/** AMAZON_MAX_LIVE_CALLS caps uncached Amazon lookups per run, so an experiment can't spend a free tier's last credits. */
const MAX_LIVE_CALLS = Number(process.env.AMAZON_MAX_LIVE_CALLS ?? Infinity);
const spendLiveCall = () => {
  if (liveCalls >= MAX_LIVE_CALLS) throw new Error(`AMAZON_MAX_LIVE_CALLS (${MAX_LIVE_CALLS}) reached`);
  liveCalls++;
};

/** `{type: "search", search_term, sort_by}` or `{type: "product", asin}`, in Rainforest's response shape. */
export async function amazon(params: Record<string, string>): Promise<any> {
  if (params.type === "search" && AMAZON_SEARCH === "serpapi") return serpApiAmazonSearch(params);
  return AMAZON_DATA === "scraperapi" ? scraperApi(params) : rainforest(params);
}

/**
 * AMAZON_SEARCH=serpapi sends searches (not product pages) to SerpApi's Amazon engine, which takes the
 * same sort codes and filters. The judge only reads product pages, so it still sees AMAZON_DATA.
 */
export const AMAZON_SEARCH = process.env.AMAZON_SEARCH === "serpapi" ? "serpapi" : AMAZON_DATA;

// https://serpapi.com/amazon-search-api
async function serpApiAmazonSearch(params: Record<string, string>): Promise<any> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) throw new Error("SERPAPI_API_KEY is not set");
  const cache = cached("serpapi-amazon", params);
  let raw = cache.get();
  if (!raw) {
    const q = new URLSearchParams({ engine: "amazon", amazon_domain: "amazon.com", k: params.search_term, api_key: key });
    if (AMAZON_SORT[params.sort_by]) q.set("s", AMAZON_SORT[params.sort_by]);
    if (params.refinements) q.set("rh", params.refinements);
    spendLiveCall();
    const res = await fetch(`https://serpapi.com/search.json?${q}`, { signal: AbortSignal.timeout(120_000) });
    raw = await res.json();
    if (!res.ok || (raw.error && !/hasn't returned any results/i.test(raw.error))) throw new Error(`serpapi ${res.status}: ${String(raw.error).slice(0, 300)}`);
    cache.set(raw);
  }
  return {
    search_results: (raw.organic_results ?? []).filter((r: any) => r.asin).map((r: any) => ({
      asin: r.asin,
      title: r.title,
      price: { value: r.extracted_price ?? null },
      rating: r.rating ?? null,
      ratings_total: r.reviews ?? null,
      // No Prime flag; searches filtered on Prime (p_85) return only Prime items.
      is_prime: /(^|,)p_85:2470955011/.test(params.refinements ?? "") || null,
      sponsored: r.sponsored ?? false,
    })),
  };
}

function cached(source: string, params: Record<string, string>) {
  const id = createHash("sha256").update(JSON.stringify(Object.entries(params).sort())).digest("hex").slice(0, 24);
  const dir = new URL(`../.cache/${source}/`, import.meta.url);
  const file = new URL(`${id}.json`, dir);
  return {
    get: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined),
    set: (data: unknown) => { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify(data)); },
  };
}

async function rainforest(params: Record<string, string>): Promise<any> {
  const key = process.env.RAINFOREST_API_KEY;
  if (!key) throw new Error("RAINFOREST_API_KEY is not set");
  const q = { amazon_domain: "amazon.com", ...params };
  const cache = cached("rainforest", q);
  const hit = cache.get();
  if (hit) return hit;

  spendLiveCall();
  const res = await fetch(`https://api.rainforestapi.com/request?${new URLSearchParams({ api_key: key, ...q })}`, {
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json();
  if (!res.ok || data?.request_info?.success === false) {
    throw new Error(`rainforest ${res.status}: ${JSON.stringify(data?.request_info ?? data).slice(0, 300)}`);
  }
  cache.set(data);
  return data;
}

// ScraperAPI: https://docs.scraperapi.com/making-requests/structured-data-collection-method
// Search goes through a parsed Amazon search URL, the only way to get Amazon's sort orders.
const AMAZON_SORT: Record<string, string> = {
  bestseller_rankings: "exact-aware-popularity-rank",
  price_low_to_high: "price-asc-rank",
  price_high_to_low: "price-desc-rank",
  average_review: "review-rank",
  most_recent: "date-desc-rank",
};

async function scraperApi(params: Record<string, string>): Promise<any> {
  const key = process.env.SCRAPERAPI_API_KEY;
  if (!key) throw new Error("SCRAPERAPI_API_KEY is not set");
  const cache = cached("scraperapi", params);
  let raw = cache.get();
  if (!raw) {
    let url: string;
    if (params.type === "search") {
      const amazonUrl = new URL("https://www.amazon.com/s");
      amazonUrl.searchParams.set("k", params.search_term);
      const sort = AMAZON_SORT[params.sort_by];
      if (sort) amazonUrl.searchParams.set("s", sort);
      // Amazon's own search filters, e.g. "p_36:2500-5000" (price in cents) or "p_85:2470955011" (Prime).
      if (params.refinements) amazonUrl.searchParams.set("rh", params.refinements);
      url = `https://api.scraperapi.com/?${new URLSearchParams({ api_key: key, url: amazonUrl.href, autoparse: "true", country_code: "us" })}`;
    } else {
      url = `https://api.scraperapi.com/structured/amazon/product?${new URLSearchParams({ api_key: key, asin: params.asin, country_code: "us", tld: "com" })}`;
    }
    // Searches and product pages occasionally come back empty; one retry, then the
    // empty result is cached so every system (and the judge) sees the same thing.
    for (let attempt = 0; attempt < 2; attempt++) {
      spendLiveCall();
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`scraperapi ${res.status}: ${text.slice(0, 300)}`);
      raw = JSON.parse(text);
      if (params.type === "search" ? raw.results?.length : raw.name) break;
    }
    cache.set(raw);
  }
  return params.type === "search" ? fromScraperApiSearch(raw) : fromScraperApiProduct(raw, params.asin);
}

const money = (v: any) => (typeof v === "number" ? v : v ? Number(String(v).replace(/[^0-9.]/g, "")) || null : null);

function fromScraperApiSearch(raw: any) {
  return {
    search_results: (raw.results ?? []).filter((r: any) => r.asin).map((r: any) => ({
      asin: r.asin,
      title: r.name,
      price: { value: money(r.price ?? r.price_string) },
      rating: r.stars ?? null,
      ratings_total: r.total_reviews ?? null,
      is_prime: r.has_prime ?? null,
      sponsored: r.is_sponsored ?? r.sponsored ?? false,
      bestseller: r.is_best_seller ?? false,
    })),
  };
}

function fromScraperApiProduct(p: any, asin: string) {
  if (!p?.name) return { product: null };
  const info: Record<string, unknown> = p.product_information ?? {};
  // ScraperAPI gives the star distribution, not the average.
  const pct = [1, 2, 3, 4, 5].map((k) => Number(p[`${k}_star_percentage`] ?? 0));
  const total = pct.reduce((a, b) => a + b, 0);
  const rating = p.average_rating ?? (total ? Math.round((10 * pct.reduce((s, x, i) => s + x * (i + 1), 0)) / total) / 10 : null);
  const options = Object.entries(p.customization_options ?? {}).map(([dim, opts]) => [dim, Array.isArray(opts) ? opts : []] as const);
  const variants = options.flatMap(([dim, opts]) =>
    opts.filter((o: any) => o.asin).map((o: any) => ({ asin: o.asin, title: o.value, dimensions: [{ name: dim, value: o.value }] })),
  );
  // Rainforest puts the selected size/color in the title; ScraperAPI marks it in the options.
  const selected = options.flatMap(([dim, opts]) => opts.filter((o: any) => o.is_selected && o.value).map((o: any) => `${dim}: ${o.value}`));
  // Rank, dates and warranty first, so trimming the spec list never drops them.
  const KEY_INFO = ["best_sellers_rank", "date_first_available", "publication_date", "release_date", "warranty_description", "product_warranty"];
  const infoEntries = Object.entries(info).sort(([a], [b]) => Number(KEY_INFO.includes(b)) - Number(KEY_INFO.includes(a)));
  const shipsFrom = String(p.ships_from ?? "").split(/\s{2,}|\n/)[0].trim() || null;
  return {
    product: {
      asin,
      title: p.name,
      selected_options: selected.length ? selected.join(", ") : null,
      brand: p.brand ?? info.brand ?? info.Brand ?? info.manufacturer ?? null,
      buybox_winner: {
        price: { value: money(p.pricing) },
        rrp: { value: money(p.list_price) },
        is_prime: null,
        availability: { raw: p.availability_status ?? null },
        fulfillment: { standard_delivery: { text: [p.shipping_price, p.shipping_time].filter(Boolean).join(", ") || null } },
      },
      ships_from: shipsFrom,
      fulfilled_by_amazon: p.fulfilled_by_amazon ?? null,
      rating,
      ratings_total: p.total_reviews ?? null,
      categories: String(p.product_category ?? "").split("›").map((name) => ({ name: name.trim() })).filter((c) => c.name),
      first_available: (info.date_first_available ?? info["Date First Available"]) ? { raw: info.date_first_available ?? info["Date First Available"] } : null,
      feature_bullets: p.feature_bullets ?? [],
      specifications: infoEntries.map(([name, value]) => ({ name, value: typeof value === "string" ? value : JSON.stringify(value) })),
      description: String(p.full_description ?? "").replace(/\s+/g, " ").slice(0, 1000),
      sold_by: p.sold_by ?? null,
      top_reviews: (p.reviews ?? []).map((r: any) => ({ rating: r.stars ?? r.rating, title: r.title, body: r.review ?? r.body })),
      variants,
    },
  };
}

/** The fields of a product page a shopper (or judge) would look at. */
export function trimProduct(p: any) {
  if (!p) return null;
  const bb = p.buybox_winner ?? {};
  return {
    asin: p.asin,
    title: p.title,
    ...(p.selected_options ? { selected_options: p.selected_options } : {}),
    brand: p.brand,
    price: bb.price?.value ?? p.price?.value ?? null,
    list_price: bb.rrp?.value ?? null,
    is_prime: bb.is_prime ?? null,
    availability: bb.availability?.raw ?? null,
    shipping: bb.fulfillment?.standard_delivery?.text ?? null,
    returns: bb.fulfillment?.is_free_return ?? bb.is_free_return ?? null,
    condition: bb.condition?.is_new === false ? "used" : "new",
    rating: p.rating ?? null,
    ratings_total: p.ratings_total ?? null,
    categories: (p.categories ?? []).map((c: any) => c.name).join(" > "),
    first_available: p.first_available?.raw ?? null,
    feature_bullets: (p.feature_bullets ?? []).slice(0, 8),
    // ScraperAPI pages often have no bullets; the description carries the same facts.
    ...(p.feature_bullets?.length ? {} : { description: String(p.description ?? "").slice(0, 1000) || null }),
    ...(p.sold_by ? { sold_by: p.sold_by } : {}),
    ...(p.ships_from ? { ships_from: p.ships_from } : {}),
    ...(p.fulfilled_by_amazon != null ? { fulfilled_by_amazon: p.fulfilled_by_amazon } : {}),
    specifications: (p.specifications ?? []).slice(0, 25).map((s: any) => `${s.name}: ${s.value}`),
    top_reviews: (p.top_reviews ?? []).slice(0, 3).map((r: any) => ({
      rating: r.rating,
      title: r.title,
      helpful_votes: r.helpful_votes ?? null,
      body: String(r.body ?? "").slice(0, 400),
    })),
  };
}

export function trimSearchResult(r: any) {
  return {
    asin: r.asin,
    title: r.title,
    price: r.price?.value ?? r.prices?.[0]?.value ?? null,
    rating: r.rating ?? null,
    ratings_total: r.ratings_total ?? null,
    is_prime: r.is_prime ?? null,
    sponsored: r.sponsored ?? false,
  };
}

export async function getProduct(asin: string) {
  const data = await amazon({ type: "product", asin });
  return trimProduct(data.product);
}

// ---------------------------------------------------------------------------
// Product and search APIs that the comparison systems call (providers.ts).
// Cached on disk like Rainforest, unless a provider's terms forbid caching.

const API_CACHE_DIR = new URL("../.cache/", import.meta.url);
const liveCallsByApi: Record<string, number> = {};
export const apiLiveCalls = () => ({ ...liveCallsByApi });

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function postJson(api: string, url: string, headers: Record<string, string>, body: unknown, cache = true): Promise<any> {
  const id = createHash("sha256").update(url + JSON.stringify(body)).digest("hex").slice(0, 24);
  const dir = new URL(`${api}/`, API_CACHE_DIR);
  const file = new URL(`${id}.json`, dir);
  if (cache && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json();
  liveCallsByApi[api] = (liveCallsByApi[api] ?? 0) + 1;
  if (!res.ok) throw new Error(`${api} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  if (cache) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  }
  return data;
}

/** Cached GET, for APIs that take their key in the query string; the key is left out of the cache id. */
export async function getJson(api: string, url: string): Promise<any> {
  const id = createHash("sha256").update(url.replace(/([?&]api_key=)[^&]+/, "$1")).digest("hex").slice(0, 24);
  const dir = new URL(`${api}/`, API_CACHE_DIR);
  const file = new URL(`${id}.json`, dir);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  const data = await res.json();
  liveCallsByApi[api] = (liveCallsByApi[api] ?? 0) + 1;
  if (!res.ok) throw new Error(`${api} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return data;
}

/** Follows redirects to the merchant's own URL (buy links can be tracking redirects). */
export async function resolveUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    await res.body?.cancel();
    return res.url || url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------

export function appendJsonl(path: URL, row: unknown) {
  mkdirSync(new URL("./", path), { recursive: true });
  writeFileSync(path, JSON.stringify(row) + "\n", { flag: "a" });
}

export function readJsonl<T>(path: URL): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function usageOf(msg: Anthropic.Message | { usage: Anthropic.Usage }) {
  const u = msg.usage;
  return {
    input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    output: u.output_tokens,
  };
}
