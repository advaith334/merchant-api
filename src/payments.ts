import { randomBytes } from "node:crypto";
import type { Merchant, PaymentGrant, Protocol } from "./types.ts";
import { RouteError } from "./types.ts";

export interface MintRequest {
  merchant: Merchant;
  route: Protocol;
  kind: PaymentGrant["kind"];
  maxAmount: number;
  currency: string;
  /** Stripe network business profile of the seller (ACP/UCP Stripe handlers). */
  sellerProfile?: string;
}

/**
 * Mints a scoped credential for exactly one checkout. The agent never sees a
 * card number: it only ever holds a router checkout id, and the router hands
 * the merchant a token capped at the approved total that expires in minutes.
 */
export interface PaymentProvider {
  name: string;
  mint(req: MintRequest): Promise<PaymentGrant>;
}

const TTL_SECONDS = 15 * 60;

function expiry(): { iso: string; unix: number } {
  const unix = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return { iso: new Date(unix * 1000).toISOString(), unix };
}

/** Fake tokens for sandboxes and the bundled mock merchants. Moves no money. */
export class TestPaymentProvider implements PaymentProvider {
  name = "test";
  async mint(req: MintRequest): Promise<PaymentGrant> {
    const { iso } = expiry();
    const kind = req.kind;
    const prefix = kind === "stripe_spt" ? "spt_test_" : kind === "rye_drawdown" ? "" : "tok_test_";
    return {
      kind,
      token: kind === "rye_drawdown" ? undefined : prefix + randomBytes(8).toString("hex"),
      maxAmount: req.maxAmount,
      currency: req.currency,
      expiresAt: iso,
    };
  }
}

/**
 * Real money. Uses Stripe Shared Payment Tokens (agentic commerce, preview API
 * 2026-04-22) for ACP/UCP merchants, and Rye drawdown balance for Rye.
 *   STRIPE_SECRET_KEY      sk_live_... / sk_test_...
 *   STRIPE_PAYMENT_METHOD  pm_... saved for the end user
 */
export class StripePaymentProvider implements PaymentProvider {
  name = "stripe";
  secretKey: string;
  paymentMethod: string;
  constructor(secretKey: string, paymentMethod: string) {
    this.secretKey = secretKey;
    this.paymentMethod = paymentMethod;
  }

  async mint(req: MintRequest): Promise<PaymentGrant> {
    const { iso, unix } = expiry();
    if (req.kind === "rye_drawdown" || req.kind === "runner_authorization") {
      // The provider (Rye balance / runner's own virtual card) holds the funds; we only pass the cap.
      return { kind: req.kind, maxAmount: req.maxAmount, currency: req.currency, expiresAt: iso };
    }
    if (req.kind !== "stripe_spt") {
      throw new RouteError(`stripe provider cannot mint ${req.kind} for route ${req.route}`);
    }
    if (!req.sellerProfile) {
      throw new RouteError(`merchant ${req.merchant.id} has no Stripe network business profile configured`);
    }
    const form = new URLSearchParams({
      payment_method: this.paymentMethod,
      "seller_details[network_business_profile]": req.sellerProfile,
      "usage_limits[currency]": req.currency.toLowerCase(),
      "usage_limits[max_amount]": String(req.maxAmount),
      "usage_limits[expires_at]": String(unix),
      "shared_metadata[merchant]": req.merchant.id,
    });
    const res = await fetch("https://api.stripe.com/v1/shared_payment/issued_tokens", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const data: any = await res.json();
    if (!res.ok) throw new RouteError(`stripe: ${data?.error?.message ?? res.status}`);
    return { kind: "stripe_spt", token: data.id, maxAmount: req.maxAmount, currency: req.currency, expiresAt: iso };
  }
}

export function paymentProviderFromEnv(env = process.env): PaymentProvider {
  if (env.STRIPE_SECRET_KEY && env.STRIPE_PAYMENT_METHOD) {
    return new StripePaymentProvider(env.STRIPE_SECRET_KEY, env.STRIPE_PAYMENT_METHOD);
  }
  return new TestPaymentProvider();
}
