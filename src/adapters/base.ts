import type {
  Address,
  Buyer,
  Checkout,
  CheckoutUpdate,
  Merchant,
  PaymentGrant,
  PaymentKind,
  Product,
  Protocol,
  RouteConfig,
} from "../types.ts";

export interface AdapterContext {
  merchant: Merchant;
  route: RouteConfig;
}

export interface ResolvedItem {
  /** Merchant-side variant / item id (native routes). */
  variantId?: string;
  /** Product page URL (universal routes). */
  productUrl?: string;
  quantity: number;
}

export interface CreateInput {
  id: string; // router checkout id
  items: ResolvedItem[];
  buyer?: Buyer;
  shipTo?: Address;
}

/** One implementation per wire protocol. Adapters are stateless; per-checkout state lives on Checkout.state. */
export interface MerchantAdapter {
  protocol: Protocol;
  /** True if the route drives a real browser (affects dataPolicy filtering). */
  automation: boolean;
  /** Which payment grant kind this route needs for this merchant (UCP reads it from discovery). */
  paymentKind(ctx: AdapterContext, co: Checkout): Promise<PaymentKind>;
  search?(ctx: AdapterContext, query: string, limit: number): Promise<Product[]>;
  create(ctx: AdapterContext, input: CreateInput): Promise<Checkout>;
  get(ctx: AdapterContext, co: Checkout): Promise<Checkout>;
  update(ctx: AdapterContext, co: Checkout, upd: CheckoutUpdate): Promise<Checkout>;
  complete(ctx: AdapterContext, co: Checkout, grant: PaymentGrant): Promise<Checkout>;
  cancel(ctx: AdapterContext, co: Checkout): Promise<Checkout>;
}

export function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}
