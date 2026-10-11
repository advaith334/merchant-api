// Last-resort gap filler for merchants with no agent API: hand the purchase to a
// computer-use runner (a browser agent you host, e.g. on your own GPUs) that
// implements the contract below. Without a runner configured, the route degrades
// to a human handoff: the agent gets the product URL plus a structured task.
//
// Runner contract (COMPUTER_USE_RUNNER_URL):
//   POST /tasks  { task: "checkout", merchant, productUrl, quantity, buyer, shipTo, maxTotal: Money }
//     -> { id, status: "quoted" | "requires_action" | "failed", total?: Money, continueUrl?, message? }
//   POST /tasks/{id}/confirm  { authorization: { maxAmount, currency, expiresAt } }
//     -> { id, status: "completed" | "failed" | "requires_action", orderId?, message? }
//   GET  /tasks/{id} -> same shape
// The runner holds its own funding (e.g. a single-use virtual card per task); the
// router only passes a spend cap, never card data.
//
// Merchants marked agentPolicy: "prohibited" (their terms forbid automated agents)
// are never sent to this route. The runner must not defeat CAPTCHAs or bot checks;
// if it hits one it returns requires_action.
import type { AdapterContext, CreateInput, MerchantAdapter } from "./base.ts";
import type { Checkout, CheckoutStatus } from "../types.ts";
import { RouteError } from "../types.ts";
import { requestJson } from "../util/http.ts";

const runner = () => process.env.COMPUTER_USE_RUNNER_URL?.replace(/\/$/, "");

const STATUS: Record<string, CheckoutStatus> = {
  quoted: "ready",
  requires_action: "requires_action",
  running: "processing",
  completed: "completed",
  failed: "failed",
};

function map(co: Checkout, raw: any): Checkout {
  const total = raw.total?.amount ?? co.totals.total;
  return {
    ...co,
    remoteId: raw.id ?? co.remoteId,
    status: STATUS[raw.status] ?? "processing",
    currency: raw.total?.currency ?? co.currency,
    totals: { ...co.totals, total },
    continueUrl: raw.continueUrl ?? co.continueUrl,
    messages: raw.message ? [raw.message] : [],
    order: raw.orderId ? { id: raw.orderId } : co.order,
  };
}

export const computerUseAdapter: MerchantAdapter = {
  protocol: "computer_use",
  automation: true,

  async paymentKind() {
    return runner() ? "runner_authorization" : "handoff";
  },

  async create(ctx: AdapterContext, input: CreateInput) {
    if (ctx.merchant.agentPolicy === "prohibited") {
      throw new RouteError(`${ctx.merchant.name} prohibits automated agents; not using computer-use`, { retriable: true });
    }
    const item = input.items[0];
    if (input.items.length !== 1 || !item.productUrl) {
      throw new RouteError("computer-use route takes exactly one product URL", { retriable: true });
    }
    const base: Checkout = {
      id: input.id,
      merchantId: ctx.merchant.id,
      route: "computer_use",
      remoteId: "",
      status: "requires_action",
      currency: "USD",
      lineItems: [
        { id: "li_1", productId: item.productUrl, title: item.productUrl, quantity: item.quantity, unitPrice: { amount: 0, currency: "USD" }, total: { amount: 0, currency: "USD" } },
      ],
      totals: { total: 0 },
      fulfillmentOptions: [],
      messages: [],
      continueUrl: item.productUrl,
      state: { buyer: input.buyer, shipTo: input.shipTo },
    };
    const url = runner();
    if (!url) {
      return {
        ...base,
        messages: [
          `${ctx.merchant.name} has no agent API and no computer-use runner is configured. ` +
            `Open continueUrl to buy ${item.quantity} x this item manually, or set COMPUTER_USE_RUNNER_URL.`,
        ],
      };
    }
    const raw = await requestJson(`${url}/tasks`, {
      body: {
        task: "checkout",
        merchant: { id: ctx.merchant.id, name: ctx.merchant.name, domains: ctx.merchant.domains },
        productUrl: item.productUrl,
        quantity: item.quantity,
        buyer: input.buyer,
        shipTo: input.shipTo,
      },
      idempotent: true,
      timeoutMs: 120_000,
    });
    return map(base, raw);
  },

  async get(_ctx, co) {
    const url = runner();
    if (!url || !co.remoteId) return co;
    return map(co, await requestJson(`${url}/tasks/${co.remoteId}`));
  },

  async update() {
    throw new RouteError("computer-use checkouts can't be edited; cancel and create a new one");
  },

  async complete(_ctx, co, grant) {
    const url = runner();
    if (!url) throw new RouteError("no computer-use runner configured");
    const raw = await requestJson(`${url}/tasks/${co.remoteId}/confirm`, {
      body: { authorization: { maxAmount: grant.maxAmount, currency: grant.currency, expiresAt: grant.expiresAt } },
      idempotent: true,
      timeoutMs: 180_000,
    });
    return map(co, raw);
  },

  async cancel(_ctx, co) {
    return { ...co, status: "canceled" };
  },
};
