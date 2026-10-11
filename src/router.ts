// The router: one API in front of every merchant protocol, OpenRouter-style.
//  - search fans out to every merchant with a searchable route and merges results
//  - createCheckout picks a route per merchant (native protocol first, then
//    gap-fillers), falls back on failure, and pins the checkout to the winning route
//  - completeCheckout runs guardrails, mints a scoped payment credential, and pays
import { randomUUID } from "node:crypto";
import type { AdapterContext, MerchantAdapter, ResolvedItem } from "./adapters/base.ts";
import { acpAdapter } from "./adapters/acp.ts";
import { computerUseAdapter } from "./adapters/computer-use.ts";
import { ryeAdapter } from "./adapters/rye.ts";
import { ucpAdapter } from "./adapters/ucp.ts";
import type { Guardrails } from "./guardrails.ts";
import { fmt } from "./guardrails.ts";
import type { PaymentProvider } from "./payments.ts";
import type { Registry } from "./registry.ts";
import type {
  Checkout,
  CheckoutRequest,
  CheckoutUpdate,
  Merchant,
  Product,
  Protocol,
  RouteAttempt,
  RouteConfig,
  RoutingPrefs,
} from "./types.ts";
import { RouteError } from "./types.ts";

export const DEFAULT_ADAPTERS: Record<Protocol, MerchantAdapter> = {
  ucp: ucpAdapter,
  acp: acpAdapter,
  rye: ryeAdapter,
  computer_use: computerUseAdapter,
};

interface Health {
  ewmaMs: number;
  consecutiveFailures: number;
  lastFailureAt: number;
  ok: number;
  failed: number;
}

const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 60_000;

export interface RouterOpts {
  registry: Registry;
  payments: PaymentProvider;
  guardrails: Guardrails;
  adapters?: Partial<Record<Protocol, MerchantAdapter>>;
}

export class Router {
  registry: Registry;
  payments: PaymentProvider;
  guardrails: Guardrails;
  adapters: Record<Protocol, MerchantAdapter>;
  checkouts = new Map<string, Checkout>();
  products = new Map<string, Product>(); // search results, so a product id can fall back to its URL
  health = new Map<string, Health>();

  constructor(opts: RouterOpts) {
    this.registry = opts.registry;
    this.payments = opts.payments;
    this.guardrails = opts.guardrails;
    this.adapters = { ...DEFAULT_ADAPTERS, ...opts.adapters };
  }

  // ---------------------------------------------------------------- routing

  /** Candidate routes for a merchant, filtered and ordered by prefs and health. */
  routesFor(m: Merchant, prefs: RoutingPrefs = {}): RouteConfig[] {
    let routes = m.routes.filter((r) => {
      const a = this.adapters[r.protocol];
      if (!a) return false;
      if (prefs.only && !prefs.only.includes(r.protocol)) return false;
      if (prefs.ignore?.includes(r.protocol)) return false;
      if (prefs.dataPolicy === "deny_automation" && a.automation) return false;
      if (r.protocol === "computer_use" && m.agentPolicy === "prohibited") return false;
      return true;
    });
    if (prefs.only) routes.sort((a, b) => prefs.only!.indexOf(a.protocol) - prefs.only!.indexOf(b.protocol));
    if (prefs.sort === "latency") {
      routes.sort((a, b) => (this.healthOf(m, a.protocol)?.ewmaMs ?? 1e9) - (this.healthOf(m, b.protocol)?.ewmaMs ?? 1e9));
    }
    // Circuit breaker: push recently-failing routes to the back instead of dropping them.
    const tripped = (r: RouteConfig) => {
      const h = this.healthOf(m, r.protocol);
      return !!h && h.consecutiveFailures >= BREAKER_FAILURES && Date.now() - h.lastFailureAt < BREAKER_COOLDOWN_MS;
    };
    routes = [...routes.filter((r) => !tripped(r)), ...routes.filter(tripped)];
    if (prefs.allowFallbacks === false) routes = routes.slice(0, 1);
    return routes;
  }

  healthOf(m: Merchant, p: Protocol): Health | undefined {
    return this.health.get(`${m.id}:${p}`);
  }

  private observe(m: Merchant, p: Protocol, ms: number, ok: boolean) {
    const key = `${m.id}:${p}`;
    const h = this.health.get(key) ?? { ewmaMs: ms, consecutiveFailures: 0, lastFailureAt: 0, ok: 0, failed: 0 };
    h.ewmaMs = 0.7 * h.ewmaMs + 0.3 * ms;
    if (ok) {
      h.ok++;
      h.consecutiveFailures = 0;
    } else {
      h.failed++;
      h.consecutiveFailures++;
      h.lastFailureAt = Date.now();
    }
    this.health.set(key, h);
  }

