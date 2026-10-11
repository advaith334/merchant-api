// Unified commerce model. Every adapter translates its wire protocol (UCP, ACP,
// Rye, computer-use) into these shapes so the agent sees one API.
// All money is integer minor units (cents) + ISO 4217 currency, matching both
// UCP (amount.json) and ACP (Total.amount).

export type Protocol = "ucp" | "acp" | "rye" | "computer_use";

export interface Money {
  amount: number;
  currency: string;
}

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string; // state / province
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2
  phone?: string;
}

export interface Buyer {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/** A merchant the router knows how to reach, and the routes it can use. */
export interface Merchant {
  id: string;
  name: string;
  domains: string[];
  region?: string; // where the merchant's API is hosted, e.g. "US", "EU"
  /** Ordered list of routes. The router tries native protocols before gap-fillers. */
  routes: RouteConfig[];
  /** "prohibited" = merchant forbids automated browsing; computer_use is never used. */
  agentPolicy?: "allowed" | "prohibited" | "unknown";
  notes?: string;
}

export type RouteConfig =
  | { protocol: "ucp"; profileUrl?: string; authEnv?: string; stripeProfile?: string }
  | {
      protocol: "acp";
      baseUrl: string;
      apiKeyEnv: string; // env var holding the bearer key the merchant issued to this router
      feedUrl?: string; // product feed (JSON) used for search
      apiVersion?: string;
      stripeProfile?: string; // seller's Stripe network business profile, for SPTs
    }
  | { protocol: "rye" }
  | { protocol: "computer_use" };

export interface Product {
  /** Router-scoped id: "<merchantId>:<variantId>". Pass this back to createCheckout. */
  id: string;
  merchantId: string;
  merchantName: string;
  title: string;
  price: Money;
  url?: string;
  image?: string;
  available?: boolean;
  route: Protocol;
}

export interface LineItem {
  id: string;
  productId: string;
  title: string;
  quantity: number;
  unitPrice: Money;
  total: Money;
}

export interface FulfillmentOption {
  id: string;
  title: string;
  price: Money;
  /** Opaque adapter data needed to select this option (e.g. UCP group id). */
  ref?: Record<string, string>;
}

export type CheckoutStatus =
  | "needs_info" // merchant needs buyer / address / shipping choice
  | "ready" // can be completed
  | "requires_approval" // guardrail: a human must approve before payment
  | "requires_action" // merchant/agent needs a human (3DS, sign-in, manual handoff)
  | "processing"
  | "completed"
  | "failed"
  | "canceled";

export interface Checkout {
  id: string; // router id
  merchantId: string;
  route: Protocol;
  remoteId: string; // id on the merchant / provider side
  status: CheckoutStatus;
  currency: string;
  lineItems: LineItem[];
  totals: { subtotal?: number; shipping?: number; tax?: number; discount?: number; total: number };
  fulfillmentOptions: FulfillmentOption[];
  selectedFulfillmentOptionId?: string;
  messages: string[];
  continueUrl?: string;
  order?: { id: string; url?: string };
  approvalId?: string;
  routeAttempts?: RouteAttempt[];
  /** Adapter-private state carried between calls (never shown to the agent). */
  state?: Record<string, unknown>;
}

export interface RouteAttempt {
  protocol: Protocol;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface CheckoutRequest {
  /** Router product ids from search, or a raw product URL for universal routes. */
  items: Array<{ productId?: string; productUrl?: string; quantity: number }>;
  buyer?: Buyer;
  shipTo?: Address;
  prefs?: RoutingPrefs;
}

export interface CheckoutUpdate {
  buyer?: Buyer;
  shipTo?: Address;
  fulfillmentOptionId?: string;
}

/** OpenRouter-style routing preferences. */
export interface RoutingPrefs {
  /** Only use these protocols (in this order of preference). */
  only?: Protocol[];
  /** Never use these protocols. */
  ignore?: Protocol[];
  /** Try the next route if one fails. Default true. */
  allowFallbacks?: boolean;
  /** "native" = protocol order (default); "latency" = fastest healthy route first. */
  sort?: "native" | "latency";
  /** "deny_automation" excludes routes that drive a browser (rye, computer_use). */
  dataPolicy?: "allow_all" | "deny_automation";
  /** Only route to merchants whose API is hosted in this region. */
  region?: string;
}

/**
 * How a route gets paid:
 *  stripe_spt            Stripe Shared Payment Token scoped to one seller + amount (ACP, UCP Stripe handler)
 *  stripe_token          Stripe card token (Rye)
 *  rye_drawdown          prepaid Rye balance
 *  runner_authorization  spend cap for a computer-use runner that holds its own virtual card
 *  test                  sandbox token, moves no money
 *  handoff               router cannot pay; a human finishes at the merchant's continue_url
 */
export type PaymentKind = "stripe_spt" | "stripe_token" | "rye_drawdown" | "runner_authorization" | "test" | "handoff";

/** A scoped, single-use payment credential minted for one checkout. Never a raw PAN. */
export interface PaymentGrant {
  kind: Exclude<PaymentKind, "handoff">;
  token?: string;
  maxAmount: number;
  currency: string;
  expiresAt: string;
}

export class RouteError extends Error {
  retriable: boolean;
  status?: number;
  constructor(message: string, opts: { retriable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "RouteError";
    this.retriable = opts.retriable ?? false;
    this.status = opts.status;
  }
}
