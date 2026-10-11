// End-to-end demo against local mock merchants (no real money, no real stores):
//   node scripts/demo.ts
import { BUYER, SHIP_TO, startSandbox } from "../mock/sandbox.ts";
import { fmt } from "../src/guardrails.ts";
import type { Checkout } from "../src/types.ts";

const c = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", cy: "\x1b[36m", x: "\x1b[0m" };
const h = (s: string) => console.log(`\n${c.b}${c.cy}▸ ${s}${c.x}`);
const line = (co: Checkout) => {
  const color = co.status === "completed" ? c.g : co.status === "failed" ? c.r : c.y;
  const route = (co.routeAttempts ?? []).map((a) => `${a.ok ? "✓" : "✗"}${a.protocol}`).join(" → ");
  console.log(`  ${c.dim}${co.id}${c.x}  merchant=${co.merchantId}  route=${c.b}${co.route}${c.x}  ${c.dim}[${route}]${c.x}`);
  console.log(`  status=${color}${co.status}${c.x}  total=${fmt(co.totals.total)}${co.order ? `  order=${co.order.id}` : ""}`);
  for (const m of co.messages) console.log(`  ${c.dim}› ${m}${c.x}`);
};

const sb = await startSandbox();
const r = sb.router;
try {
  h('Agent: "find me running gear" — one search, three protocols');
  const { products } = await r.search("running", { limit: 3 });
  for (const p of products) console.log(`  ${p.route.padEnd(4)} ${p.merchantName.padEnd(22)} ${fmt(p.price.amount).padStart(8)}  ${p.title}  ${c.dim}${p.id}${c.x}`);

  h("Buy trail shoes from a UCP merchant (REST), upgrade to express, pay with a scoped Stripe SPT");
  let co = await r.createCheckout({ items: [{ productId: "trailco:tc-shoe-1", quantity: 1 }], buyer: BUYER, shipTo: SHIP_TO });
  co = await r.updateCheckout(co.id, { fulfillmentOptionId: "express" });
  co = await r.completeCheckout(co.id);
  line(co);

  h("Buy from a Shopify store (UCP over MCP) that only takes Shop Pay / Google Pay");
  co = await r.createCheckout({ items: [{ productId: "sneakerhub:gid://shopify/ProductVariant/101", quantity: 1 }], buyer: BUYER, shipTo: SHIP_TO });
  co = await r.completeCheckout(co.id);
  line(co);
  console.log(`  ${c.dim}continueUrl: ${co.continueUrl}${c.x}`);

  h("Buy earbuds from an ACP merchant (OpenAI/Stripe protocol): address missing → fixed → paid");
  co = await r.createCheckout({ items: [{ productId: "voltgear:vg-buds", quantity: 1 }], buyer: BUYER });
  line(co);
  co = await r.updateCheckout(co.id, { shipTo: SHIP_TO });
  co = await r.completeCheckout(co.id);
  line(co);

  h("Target has no public agent API: UCP discovery fails, router falls back to universal checkout");
  co = await r.createCheckout({ items: [{ productUrl: "https://www.target.com/p/desk-lamp/-/A-12345", quantity: 2 }], buyer: BUYER, shipTo: SHIP_TO });
  co = await r.completeCheckout(co.id);
  line(co);

  h("Best Buy via a computer-use runner (prefs: only computer_use)");
  co = await r.createCheckout({
    items: [{ productUrl: "https://www.bestbuy.com/site/headphones/123.p", quantity: 1 }],
    buyer: BUYER,
    shipTo: SHIP_TO,
    prefs: { only: ["computer_use"] },
  });
  co = await r.completeCheckout(co.id);
  line(co);

  h("Amazon prohibits automated agents: computer-use is never a route for it");
  console.log(`  routes for amazon: ${r.routesFor(r.registry.get("amazon")!).map((x) => x.protocol).join(", ")}`);

  h("$271 GPS watch is over the $200 auto-approve limit → needs a human");
  co = await r.createCheckout({ items: [{ productId: "voltgear:vg-watch", quantity: 1 }], buyer: BUYER, shipTo: SHIP_TO });
  co = await r.completeCheckout(co.id);
  line(co);
  console.log(`  ${c.dim}(human approves ${co.approvalId} with the admin key)${c.x}`);
  r.guardrails.decide(co.approvalId!, true);
  co = await r.completeCheckout(co.id);
  line(co);

  h("Native merchant goes down mid-day: same product, router reroutes to universal checkout");
  await r.search("socks", { merchants: ["trailco"] });
  await sb.stopTrail();
  co = await r.createCheckout({ items: [{ productId: "trailco:tc-socks", quantity: 1 }], buyer: BUYER, shipTo: SHIP_TO });
  line(co);

  h("Route health (EWMA latency, failures) — what latency-sorted routing uses");
  for (const [k, v] of Object.entries(r.routeHealth())) console.log(`  ${k.padEnd(26)} ${String(v.ewmaMs).padStart(4)}ms  ok=${v.ok} failed=${v.failed}`);
  console.log(`\n  spent today: ${fmt(r.guardrails.spentToday())} of ${fmt(r.guardrails.policy.maxPerDay)} cap\n`);
} finally {
  await sb.close();
}