  private async timed<T>(m: Merchant, p: Protocol, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      const out = await fn();
      this.observe(m, p, performance.now() - t0, true);
      return out;
    } catch (err) {
      // Business errors (4xx, bad input) say nothing about route health.
      const infra = !(err instanceof RouteError) || err.retriable;
      if (infra) this.observe(m, p, performance.now() - t0, false);
      throw err;
    }
  }

  private ctx(m: Merchant, protocol: Protocol): AdapterContext {
    const route = m.routes.find((r) => r.protocol === protocol);
    if (!route) throw new RouteError(`merchant ${m.id} has no ${protocol} route`);
    return { merchant: m, route };
  }

  // ----------------------------------------------------------------- search

  async search(
    query: string,
    opts: { merchants?: string[]; limit?: number; prefs?: RoutingPrefs } = {},
  ): Promise<{ products: Product[]; errors: Array<{ merchantId: string; error: string }> }> {
    const limit = opts.limit ?? 10;
    const merchants = (opts.merchants?.length ? opts.merchants.map((id) => this.mustMerchant(id)) : this.registry.list()).filter(
      (m) => (!opts.prefs?.region || m.region === opts.prefs.region) && this.guardrails.merchantAllowed(m).ok,
    );
    const errors: Array<{ merchantId: string; error: string }> = [];
    const perMerchant = await Promise.all(
      merchants.map(async (m) => {
        for (const r of this.routesFor(m, opts.prefs)) {
          const a = this.adapters[r.protocol];
          if (!a.search) continue;
          try {
            return await this.timed(m, r.protocol, () => a.search!({ merchant: m, route: r }, query, limit));
          } catch (err) {
            errors.push({ merchantId: m.id, error: `${r.protocol}: ${(err as Error).message}` });
          }
        }
        return [] as Product[];
      }),
    );
    // Interleave merchants so one big catalog doesn't crowd out the rest.
    const products: Product[] = [];
    for (let i = 0; products.length < limit * merchants.length; i++) {
      const row = perMerchant.map((list) => list[i]).filter(Boolean);
      if (!row.length) break;
      products.push(...row);
    }
    for (const p of products) this.products.set(p.id, p);
    return { products, errors };
  }

  // -------------------------------------------------------------- checkouts

  private mustMerchant(id: string): Merchant {
    const m = this.registry.get(id);
    if (!m) throw new RouteError(`unknown merchant ${id}`);
    return m;
  }

  private mustCheckout(id: string): Checkout {
    const co = this.checkouts.get(id);
    if (!co) throw new RouteError(`unknown checkout ${id}`, { status: 404 });
    return co;
  }

  /** Which merchant a request targets. All items in one checkout must share a merchant. */
  private merchantFor(req: CheckoutRequest): Merchant {
    const ids = new Set<string>();
    for (const it of req.items) {
      if (it.productId) ids.add(this.mustMerchant(it.productId.split(":")[0]).id);
      else if (it.productUrl) ids.add(this.registry.forUrl(it.productUrl).id);
      else throw new RouteError("each item needs productId or productUrl");
    }
    if (ids.size !== 1) throw new RouteError("one checkout per merchant; split items by merchant");
    return this.mustMerchant([...ids][0]);
  }

  /** Translate request items for a given route, or explain why the route can't take them. */
  private resolveItems(req: CheckoutRequest, protocol: Protocol): ResolvedItem[] {
    const native = protocol === "ucp" || protocol === "acp";
    return req.items.map((it) => {
      if (native) {
        if (!it.productId) throw new RouteError(`${protocol} needs a productId from search`, { retriable: true });
        return { variantId: it.productId.split(":").slice(1).join(":"), quantity: it.quantity };
      }
      const url = it.productUrl ?? (it.productId ? this.products.get(it.productId)?.url : undefined);
      if (!url) throw new RouteError(`${protocol} needs a product URL`, { retriable: true });
      return { productUrl: url, quantity: it.quantity };
    });
  }

  async createCheckout(req: CheckoutRequest): Promise<Checkout> {
    if (!req.items?.length) throw new RouteError("items required");
    for (const it of req.items) {
      if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new RouteError("quantity must be a positive integer");
    }
    const m = this.merchantFor(req);
    const allowed = this.guardrails.merchantAllowed(m);
    if (!allowed.ok) throw new RouteError(allowed.reason);
    if (req.prefs?.region && m.region !== req.prefs.region) {
      throw new RouteError(`${m.name} is not hosted in region ${req.prefs.region}`);
    }

    const routes = this.routesFor(m, req.prefs);
    if (!routes.length) throw new RouteError(`no route to ${m.name} satisfies these routing preferences`);
    const attempts: RouteAttempt[] = [];
    const id = "co_" + randomUUID().replace(/-/g, "").slice(0, 20);

    for (const r of routes) {
      const t0 = performance.now();
      try {
        const items = this.resolveItems(req, r.protocol);
        const co = await this.timed(m, r.protocol, () =>
          this.adapters[r.protocol].create({ merchant: m, route: r }, { id, items, buyer: req.buyer, shipTo: req.shipTo }),
        );
        attempts.push({ protocol: r.protocol, ok: true, ms: Math.round(performance.now() - t0) });
        co.routeAttempts = attempts;
        this.checkouts.set(id, co);
        return co;
      } catch (err) {
        const e = err as Error;
        attempts.push({ protocol: r.protocol, ok: false, ms: Math.round(performance.now() - t0), error: e.message });
        // The merchant rejected the request itself (bad item id, out of stock): don't shop it around.
        if (e instanceof RouteError && !e.retriable && e.status && e.status < 500) {
          throw Object.assign(new RouteError(e.message, { status: e.status }), { attempts });
        }
      }
    }
    throw Object.assign(new RouteError(`all routes to ${m.name} failed`, { status: 502 }), { attempts });
  }

  async getCheckout(id: string): Promise<Checkout> {
    const co = this.mustCheckout(id);
    if (["completed", "canceled", "failed"].includes(co.status)) return co;
    const m = this.mustMerchant(co.merchantId);
    const next = await this.timed(m, co.route, () => this.adapters[co.route].get(this.ctx(m, co.route), co));
    return this.save(co, next);
  }

  async updateCheckout(id: string, upd: CheckoutUpdate): Promise<Checkout> {
    const co = this.mustCheckout(id);
    if (["completed", "canceled", "processing"].includes(co.status)) throw new RouteError(`checkout is ${co.status}`);
    const m = this.mustMerchant(co.merchantId);
    const next = await this.timed(m, co.route, () => this.adapters[co.route].update(this.ctx(m, co.route), co, upd));
    return this.save(co, next);
  }

  async cancelCheckout(id: string): Promise<Checkout> {
    const co = this.mustCheckout(id);
    if (co.status === "completed") throw new RouteError("checkout already completed; use the merchant's return flow");
    const m = this.mustMerchant(co.merchantId);
    const next = await this.adapters[co.route].cancel(this.ctx(m, co.route), co);
    return this.save(co, next);
  }

  async completeCheckout(id: string): Promise<Checkout> {
    let co = this.mustCheckout(id);
    if (co.status === "completed") return co;
    const m = this.mustMerchant(co.merchantId);
    const adapter = this.adapters[co.route];
    const ctx = this.ctx(m, co.route);

    // Refresh first so guardrails see the merchant's current total, not a stale quote.
    co = this.save(co, await this.timed(m, co.route, () => adapter.get(ctx, co)));
    if (co.status !== "ready" && co.status !== "requires_approval") {
      throw new RouteError(`checkout is ${co.status}, not ready: ${co.messages.join("; ") || "add buyer, shipTo or shipping option"}`);
    }

    const kind = await adapter.paymentKind(ctx, co);
    if (kind === "handoff") {
      return this.save(co, {
        ...co,
        status: "requires_action",
        messages: [
          `${m.name} only accepts wallet payments (e.g. Shop Pay / Google Pay) that need the buyer present. ` +
            `Cart is ready: open continueUrl to pay ${fmt(co.totals.total)}.`,
        ],
      });
    }

    const verdict = this.guardrails.checkSpend(co, m);
    if (!verdict.ok) {
      if ("approval" in verdict) {
        return this.save(co, {
          ...co,
          status: "requires_approval",
          approvalId: verdict.approval.id,
          messages: [`${fmt(co.totals.total)} is above the auto-approve limit. A human must approve ${verdict.approval.id}, then call complete again.`],
        });
      }
      throw new RouteError(`blocked by spend policy: ${verdict.reason}`, { status: 403 });
    }

    const r = ctx.route as { stripeProfile?: string };
    const grant = await this.payments.mint({
      merchant: m,
      route: co.route,
      kind,
      maxAmount: co.totals.total,
      currency: co.currency,
      sellerProfile: r.stripeProfile,
    });
    const done = await this.timed(m, co.route, () => adapter.complete(ctx, { ...co, status: "ready" }, grant));
    if (done.status === "completed" || done.status === "processing") this.guardrails.record(done.totals.total || co.totals.total);
    return this.save(co, done);
  }

  private save(prev: Checkout, next: Checkout): Checkout {
    const merged: Checkout = { ...next, id: prev.id, routeAttempts: prev.routeAttempts };
    if (next.status !== "requires_approval") delete merged.approvalId;
    this.checkouts.set(prev.id, merged);
    return merged;
  }

  /** What the agent sees: no adapter-private state. */
  static view(co: Checkout) {
    const { state: _state, ...rest } = co;
    return rest;
  }

  routeHealth() {
    return Object.fromEntries([...this.health.entries()].map(([k, h]) => [k, { ...h, ewmaMs: Math.round(h.ewmaMs) }]));
  }
}
