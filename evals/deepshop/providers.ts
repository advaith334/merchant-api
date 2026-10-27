// Adjacent products, each wrapped as the single tool of a Claude agent (tool_agent.ts).
//
// Product catalogs (what an agent would use instead of us), any retailer:
//   channel3         Channel3 search. Its search returns no Amazon offers (checked 2026-10-27:
//                    amazon.com is a known website, but filtering on it, by domain or id, returns
//                    nothing), so it can't be restricted to Amazon like the rest.
//   shopify_catalog  Shopify's Global Catalog over UCP (keyless; Shopify merchants only, so no Amazon)
//   google_shopping  Google Shopping via SerpApi
// Web search APIs, restricted to amazon.com pages:
//   exa, linkup, parallel, tavily
//
// Not here: Rye. Its API checks out a product URL you already chose; it has no search,
// so it can't be compared on choosing the product.

import type Anthropic from "@anthropic-ai/sdk";
import { getJson, postJson, requireEnv } from "./common.ts";
import type { Provider } from "./tool_agent.ts";

const productTool = (description: string): Anthropic.Tool => ({
  name: "search_products",
  description,
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for, in natural language" },
      min_price: { type: "number", description: "Lowest price in USD" },
      max_price: { type: "number", description: "Highest price in USD" },
    },
    required: ["query"],
  },
});

const webTool = (description: string): Anthropic.Tool => ({
  name: "search_web",
  description,
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
});

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const EXCERPT_CHARS = 1500;

// ---------------------------------------------------------------------------
// Channel3: https://channel3.ai/docs/api-reference/v1/search

function trimChannel3Product(p: any) {
  return {
    title: p.title,
    brand: (p.brands ?? []).map((b: any) => b.name).join(", ") || null,
    category: (p.category?.path ?? []).map((c: any) => c.title).join(" > ") || p.category?.title || null,
    rating: p.ratings?.value ?? null,
    ratings_total: p.ratings?.count ?? null,
    key_features: (p.key_features ?? []).slice(0, 8),
    attributes: p.structured_attributes ?? {},
    materials: p.materials ?? [],
    description: String(p.description ?? "").slice(0, 600),
    offers: (p.offers ?? []).slice(0, 5).map((o: any) => ({
      url: o.url,
      domain: o.domain,
      price: o.price?.price ?? null,
      availability: o.availability ?? null,
      condition: o.condition ?? null,
    })),
  };
}

const channel3: Provider = {
  system: "channel3",
  env: ["CHANNEL3_API_KEY"],
  anyRetailer: true,
  tool: productTool(
    "Search Channel3's catalog of products across retailers. Returns up to 20 products with rating, " +
      "review count, key features, attributes and offers (retailer, price, availability, url).",
  ),
  async search({ query, min_price, max_price }) {
    const filters: Record<string, unknown> = {};
    if (min_price != null || max_price != null) filters.price = { min_price: min_price ?? null, max_price: max_price ?? null };
    const data = await postJson(
      "channel3",
      "https://api.trychannel3.com/v1/search",
      { "x-api-key": requireEnv("CHANNEL3_API_KEY") },
      { query, limit: 20, filters },
    );
    const results = (data.products ?? []).map(trimChannel3Product);
    const pages: Record<string, unknown> = {};
    for (const p of results) for (const o of p.offers) pages[o.url] = p;
    return { results, pages };
  },
};

// ---------------------------------------------------------------------------
// Shopify Global Catalog: https://shopify.dev/docs/agents/catalog/global-catalog
// Keyless. Shopify's terms forbid caching catalog results, so every call is live.

const SHOPIFY_PROFILE =
  process.env.SHOPIFY_AGENT_PROFILE ?? "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json";

function trimShopifyProduct(p: any) {
  const v = p.variants?.[0] ?? {};
  const usd = (m: any) => (m?.amount != null ? m.amount / 100 : null);
  return {
    title: p.title,
    url: v.url ?? p.url ?? null,
    shop: v.seller?.name ?? null,
    price: usd(v.price) ?? usd(p.price_range?.min),
    price_range: [usd(p.price_range?.min), usd(p.price_range?.max)],
    rating: p.rating?.value ?? null,
    ratings_total: p.rating?.count ?? null,
    availability: v.availability ?? null,
    options: v.options ?? null,
    description: stripHtml(String(p.description?.plain ?? p.description?.html ?? "")).slice(0, 600),
  };
}

const shopifyCatalog: Provider = {
  system: "shopify_catalog",
  env: [],
  anyRetailer: true,
  tool: productTool(
    "Search Shopify's global catalog of products sold by Shopify merchants. Returns up to 20 products " +
      "with price, rating, review count, shop, availability and url.",
  ),
  async search({ query, min_price, max_price }) {
    const price: Record<string, number> = {};
    if (min_price != null) price.min = Math.round(min_price * 100);
    if (max_price != null) price.max = Math.round(max_price * 100);
    const catalog = {
      query,
      context: { address_country: "US" },
      filters: Object.keys(price).length ? { price } : {},
      pagination: { limit: 20 },
    };
    const data = await postJson(
      "shopify",
      "https://catalog.shopify.com/api/ucp/mcp",
      { Accept: "application/json" },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_catalog", arguments: { meta: { "ucp-agent": { profile: SHOPIFY_PROFILE } }, catalog } },
      },
      false,
    );
    if (data.error || data.result?.isError) throw new Error(`shopify: ${JSON.stringify(data.error ?? data.result).slice(0, 300)}`);
    const results = (data.result?.structuredContent?.products ?? []).map(trimShopifyProduct);
    const pages: Record<string, unknown> = {};
    for (const p of results) if (p.url) pages[p.url] = p;
    return { results, pages };
  },
};

