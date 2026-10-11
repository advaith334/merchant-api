// Spins up one of each kind of merchant locally and a Router wired to them.
// Used by the demo and the tests; moves no money and touches no real merchant.
import { Guardrails } from "../src/guardrails.ts";
import { TestPaymentProvider } from "../src/payments.ts";
import { Registry } from "../src/registry.ts";
import { Router } from "../src/router.ts";
import { clearDiscoveryCache } from "../src/adapters/ucp.ts";
import type { Merchant } from "../src/types.ts";
import { startAcpMerchant } from "./acp-merchant.ts";
import { startRunnerMock, startRyeMock } from "./gap-fillers.ts";
import { startUcpMerchant } from "./ucp-merchant.ts";

export async function startSandbox(policy?: Partial<ConstructorParameters<typeof Guardrails>[0]>) {
  const trail = await startUcpMerchant({
    name: "Trail Co",
    transport: "rest",
    handlers: { "com.stripe.payments": [{ id: "stripe" }] },
    catalog: [
      { id: "tc-shoe-1", title: "Ridge Runner trail running shoes", price: 12900, tags: ["running", "shoes", "trail"] },
      { id: "tc-jacket", title: "Stormline rain jacket", price: 18900, tags: ["jacket", "rain"] },
      { id: "tc-socks", title: "Merino running socks (3 pack)", price: 2400, tags: ["running", "socks"] },
    ],
  });
  const sneakers = await startUcpMerchant({
    name: "Sneaker Hub",
    transport: "mcp", // what Shopify actually ships
    handlers: { "dev.shopify.shop_pay": [{ id: "shop_pay" }], "com.google.pay": [{ id: "gpay" }] },
    catalog: [
      { id: "gid://shopify/ProductVariant/101", title: "Tree Dasher running shoes", price: 13500, tags: ["running", "shoes"] },
      { id: "gid://shopify/ProductVariant/102", title: "Wool Lounger", price: 9800, tags: ["shoes"] },
    ],
  });
  const volt = await startAcpMerchant({
    name: "Volt Gear",
    apiKey: "acp_test_key",
    catalog: [
      { id: "vg-watch", title: "Pace GPS running watch", price: 24900, tags: ["running", "watch"] },
      { id: "vg-buds", title: "Sprint wireless earbuds", price: 7900, tags: ["running", "earbuds", "headphones"] },
    ],
  });
  const rye = await startRyeMock("rye_test_key");
  const runner = await startRunnerMock();

  Object.assign(process.env, {
    VOLT_ACP_KEY: "acp_test_key",
    RYE_API_KEY: "rye_test_key",
    RYE_BASE_URL: rye.url,
    RYE_POLL_MS: "20",
    COMPUTER_USE_RUNNER_URL: runner.url,
  });
  clearDiscoveryCache();

  const merchants: Merchant[] = [
    { id: "trailco", name: "Trail Co", domains: ["trailco.test"], region: "US", routes: [{ protocol: "ucp", profileUrl: `${trail.url}/.well-known/ucp`, stripeProfile: "profile_test_trailco" }, { protocol: "rye" }] },
    { id: "sneakerhub", name: "Sneaker Hub (Shopify)", domains: ["sneakerhub.test"], region: "US", routes: [{ protocol: "ucp", profileUrl: `${sneakers.url}/.well-known/ucp` }] },
    { id: "voltgear", name: "Volt Gear", domains: ["voltgear.test"], region: "EU", routes: [{ protocol: "acp", baseUrl: volt.url, apiKeyEnv: "VOLT_ACP_KEY", feedUrl: `${volt.url}/feed.json`, stripeProfile: "profile_test_volt" }] },
    // Target publishes no public UCP profile yet: discovery 404s and the router falls back to Rye.
    { id: "target", name: "Target", domains: ["target.com"], region: "US", routes: [{ protocol: "ucp", profileUrl: `${trail.url}/missing/.well-known/ucp` }, { protocol: "rye" }, { protocol: "computer_use" }] },
    { id: "amazon", name: "Amazon", domains: ["amazon.com"], region: "US", agentPolicy: "prohibited", routes: [{ protocol: "rye" }, { protocol: "computer_use" }] },
    { id: "bestbuy", name: "Best Buy", domains: ["bestbuy.com"], region: "US", routes: [{ protocol: "rye" }, { protocol: "computer_use" }] },
  ];

  const guardrails = new Guardrails({ currency: "USD", maxPerOrder: 500_00, maxPerDay: 1000_00, approvalAbove: 200_00, ...policy });
  const router = new Router({ registry: new Registry(merchants), payments: new TestPaymentProvider(), guardrails });

  return {
    router,
    urls: { trail: trail.url, sneakers: sneakers.url, volt: volt.url, rye: rye.url, runner: runner.url },
    stopTrail: () => new Promise<void>((r) => trail.server.close(() => r())),
    close: async () => {
      for (const s of [trail.server, sneakers.server, volt.server, rye.server, runner.server]) {
        s.closeAllConnections();
        s.close();
      }
    },
  };
}

export const BUYER = { email: "shopper@example.com", firstName: "Sam", lastName: "Shopper", phone: "+15555550100" };
export const SHIP_TO = { name: "Sam Shopper", line1: "500 W 37th St", line2: "Apt 18B", city: "New York", region: "NY", postalCode: "10018", country: "US", phone: "+15555550100" };
