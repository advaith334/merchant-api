// Agentic Commerce Protocol (OpenAI + Stripe, agenticcommerce.dev), API-Version 2026-04-17.
// Spec: agentic-commerce-protocol/spec/2026-04-17/openapi/openapi.agentic_checkout.yaml
// The merchant onboards the router as an agent and issues it a bearer key.
import { randomUUID } from "node:crypto";
import type { AdapterContext, CreateInput, MerchantAdapter } from "./base.ts";
import type { Address, Checkout, CheckoutStatus, PaymentGrant, Product } from "../types.ts";
import { RouteError } from "../types.ts";
import { requestJson } from "../util/http.ts";

const DEFAULT_VERSION = "2026-04-17";

function cfg(ctx: AdapterContext) {
  if (ctx.route.protocol !== "acp") throw new Error("acp adapter used with non-acp route");
  return ctx.route;
}

function headers(ctx: AdapterContext): Record<string, string> {
  const r = cfg(ctx);
  const key = process.env[r.apiKeyEnv];
  if (!key) throw new RouteError(`missing ${r.apiKeyEnv} for ACP merchant ${ctx.merchant.id}`, { retriable: true });
  return {
    authorization: `Bearer ${key}`,
    "api-version": r.apiVersion ?? DEFAULT_VERSION,
    "request-id": randomUUID(),
    timestamp: new Date().toISOString(),
    "user-agent": "merchant-router/0.1",
  };
}

const toAcpAddress = (a: Address) => ({
  name: a.name,
  line_one: a.line1,
  line_two: a.line2 ?? "",
  city: a.city,
  state: a.region,
  country: a.country,
  postal_code: a.postalCode,
});

const STATUS: Record<string, CheckoutStatus> = {
  incomplete: "needs_info",
  not_ready_for_payment: "needs_info",
  requires_escalation: "requires_action",
  authentication_required: "requires_action",
  pending_approval: "requires_action",
  ready_for_payment: "ready",
  complete_in_progress: "processing",
  in_progress: "processing",
  completed: "completed",
  canceled: "canceled",
  expired: "failed",
};

const totalOf = (totals: any[] | undefined, type: string) => totals?.find((t) => t.type === type)?.amount;

function pickHandler(raw: any): { id: string; kind: PaymentGrant["kind"] } | undefined {
  const handlers: any[] = raw?.capabilities?.payment?.handlers ?? [];
  const stripe = handlers.find((h) => h.psp === "stripe" || /tokenized\.card/.test(h.name ?? ""));
  if (stripe) return { id: stripe.id, kind: /test/.test(stripe.name ?? "") ? "test" : "stripe_spt" };
  const test = handlers.find((h) => /test/.test(h.name ?? ""));
  return test ? { id: test.id, kind: "test" } : undefined;
}

export function mapAcpCheckout(ctx: AdapterContext, id: string, raw: any, prevState: Record<string, unknown> = {}): Checkout {
  const currency = (raw.currency ?? "usd").toUpperCase();
  // Handlers are advertised on create; later responses may send an empty list, so keep the first good one.
  const handler = pickHandler(raw) ?? (prevState.handler as ReturnType<typeof pickHandler>);
  return {
    id,
    merchantId: ctx.merchant.id,
    route: "acp",
    remoteId: raw.id,
    status: STATUS[raw.status] ?? "needs_info",
    currency,
    lineItems: (raw.line_items ?? []).map((li: any) => ({
      id: li.id,
      productId: `${ctx.merchant.id}:${li.item?.id}`,
      title: li.name ?? li.item?.name ?? li.item?.id,
      quantity: li.quantity ?? 1,
      unitPrice: { amount: li.unit_amount ?? totalOf(li.totals, "items_base_amount") ?? 0, currency },
      total: { amount: totalOf(li.totals, "total") ?? 0, currency },
    })),
    totals: {
      subtotal: totalOf(raw.totals, "subtotal"),
      shipping: totalOf(raw.totals, "fulfillment"),
      tax: totalOf(raw.totals, "tax"),
      discount: totalOf(raw.totals, "discount"),
      total: totalOf(raw.totals, "total") ?? 0,
    },
    fulfillmentOptions: (raw.fulfillment_options ?? []).map((o: any) => ({
      id: o.id,
      title: o.title ?? o.id,
      price: { amount: totalOf(o.totals, "total") ?? 0, currency },
      ref: { type: o.type ?? "shipping" },
    })),
    selectedFulfillmentOptionId: raw.selected_fulfillment_options?.[0]?.option_id,
    messages: (raw.messages ?? []).map((m: any) => m.content ?? m.code),
    continueUrl: raw.continue_url,
    order: raw.order ? { id: raw.order.id, url: raw.order.permalink_url } : undefined,
    state: { raw, handler },
  };
}

