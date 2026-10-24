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
  error?: string;
}

export function loadTasks(path = new URL("./tasks.jsonl", import.meta.url)): Task[] {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

export function asinFromUrl(url: string | null | undefined): string | null {
  return url?.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/)([A-Z0-9]{10})/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Rainforest (Amazon data). Every response is cached on disk: free-plan credits
// are scarce and re-runs while tuning should cost nothing.

const CACHE_DIR = new URL("../.cache/rainforest/", import.meta.url);
let liveCalls = 0;
export const rainforestLiveCalls = () => liveCalls;

export async function rainforest(params: Record<string, string>): Promise<any> {
  const key = process.env.RAINFOREST_API_KEY;
  if (!key) throw new Error("RAINFOREST_API_KEY is not set");
  const q = { amazon_domain: "amazon.com", ...params };
  const id = createHash("sha256").update(JSON.stringify(Object.entries(q).sort())).digest("hex").slice(0, 24);
  const file = new URL(`${id}.json`, CACHE_DIR);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));

  const res = await fetch(`https://api.rainforestapi.com/request?${new URLSearchParams({ api_key: key, ...q })}`, {
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json();
  liveCalls++;
  if (!res.ok || data?.request_info?.success === false) {
    throw new Error(`rainforest ${res.status}: ${JSON.stringify(data?.request_info ?? data).slice(0, 300)}`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  return data;
}

/** The fields of a product page a shopper (or judge) would look at. */
export function trimProduct(p: any) {
  if (!p) return null;
  const bb = p.buybox_winner ?? {};
  return {
    asin: p.asin,
    title: p.title,
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
  const data = await rainforest({ type: "product", asin });
  return trimProduct(data.product);
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