// ---------------------------------------------------------------------------
// Web search APIs, restricted to amazon.com so picks are judged on Amazon pages
// like every other Amazon system.

const exa: Provider = {
  system: "exa",
  env: ["EXA_API_KEY"],
  anyRetailer: false,
  tool: webTool("Search amazon.com pages with Exa. Returns up to 10 pages with title, url and page text."),
  async search({ query }) {
    // https://exa.ai/docs/reference/search
    const data = await postJson(
      "exa",
      "https://api.exa.ai/search",
      { "x-api-key": requireEnv("EXA_API_KEY") },
      { query, numResults: 10, includeDomains: ["amazon.com"], type: "auto", contents: { text: { maxCharacters: EXCERPT_CHARS } } },
    );
    return { results: (data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, text: r.text })) };
  },
};

const linkup: Provider = {
  system: "linkup",
  env: ["LINKUP_API_KEY"],
  anyRetailer: false,
  tool: webTool("Search amazon.com pages with Linkup. Returns up to 10 pages with title, url and page text."),
  async search({ query }) {
    // https://docs.linkup.so/pages/documentation/api-reference/endpoint/post-search
    const data = await postJson(
      "linkup",
      "https://api.linkup.so/v1/search",
      { Authorization: `Bearer ${requireEnv("LINKUP_API_KEY")}` },
      { q: query, depth: "standard", outputType: "searchResults", includeDomains: ["amazon.com"], maxResults: 10 },
    );
    const results = (data.results ?? []).filter((r: any) => r.type !== "image");
    return { results: results.map((r: any) => ({ title: r.name, url: r.url, text: String(r.content ?? "").slice(0, EXCERPT_CHARS) })) };
  },
};

const parallel: Provider = {
  system: "parallel",
  env: ["PARALLEL_API_KEY"],
  anyRetailer: false,
  tool: webTool("Search amazon.com pages with Parallel. Returns up to 10 pages with title, url and excerpts."),
  async search({ query }) {
    // https://docs.parallel.ai/api-reference/search-api/search
    const data = await postJson(
      "parallel",
      "https://api.parallel.ai/v1/search",
      { "x-api-key": requireEnv("PARALLEL_API_KEY") },
      {
        objective: query,
        search_queries: [query],
        advanced_settings: {
          max_results: 10,
          source_policy: { include_domains: ["amazon.com"] },
          excerpt_settings: { max_chars_per_result: EXCERPT_CHARS },
        },
      },
    );
    return {
      results: (data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, text: (r.excerpts ?? []).join("\n").slice(0, EXCERPT_CHARS) })),
    };
  },
};

const tavily: Provider = {
  system: "tavily",
  env: ["TAVILY_API_KEY"],
  anyRetailer: false,
  tool: webTool("Search amazon.com pages with Tavily. Returns up to 10 pages with title, url and page text."),
  async search({ query }) {
    // https://docs.tavily.com/documentation/api-reference/endpoint/search
    const data = await postJson(
      "tavily",
      "https://api.tavily.com/search",
      { Authorization: `Bearer ${requireEnv("TAVILY_API_KEY")}` },
      { query, search_depth: "basic", max_results: 10, include_domains: ["amazon.com"] },
    );
    return { results: (data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, text: String(r.content ?? "").slice(0, EXCERPT_CHARS) })) };
  },
};

// ---------------------------------------------------------------------------
// Google Shopping via SerpApi: Google's product catalog, any retailer (including
// Amazon listings when Google has them), judged on Google's own record.

const googleShopping: Provider = {
  system: "google_shopping",
  env: ["SERPAPI_API_KEY"],
  anyRetailer: true,
  tool: productTool(
    "Search Google Shopping. Returns up to 20 products with price, store, rating, review count, delivery and url.",
  ),
  async search({ query, min_price, max_price }) {
    // https://serpapi.com/google-shopping-api
    const params = new URLSearchParams({ engine: "google_shopping", q: query, gl: "us", hl: "en", api_key: requireEnv("SERPAPI_API_KEY") });
    const data = await getJson("serpapi", `https://serpapi.com/search.json?${params}`);
    if (data.error && !/hasn't returned any results/i.test(data.error)) throw new Error(`serpapi: ${data.error}`);
    const results = (data.shopping_results ?? [])
      .filter((r: any) => (min_price == null || (r.extracted_price ?? 0) >= min_price) && (max_price == null || (r.extracted_price ?? Infinity) <= max_price))
      .slice(0, 20)
      .map((r: any) => ({
        title: r.title,
        // product_link is a Google search url that differs only in its query string; the id is stable.
        url: r.product_id ? `https://www.google.com/shopping/product/${r.product_id}` : (r.product_link ?? r.link ?? null),
        store: r.source ?? null,
        snippet: r.snippet ?? null,
        price: r.extracted_price ?? null,
        rating: r.rating ?? null,
        ratings_total: r.reviews ?? null,
        delivery: r.delivery ?? null,
        extensions: r.extensions ?? [],
      }));
    const pages: Record<string, unknown> = {};
    for (const p of results) if (p.url) pages[p.url] = p;
    return { results, pages };
  },
};

export const PROVIDERS: Provider[] = [channel3, shopifyCatalog, googleShopping, exa, linkup, parallel, tavily];
