// Rye Universal Checkout (rye.com/docs, API v2): buy from a product URL on
// merchants with no agent API (Amazon, Target, Best Buy, ...). Rye places the
// order itself, so this route has "automation" semantics for data-policy filtering.
//   POST /api/v1/checkout-intents            { productUrl, quantity, buyer }
//   GET  /api/v1/checkout-intents/{id}       state: retrieving_offer | awaiting_confirmation |
//                                            requires_action | placing_order | completed | failed
//   POST /api/v1/checkout-intents/{id}/confirm  { paymentMethod: { type: "drawdown" } | { type: "stripe_token", stripeToken } }
// Intents expire 45 minutes after creation.
import type { AdapterContext, CreateInput, MerchantAdapter } from "./base.ts";
import { splitName } from "./base.ts";
import type { Address, Buyer, Checkout, CheckoutStatus, PaymentGrant } from "../types.ts";
import { RouteError } from "../types.ts";
import { requestJson } from "../util/http.ts";

/** Staging unless RYE_ENV=production, so a misconfigured sandbox can never spend real drawdown balance. */
export function ryeBase(): string {
  if (process.env.RYE_BASE_URL) return process.env.RYE_BASE_URL.replace(/\/$/, "");
  return process.env.RYE_ENV === "production" ? "https://api.rye.com" : "https://staging.api.rye.com";
}

function headers(): Record<string, string> {
  const key = process.env.RYE_API_KEY;
  if (!key) throw new RouteError("RYE_API_KEY not set", { retriable: true });
  return { authorization: `Bearer ${key}` };
}

const STATE: Record<string, CheckoutStatus> = {
  retrieving_offer: "processing",
  awaiting_confirmation: "ready",
  requires_action: "requires_action",
  placing_order: "processing",
  completed: "completed",
  failed: "failed",
};

/** Rye money appears as cents, { amountSubunits, currencyCode } or { amount, currency }. */
function money(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  return v.amountSubunits ?? v.amount ?? undefined;
}

function ryeBuyer(b: Buyer, a: Address) {
  const { first, last } = splitName(a.name);
  return {
    firstName: b.firstName ?? first,
    lastName: b.lastName ?? last,
    email: b.email,
    phone: b.phone ?? a.phone ?? "",
    address1: a.line1,
    address2: a.line2 ?? "",
    city: a.city,
    province: a.region,
    postalCode: a.postalCode,
    country: a.country,
  };
}

function mapIntent(ctx: AdapterContext, co: Checkout, raw: any): Checkout {
  const cost = raw.offer?.cost ?? {};
  const currency = cost.total?.currencyCode ?? cost.total?.currency ?? co.currency ?? "USD";
  const total = money(cost.total) ?? 0;
  const status = STATE[raw.state] ?? "processing";
  const messages: string[] = [];
  if (raw.state === "retrieving_offer") messages.push("Rye is pricing this order (tax + shipping). Call get_checkout again in a few seconds.");
  if (raw.state === "failed") messages.push(`Rye failed: ${raw.failureReason?.message ?? raw.failureReason?.code ?? raw.failureReason ?? "unknown"}`);
  const shipping = raw.offer?.shipping;
  return {
    ...co,
    remoteId: raw.id,
    status,
    currency,
    lineItems: co.lineItems.map((li) => ({
      ...li,
      unitPrice: { amount: money(cost.subtotal) != null ? Math.round(money(cost.subtotal)! / li.quantity) : li.unitPrice.amount, currency },
      total: { amount: money(cost.subtotal) ?? li.total.amount, currency },
    })),
    totals: { subtotal: money(cost.subtotal), shipping: money(cost.shipping), tax: money(cost.tax), total },
    fulfillmentOptions: (shipping?.availableOptions ?? []).map((o: any) => ({
      id: o.id,
      title: o.label ?? o.title ?? o.id,
      price: { amount: money(o.cost) ?? 0, currency },
    })),
    selectedFulfillmentOptionId: shipping?.selectedOptionId,
    messages,
    order: raw.state === "completed" ? { id: raw.orderId ?? raw.order?.id ?? raw.id, url: raw.order?.url } : undefined,
    state: { ...co.state, raw },
  };
}

