// Universal Commerce Protocol (Google + Shopify, ucp.dev).
// REST: Universal-Commerce-Protocol/ucp source/services/shopping/rest.openapi.json
// MCP:  what Shopify actually ships today. Every Shopify store publishes
//       /.well-known/ucp pointing at https://<shop>.myshopify.com/api/ucp/mcp with
//       search_catalog / create_checkout / update_checkout / complete_checkout tools.
// Merchants fetch the *agent's* profile (UCP-Agent header / meta.ucp-agent), so the
// router must serve its own /.well-known/ucp at a public URL (ROUTER_UCP_PROFILE).
import { randomUUID } from "node:crypto";
import type { AdapterContext, CreateInput, MerchantAdapter } from "./base.ts";
import { splitName } from "./base.ts";
import type { Address, Checkout, CheckoutStatus, CheckoutUpdate, PaymentKind, Product } from "../types.ts";
import { RouteError } from "../types.ts";
import { requestJson } from "../util/http.ts";

interface Handler {
  id: string;
  name: string;
  config?: Record<string, any>;
}

interface Discovery {
  transport: "rest" | "mcp";
  endpoint: string;
  version: string;
  handlers: Handler[];
  fetchedAt: number;
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const cache = new Map<string, Discovery>();

export function agentProfileUrl(): string {
  return process.env.ROUTER_UCP_PROFILE ?? "http://localhost:8787/.well-known/ucp";
}

export function profileUrlFor(ctx: AdapterContext): string {
  if (ctx.route.protocol === "ucp" && ctx.route.profileUrl) return ctx.route.profileUrl;
  return `https://${ctx.merchant.domains[0]}/.well-known/ucp`;
}

export async function discover(profileUrl: string): Promise<Discovery> {
  const hit = cache.get(profileUrl);
  if (hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) return hit;
  let profile: any;
  try {
    profile = await requestJson(profileUrl, { timeoutMs: 5_000 });
  } catch (err) {
    // No profile = merchant doesn't speak UCP (yet). Always worth falling back.
    throw new RouteError(`no UCP profile at ${profileUrl}: ${(err as Error).message}`, { retriable: true });
  }
  const ucp = profile?.ucp;
  const services: any[] = ucp?.services?.["dev.ucp.shopping"] ?? [];
  // Prefer REST, else MCP. "embedded" is a buyer-facing iframe, not usable by agents.
  const svc = services.find((s) => s.transport === "rest" && s.endpoint) ?? services.find((s) => s.transport === "mcp" && s.endpoint);
  if (!svc) throw new RouteError(`no UCP REST/MCP shopping service at ${profileUrl}`, { retriable: true });
  // payment_handlers is { "<reverse-dns name>": [ { id, ... } ] }
  const handlers: Handler[] = Object.entries(ucp.payment_handlers ?? {}).flatMap(([name, list]) =>
    (list as any[]).map((h) => ({ id: h.id, name: h.name ?? name, config: h.config })),
  );
  const d: Discovery = {
    transport: svc.transport,
    endpoint: svc.endpoint.replace(/\/$/, ""),
    version: svc.version ?? ucp.version,
    handlers,
    fetchedAt: Date.now(),
  };
  cache.set(profileUrl, d);
  return d;
}

export function clearDiscoveryCache() {
  cache.clear();
}

/**
 * Map the merchant's payment handlers to a credential this router can mint.
 * Wallet-only merchants (Shop Pay / Google Pay need the buyer's own wallet session)
 * get "handoff": the router builds the checkout and returns the merchant's
 * continue_url so a human taps pay.
 */
function pickHandler(handlers: Handler[]): { handler?: Handler; kind: PaymentKind } {
  const stripe = handlers.find((h) => /stripe/i.test(h.name));
  if (stripe) return { handler: stripe, kind: "stripe_spt" };
  const test = handlers.find((h) => /(^|\.)test(\.|$)|sandbox/i.test(h.name));
  if (test) return { handler: test, kind: "test" };
  return { kind: "handoff" };
}

// ---------------------------------------------------------------------------
// Transport: the same five operations over REST or MCP (JSON-RPC tools/call).

type Op = "search" | "create" | "get" | "update" | "complete" | "cancel";

async function call(ctx: AdapterContext, d: Discovery, op: Op, args: { id?: string; body?: any }): Promise<any> {
  const token = ctx.route.protocol === "ucp" && ctx.route.authEnv ? process.env[ctx.route.authEnv] : undefined;
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const idem = randomUUID();

  if (d.transport === "rest") {
    const h = { "ucp-agent": `profile="${agentProfileUrl()}"`, "request-id": randomUUID(), "idempotency-key": idem, ...auth };
    const base = d.endpoint;
    switch (op) {
      case "search":
        return requestJson(`${base}/catalog/search`, { headers: h, body: args.body, timeoutMs: 8_000 });
      case "create":
        return requestJson(`${base}/checkout-sessions`, { headers: h, body: args.body });
      case "get":
        return requestJson(`${base}/checkout-sessions/${args.id}`, { headers: h });
      case "update":
        return requestJson(`${base}/checkout-sessions/${args.id}`, { method: "PUT", headers: h, body: args.body });
      case "complete":
        return requestJson(`${base}/checkout-sessions/${args.id}/complete`, { headers: h, body: args.body, timeoutMs: 30_000 });
      case "cancel":
        return requestJson(`${base}/checkout-sessions/${args.id}/cancel`, { headers: h, body: {} });
    }
  }

  const tool = { search: "search_catalog", create: "create_checkout", get: "get_checkout", update: "update_checkout", complete: "complete_checkout", cancel: "cancel_checkout" }[op];
  const meta: any = { "ucp-agent": { profile: agentProfileUrl() } };
  if (op === "complete") meta["idempotency-key"] = idem;
  const toolArgs: any = { meta };
  if (args.id) toolArgs.id = args.id;
  if (op === "search") toolArgs.catalog = args.body;
  else if (args.body) toolArgs.checkout = args.body;

  let rpc: any;
  try {
    rpc = await requestJson(d.endpoint, {
      headers: { accept: "application/json, text/event-stream", ...auth },
      body: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: tool, arguments: toolArgs } },
      timeoutMs: op === "complete" ? 30_000 : 10_000,
    });
  } catch (err) {
    if (/discovery failed|profile/i.test((err as Error).message)) {
      throw new RouteError(
        `${(err as Error).message}. The merchant must fetch this router's UCP profile (${agentProfileUrl()}); ` +
          `deploy the router on a public HTTPS URL and set ROUTER_UCP_PROFILE=https://<host>/.well-known/ucp`,
        { retriable: true },
      );
    }
    throw err;
  }
  if (rpc.error) {
    const data = rpc.error.data ?? {};
    // Discovery / profile problems are worth falling back on; business errors are not.
    throw new RouteError(`${tool}: ${rpc.error.message}${data.content ? ` (${data.content})` : ""}`, {
      retriable: rpc.error.code === -32001 || rpc.error.code === -32603,
    });
  }
  const result = rpc.result ?? {};
  const text = (result.content ?? []).find((c: any) => c.type === "text")?.text;
  // Tool-level failure (bad item, wrong state): the merchant answered, so don't fall back.
  if (result.isError) throw new RouteError(`${tool}: ${text ?? "tool error"}`, { status: 400 });
  if (result.structuredContent) return result.structuredContent;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    throw new RouteError(`${tool} returned non-JSON content: ${text.slice(0, 200)}`);
  }
}

