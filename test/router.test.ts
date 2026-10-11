import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { BUYER, SHIP_TO, startSandbox } from "../mock/sandbox.ts";
import { Guardrails } from "../src/guardrails.ts";
import { createHttpServer } from "../src/server.ts";
import type { PaymentGrant } from "../src/types.ts";

type Sandbox = Awaited<ReturnType<typeof startSandbox>>;

describe("merchant router", () => {
  let sb: Sandbox;
  const minted: PaymentGrant[] = [];

  before(async () => {
    sb = await startSandbox({ maxPerDay: 5000_00 });
    const orig = sb.router.payments.mint.bind(sb.router.payments);
    sb.router.payments.mint = async (req) => {
      const g = await orig(req);
      minted.push(g);
      return g;
    };
  });
  after(() => sb.close());

  test("search fans out across UCP REST, UCP MCP and ACP feeds", async () => {
    const { products, errors } = await sb.router.search("running", { merchants: ["trailco", "sneakerhub", "voltgear"] });
    assert.deepEqual(errors, []);
    const merchants = new Set(products.map((p) => p.merchantId));
    assert.deepEqual([...merchants].sort(), ["sneakerhub", "trailco", "voltgear"]);
    const shoe = products.find((p) => p.id === "trailco:tc-shoe-1")!;
    assert.equal(shoe.price.amount, 12900);
    assert.equal(shoe.route, "ucp");
  });

  test("UCP (REST): create -> pick shipping -> pay with a scoped Stripe SPT", async () => {
    let co = await sb.router.createCheckout({ items: [{ productId: "trailco:tc-shoe-1", quantity: 1 }], buyer: BUYER, shipTo: SHIP_TO });
    assert.equal(co.route, "ucp");
    assert.equal(co.status, "ready");
    assert.equal(co.totals.total, 12900 + 500 + 1032);
    co = await sb.router.updateCheckout(co.id, { fulfillmentOptionId: "express" });
    assert.equal(co.selectedFulfillmentOptionId, "express");
    assert.equal(co.totals.shipping, 1500);
    co = await sb.router.completeCheckout(co.id);
    assert.equal(co.status, "completed");
    assert.match(co.order!.id, /^ord_/);
    const g = minted.at(-1)!;
    assert.equal(g.kind, "stripe_spt");
    assert.match(g.token!, /^spt_test_/);
    assert.equal(g.maxAmount, co.totals.total, "credential is capped at the exact total");
  });

  test("UCP (MCP, Shopify-style) with wallet-only payments hands off to the human", async () => {
    let co = await sb.router.createCheckout({
      items: [{ productId: "sneakerhub:gid://shopify/ProductVariant/101", quantity: 2 }],
      buyer: BUYER,
      shipTo: SHIP_TO,
    });
    assert.equal(co.status, "ready");
    assert.equal(co.lineItems[0].quantity, 2);
    const before = minted.length;
    co = await sb.router.completeCheckout(co.id);
    assert.equal(co.status, "requires_action");
    assert.match(co.continueUrl!, /\/checkouts\//);
    assert.equal(minted.length, before, "no credential minted for a handoff");
  });

  test("ACP: needs address, then completes with an SPT", async () => {
    let co = await sb.router.createCheckout({ items: [{ productId: "voltgear:vg-buds", quantity: 2 }], buyer: BUYER });
    assert.equal(co.route, "acp");
    assert.equal(co.status, "needs_info");
    co = await sb.router.updateCheckout(co.id, { shipTo: SHIP_TO });
    assert.equal(co.status, "ready");
    assert.equal(co.lineItems[0].quantity, 2);
    assert.equal(co.totals.subtotal, 15800);
    co = await sb.router.completeCheckout(co.id);
    assert.equal(co.status, "completed");
  });

  test("merchant with no agent API: UCP discovery 404s, router falls back to Rye", async () => {
    let co = await sb.router.createCheckout({
      items: [{ productUrl: "https://www.target.com/p/some-lamp/-/A-12345", quantity: 1 }],
      buyer: BUYER,
      shipTo: SHIP_TO,
    });
    assert.equal(co.merchantId, "target");
    assert.equal(co.route, "rye");
    assert.deepEqual(co.routeAttempts!.map((a) => [a.protocol, a.ok]), [["ucp", false], ["rye", true]]);
    assert.equal(co.status, "ready");
    co = await sb.router.completeCheckout(co.id);
    assert.equal(co.status, "completed");
    assert.match(co.order!.id, /^rye_ord_/);
  });

  test("human approval is required above the auto-approve limit", async () => {
    let co = await sb.router.createCheckout({ items: [{ productId: "voltgear:vg-watch", quantity: 1 }], buyer: BUYER, shipTo: SHIP_TO });
    co = await sb.router.completeCheckout(co.id);
    assert.equal(co.status, "requires_approval");
    assert.ok(co.approvalId);
    // Calling complete again doesn't bypass it.
    co = await sb.router.completeCheckout(co.id);
    assert.equal(co.status, "requires_approval");
    sb.router.guardrails.decide(co.approvalId!, true);
    co = await sb.router.completeCheckout(co.id);
    assert.equal(co.status, "completed");
  });

  test("per-order cap blocks outright", async () => {
    const co = await sb.router.createCheckout({ items: [{ productId: "trailco:tc-jacket", quantity: 3 }], buyer: BUYER, shipTo: SHIP_TO });
    await assert.rejects(sb.router.completeCheckout(co.id), /per-order cap/);
  });

  test("daily cap counts completed orders", () => {
    const g = new Guardrails({ currency: "USD", maxPerOrder: 500_00, maxPerDay: 300_00, approvalAbove: 1000_00 });
    const m = sb.router.registry.get("trailco")!;
    const co: any = { id: "co_x", currency: "USD", totals: { total: 200_00 } };
    assert.deepEqual(g.checkSpend(co, m), { ok: true });
    g.record(200_00);
    const v = g.checkSpend(co, m);
    assert.ok(!v.ok && "reason" in v && /daily cap/.test(v.reason));
  });

  test("dataPolicy deny_automation never drives a browser", async () => {
    await assert.rejects(
      sb.router.createCheckout({
        items: [{ productUrl: "https://www.target.com/p/x", quantity: 1 }],
        buyer: BUYER,
        shipTo: SHIP_TO,
        prefs: { dataPolicy: "deny_automation" },
      }),
      (e: any) => e.attempts.length === 1 && e.attempts[0].protocol === "ucp",
    );
  });

  test("computer-use is never used for merchants that prohibit agents", () => {
    const amazon = sb.router.registry.get("amazon")!;
    assert.deepEqual(sb.router.routesFor(amazon).map((r) => r.protocol), ["rye"]);
    assert.deepEqual(sb.router.routesFor(amazon, { ignore: ["rye"] }), []);
  });

  test("computer-use runner fills the gap when asked for", async () => {
    let co = await sb.router.createCheckout({
      items: [{ productUrl: "https://www.bestbuy.com/site/some-tv/123.p", quantity: 1 }],
      buyer: BUYER,
      shipTo: SHIP_TO,
      prefs: { only: ["computer_use"] },
    });
    assert.equal(co.route, "computer_use");
    assert.equal(co.status, "ready");
    co = await sb.router.completeCheckout(co.id);
    assert.equal(co.status, "completed");
    assert.equal(minted.at(-1)!.kind, "runner_authorization");
  });

  test("HTTP API: agent key can buy but cannot approve its own spend", async () => {
    const server = createHttpServer(sb.router, { ROUTER_API_KEY: "agent_key", ROUTER_ADMIN_KEY: "admin_key" } as any);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (path: string, key: string, body?: unknown, method = body ? "POST" : "GET") =>
      fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    try {
      assert.equal((await call("/v1/merchants", "wrong")).status, 401);
      const profile = await fetch(base + "/.well-known/ucp");
      assert.match(profile.headers.get("content-type")!, /application\/json/);
      assert.ok((await profile.json()).ucp.capabilities["dev.ucp.shopping.checkout"]);

      const created = await call("/v1/checkouts", "agent_key", { items: [{ productId: "voltgear:vg-watch", quantity: 1 }], buyer: BUYER, shipTo: SHIP_TO });
      assert.equal(created.status, 201);
      const co = await created.json();
      assert.equal(co.state, undefined, "adapter state is not exposed");
      const pending = await (await call(`/v1/checkouts/${co.id}/complete`, "agent_key", {})).json();
      assert.equal(pending.status, "requires_approval");
      assert.equal((await call(`/v1/approvals/${pending.approvalId}/approve`, "agent_key", {})).status, 401);
      assert.equal((await call(`/v1/approvals/${pending.approvalId}/approve`, "admin_key", {})).status, 200);
      const done = await (await call(`/v1/checkouts/${co.id}/complete`, "agent_key", {})).json();
      assert.equal(done.status, "completed");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test("MCP server exposes the tools and proxies to the API", async () => {
    const server = createHttpServer(sb.router, { ROUTER_API_KEY: "agent_key" } as any);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/mcp.ts", import.meta.url))], {
      env: { ...process.env, MERCHANT_ROUTER_URL: base, MERCHANT_ROUTER_API_KEY: "agent_key" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const replies = new Map<number, any>();
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        replies.set(msg.id, msg);
      }
    });
    const rpc = async (id: number, method: string, params?: any) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      for (let t = 0; t < 200 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 25));
      return replies.get(id);
    };
    try {
      const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      assert.equal(init.result.serverInfo.name, "merchant-router");
      const list = await rpc(2, "tools/list");
      const names = list.result.tools.map((t: any) => t.name);
      assert.ok(names.includes("search_products") && names.includes("complete_checkout"));
      assert.ok(!names.some((n: string) => /approv/.test(n)), "no self-approval tool");
      const res = await rpc(3, "tools/call", { name: "search_products", arguments: { query: "earbuds", merchants: ["voltgear"] } });
      assert.equal(res.result.isError, false);
      assert.equal(JSON.parse(res.result.content[0].text).products[0].id, "voltgear:vg-buds");
    } finally {
      child.kill();
      server.closeAllConnections();
      server.close();
    }
  });

  test("native merchant down: falls back to universal checkout via the product URL", async () => {
    await sb.router.search("socks", { merchants: ["trailco"] }); // caches the product URL
    await sb.stopTrail();
    const co = await sb.router.createCheckout({ items: [{ productId: "trailco:tc-socks", quantity: 1 }], buyer: BUYER, shipTo: SHIP_TO });
    assert.equal(co.route, "rye");
    assert.equal(co.routeAttempts![0].protocol, "ucp");
    assert.equal(co.routeAttempts![0].ok, false);
  });
});