async function poll(id: string, until: string[], maxMs: number): Promise<any> {
  const deadline = Date.now() + maxMs;
  let raw = await requestJson(`${ryeBase()}/api/v1/checkout-intents/${id}`, { headers: headers() });
  while (!until.includes(raw.state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Number(process.env.RYE_POLL_MS ?? 1500)));
    raw = await requestJson(`${ryeBase()}/api/v1/checkout-intents/${id}`, { headers: headers() });
  }
  return raw;
}

async function createIntent(ctx: AdapterContext, co: Checkout): Promise<Checkout> {
  const pending = co.state?.pending as { productUrl: string; quantity: number };
  const buyer = co.state?.buyer as Buyer | undefined;
  const shipTo = co.state?.shipTo as Address | undefined;
  if (!buyer || !shipTo) {
    return { ...co, status: "needs_info", messages: ["Rye needs buyer (email) and shipTo before it can price the order."] };
  }
  const created = await requestJson(`${ryeBase()}/api/v1/checkout-intents`, {
    headers: headers(),
    body: { productUrl: pending.productUrl, quantity: pending.quantity, buyer: ryeBuyer(buyer, shipTo) },
    idempotent: true,
  });
  const raw = await poll(created.id, ["awaiting_confirmation", "requires_action", "failed"], Number(process.env.RYE_OFFER_WAIT_MS ?? 20_000));
  return mapIntent(ctx, co, raw);
}

export const ryeAdapter: MerchantAdapter = {
  protocol: "rye",
  automation: true,

  async paymentKind() {
    return process.env.RYE_PAYMENT === "stripe_token" ? "stripe_token" : "rye_drawdown";
  },

  async create(ctx, input: CreateInput) {
    headers(); // fail over now if Rye isn't configured, not after the agent fills in an address
    if (input.items.length !== 1 || !input.items[0].productUrl) {
      throw new RouteError("Rye checks out one product URL per checkout", { retriable: true });
    }
    const { productUrl, quantity } = input.items[0];
    const co: Checkout = {
      id: input.id,
      merchantId: ctx.merchant.id,
      route: "rye",
      remoteId: "",
      status: "needs_info",
      currency: "USD",
      lineItems: [
        { id: "li_1", productId: productUrl!, title: productUrl!, quantity, unitPrice: { amount: 0, currency: "USD" }, total: { amount: 0, currency: "USD" } },
      ],
      totals: { total: 0 },
      fulfillmentOptions: [],
      messages: [],
      state: { pending: { productUrl, quantity }, buyer: input.buyer, shipTo: input.shipTo },
    };
    return createIntent(ctx, co);
  },

  async get(ctx, co) {
    if (!co.remoteId) return co;
    const raw = await requestJson(`${ryeBase()}/api/v1/checkout-intents/${co.remoteId}`, { headers: headers() });
    return mapIntent(ctx, co, raw);
  },

  async update(ctx, co, upd) {
    if (upd.fulfillmentOptionId) throw new RouteError("Rye picks shipping itself; shipping options are informational");
    const next = { ...co, state: { ...co.state, buyer: upd.buyer ?? co.state?.buyer, shipTo: upd.shipTo ?? co.state?.shipTo } };
    // Buyer/address are fixed at intent creation, so a change means a fresh intent.
    if (co.remoteId && (upd.buyer || upd.shipTo)) next.remoteId = "";
    return next.remoteId ? next : createIntent(ctx, next);
  },

  async complete(ctx, co, grant: PaymentGrant) {
    const paymentMethod =
      grant.kind === "stripe_token" ? { type: "stripe_token", stripeToken: grant.token } : { type: "drawdown" };
    await requestJson(`${ryeBase()}/api/v1/checkout-intents/${co.remoteId}/confirm`, {
      headers: headers(),
      body: { paymentMethod },
      idempotent: true,
    });
    const raw = await poll(co.remoteId, ["completed", "failed", "requires_action"], Number(process.env.RYE_ORDER_WAIT_MS ?? 30_000));
    return mapIntent(ctx, co, raw);
  },

  async cancel(_ctx, co) {
    // Rye intents expire on their own after 45 minutes; nothing to call.
    return { ...co, status: "canceled", messages: ["Canceled locally; the Rye intent will expire unconfirmed."] };
  },
};