/** Unwrap { checkout: {...} } envelopes some MCP servers use. */
const unwrap = (r: any) => r?.checkout ?? r;

// ---------------------------------------------------------------------------
// Mapping

function toPostal(a: Address) {
  const { first, last } = splitName(a.name);
  return {
    first_name: first,
    last_name: last,
    street_address: a.line1,
    extended_address: a.line2,
    address_locality: a.city,
    address_region: a.region,
    postal_code: a.postalCode,
    address_country: a.country,
    phone_number: a.phone,
  };
}

const STATUS: Record<string, CheckoutStatus> = {
  incomplete: "needs_info",
  requires_escalation: "requires_action",
  ready_for_complete: "ready",
  complete_in_progress: "processing",
  completed: "completed",
  canceled: "canceled",
};

/** UCP amounts are integer minor units, or { amount, currency } in newer MCP responses. */
const amt = (v: any): number | undefined => (typeof v === "number" ? v : typeof v?.amount === "number" ? v.amount : undefined);
const totalOf = (totals: any[] | undefined, type: string) => amt(totals?.find((t) => t.type === type)?.amount);

export function mapUcpCheckout(ctx: AdapterContext, id: string, raw: any): Checkout {
  const currency = raw.currency ?? "USD";
  const options: Checkout["fulfillmentOptions"] = [];
  let selected: string | undefined;
  for (const m of raw.fulfillment?.methods ?? []) {
    for (const g of m.groups ?? []) {
      if (g.selected_option_id) selected = g.selected_option_id;
      for (const o of g.options ?? []) {
        options.push({
          id: o.id,
          title: o.title ?? o.id,
          price: { amount: totalOf(o.totals, "total") ?? 0, currency },
          ref: { methodId: m.id, groupId: g.id },
        });
      }
    }
  }
  return {
    id,
    merchantId: ctx.merchant.id,
    route: "ucp",
    remoteId: raw.id,
    status: STATUS[raw.status] ?? "needs_info",
    currency,
    lineItems: (raw.line_items ?? []).map((li: any) => ({
      id: li.id,
      productId: `${ctx.merchant.id}:${li.item?.id}`,
      title: li.item?.title ?? li.item?.id,
      quantity: li.quantity,
      unitPrice: { amount: amt(li.item?.price) ?? 0, currency },
      total: { amount: totalOf(li.totals, "total") ?? totalOf(li.totals, "subtotal") ?? 0, currency },
    })),
    totals: {
      subtotal: totalOf(raw.totals, "subtotal"),
      shipping: totalOf(raw.totals, "fulfillment"),
      tax: totalOf(raw.totals, "tax"),
      discount: totalOf(raw.totals, "discount"),
      total: totalOf(raw.totals, "total") ?? 0,
    },
    fulfillmentOptions: options,
    selectedFulfillmentOptionId: selected,
    messages: (raw.messages ?? []).map((m: any) => m.content ?? m.code),
    continueUrl: raw.continue_url,
    order: raw.order ? { id: raw.order.id, url: raw.order.permalink_url } : undefined,
    state: { raw },
  };
}