export const acpAdapter: MerchantAdapter = {
  protocol: "acp",
  automation: false,

  async paymentKind(ctx, co) {
    const h = co.state?.handler as ReturnType<typeof pickHandler>;
    if (!h) throw new RouteError(`${ctx.merchant.name} advertised no payment handler this router can use`);
    return h.kind;
  },

  // ACP has no search endpoint; merchants publish a product feed instead.
  async search(ctx, query, limit) {
    const r = cfg(ctx);
    if (!r.feedUrl) return [];
    const feed = await requestJson(r.feedUrl, { timeoutMs: 8_000 });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: Product[] = [];
    for (const p of feed.products ?? []) {
      const hay = `${p.title} ${p.description?.plain ?? ""} ${(p.tags ?? []).join(" ")}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      for (const v of p.variants ?? []) {
        out.push({
          id: `${ctx.merchant.id}:${v.id}`,
          merchantId: ctx.merchant.id,
          merchantName: ctx.merchant.name,
          title: v.title ?? p.title,
          price: v.price ?? p.price,
          url: v.url ?? p.url,
          image: (v.media ?? p.media)?.[0]?.url,
          available: v.availability ? v.availability.available !== false : undefined,
          route: "acp",
        });
        break;
      }
      if (out.length >= limit) break;
    }
    return out;
  },

  async create(ctx, input: CreateInput) {
    if (input.items.some((i) => !i.variantId)) {
      throw new RouteError("ACP needs merchant item ids (search first); got a bare URL", { retriable: true });
    }
    // 2026-04-17 Item has no quantity field: one entry per unit.
    const line_items = input.items.flatMap((i) => Array.from({ length: i.quantity }, () => ({ id: i.variantId! })));
    const body: any = {
      currency: "usd",
      line_items,
      capabilities: { interventions: { supported: [], display_context: "native" } },
    };
    if (input.buyer) {
      body.buyer = {
        email: input.buyer.email,
        first_name: input.buyer.firstName,
        last_name: input.buyer.lastName,
        phone_number: input.buyer.phone,
      };
    }
    if (input.shipTo) {
      body.fulfillment_details = {
        name: input.shipTo.name,
        email: input.buyer?.email,
        phone_number: input.shipTo.phone ?? input.buyer?.phone,
        address: toAcpAddress(input.shipTo),
      };
    }
    const raw = await requestJson(`${cfg(ctx).baseUrl}/checkout_sessions`, { headers: headers(ctx), body, idempotent: true });
    return mapAcpCheckout(ctx, input.id, raw);
  },

  async get(ctx, co) {
    const raw = await requestJson(`${cfg(ctx).baseUrl}/checkout_sessions/${co.remoteId}`, { headers: headers(ctx) });
    return mapAcpCheckout(ctx, co.id, raw, co.state);
  },

  async update(ctx, co, upd) {
    const body: any = {};
    if (upd.buyer) {
      body.buyer = { email: upd.buyer.email, first_name: upd.buyer.firstName, last_name: upd.buyer.lastName, phone_number: upd.buyer.phone };
    }
    if (upd.shipTo) {
      body.fulfillment_details = { name: upd.shipTo.name, phone_number: upd.shipTo.phone, address: toAcpAddress(upd.shipTo) };
    }
    if (upd.fulfillmentOptionId) {
      const opt = co.fulfillmentOptions.find((o) => o.id === upd.fulfillmentOptionId);
      if (!opt) throw new RouteError(`unknown fulfillment option ${upd.fulfillmentOptionId}`);
      body.selected_fulfillment_options = [
        { type: opt.ref?.type ?? "shipping", option_id: opt.id, item_ids: [...new Set(co.lineItems.map((l) => l.productId.split(":").slice(1).join(":")))] },
      ];
    }
    // ACP updates are POST to the session resource.
    const raw = await requestJson(`${cfg(ctx).baseUrl}/checkout_sessions/${co.remoteId}`, { headers: headers(ctx), body, idempotent: true });
    return mapAcpCheckout(ctx, co.id, raw, co.state);
  },

  async complete(ctx, co, grant) {
    const h = co.state?.handler as ReturnType<typeof pickHandler>;
    if (!h) throw new RouteError("no payment handler for this session");
    const body = {
      payment_data: {
        handler_id: h.id,
        instrument: { type: "card", credential: { type: "spt", token: grant.token } },
      },
    };
    const raw = await requestJson(`${cfg(ctx).baseUrl}/checkout_sessions/${co.remoteId}/complete`, {
      headers: headers(ctx),
      body,
      idempotent: true,
      timeoutMs: 30_000,
    });
    return mapAcpCheckout(ctx, co.id, raw, co.state);
  },

  async cancel(ctx, co) {
    const raw = await requestJson(`${cfg(ctx).baseUrl}/checkout_sessions/${co.remoteId}/cancel`, {
      headers: headers(ctx),
      body: { intent_trace: { reason_code: "other", trace_summary: "Canceled by agent via merchant-router" } },
      idempotent: true,
    });
    return mapAcpCheckout(ctx, co.id, raw, co.state);
  },
};