const buyerBody = (b: { email: string; firstName?: string; lastName?: string; phone?: string }) => ({
  email: b.email,
  first_name: b.firstName,
  last_name: b.lastName,
  phone_number: b.phone,
});

// ---------------------------------------------------------------------------

export const ucpAdapter: MerchantAdapter = {
  protocol: "ucp",
  automation: false,

  async paymentKind(ctx) {
    return pickHandler((await discover(profileUrlFor(ctx))).handlers).kind;
  },

  async search(ctx, query, limit) {
    const d = await discover(profileUrlFor(ctx));
    const res = await call(ctx, d, "search", { body: { query, pagination: { limit } } });
    const out: Product[] = [];
    for (const p of res.products ?? []) {
      const v = (p.variants ?? [])[0];
      if (!v) continue;
      const price = v.price ?? p.price_range?.min;
      out.push({
        id: `${ctx.merchant.id}:${v.id}`,
        merchantId: ctx.merchant.id,
        merchantName: ctx.merchant.name,
        title: v.title && v.title !== p.title ? `${p.title} — ${v.title}` : p.title,
        price: { amount: amt(price) ?? 0, currency: price?.currency ?? "USD" },
        url: v.url ?? p.url,
        image: (v.media ?? p.media)?.[0]?.url,
        available: v.availability ? v.availability.available !== false : undefined,
        route: "ucp",
      });
    }
    return out.slice(0, limit);
  },

  async create(ctx, input: CreateInput) {
    if (input.items.some((i) => !i.variantId)) {
      throw new RouteError("UCP needs merchant item ids (search first); got a bare URL", { retriable: true });
    }
    const d = await discover(profileUrlFor(ctx));
    const body: any = { line_items: input.items.map((i) => ({ item: { id: i.variantId }, quantity: i.quantity })) };
    if (input.buyer) body.buyer = buyerBody(input.buyer);
    if (input.shipTo) body.fulfillment = { methods: [{ type: "shipping", destinations: [toPostal(input.shipTo)] }] };
    return mapUcpCheckout(ctx, input.id, unwrap(await call(ctx, d, "create", { body })));
  },

  async get(ctx, co) {
    const d = await discover(profileUrlFor(ctx));
    return mapUcpCheckout(ctx, co.id, unwrap(await call(ctx, d, "get", { id: co.remoteId })));
  },

  async update(ctx, co, upd: CheckoutUpdate) {
    const d = await discover(profileUrlFor(ctx));
    const prev: any = co.state?.raw ?? {};
    // UCP update replaces the mutable fields, so resend line items and current selections.
    const body: any = {
      line_items: (prev.line_items ?? []).map((li: any) => ({ id: li.id, item: { id: li.item.id }, quantity: li.quantity })),
    };
    if (upd.buyer) body.buyer = buyerBody(upd.buyer);
    else if (prev.buyer) body.buyer = prev.buyer;
    const methods = (prev.fulfillment?.methods ?? []).map((m: any) => ({
      id: m.id,
      type: m.type,
      line_item_ids: m.line_item_ids,
      selected_destination_id: m.selected_destination_id ?? undefined,
      groups: (m.groups ?? []).map((g: any) => ({ id: g.id, selected_option_id: g.selected_option_id ?? undefined })),
    }));
    if (upd.shipTo) {
      if (methods.length) {
        methods[0].destinations = [toPostal(upd.shipTo)];
        delete methods[0].selected_destination_id;
      } else {
        methods.push({ type: "shipping", destinations: [toPostal(upd.shipTo)] });
      }
    }
    if (upd.fulfillmentOptionId) {
      const opt = co.fulfillmentOptions.find((o) => o.id === upd.fulfillmentOptionId);
      if (!opt) throw new RouteError(`unknown fulfillment option ${upd.fulfillmentOptionId}`);
      for (const m of methods) for (const g of m.groups ?? []) if (g.id === opt.ref?.groupId) g.selected_option_id = opt.id;
    }
    if (methods.length) body.fulfillment = { methods };
    return mapUcpCheckout(ctx, co.id, unwrap(await call(ctx, d, "update", { id: co.remoteId, body })));
  },

  async complete(ctx, co, grant) {
    const d = await discover(profileUrlFor(ctx));
    const picked = pickHandler(d.handlers);
    if (!picked.handler || picked.kind !== grant.kind) {
      throw new RouteError(`${ctx.merchant.name} needs ${picked.kind}, got ${grant.kind}`);
    }
    const body = {
      payment: {
        instruments: [
          {
            id: "pi_1",
            handler_id: picked.handler.id,
            type: "card",
            credential: { type: grant.kind === "stripe_spt" ? "spt" : "token", token: grant.token },
            selected: true,
          },
        ],
      },
    };
    return mapUcpCheckout(ctx, co.id, unwrap(await call(ctx, d, "complete", { id: co.remoteId, body })));
  },

  async cancel(ctx, co) {
    const d = await discover(profileUrlFor(ctx));
    return mapUcpCheckout(ctx, co.id, unwrap(await call(ctx, d, "cancel", { id: co.remoteId })));
  },
};
