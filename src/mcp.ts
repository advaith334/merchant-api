// MCP server (stdio) that gives any agent (Claude Code, Claude Desktop, Cursor...)
// the router as shopping tools. It is a thin client over the HTTP API, so the
// agent only ever holds one router URL + key and never sees payment credentials.
//
//   claude mcp add merchant-router \
//     -e MERCHANT_ROUTER_URL=http://localhost:8787 -e MERCHANT_ROUTER_API_KEY=... \
//     -- node /path/to/merchant-router/src/mcp.ts
//
// There is deliberately no "approve" tool: spend approvals need the admin key.
import { createInterface } from "node:readline";
import { isMain } from "./util/main.ts";

const BASE = (process.env.MERCHANT_ROUTER_URL ?? "http://localhost:8787").replace(/\/$/, "");
const KEY = process.env.MERCHANT_ROUTER_API_KEY ?? process.env.ROUTER_API_KEY ?? "";

const address = {
  type: "object",
  required: ["name", "line1", "city", "region", "postalCode", "country"],
  properties: {
    name: { type: "string" },
    line1: { type: "string" },
    line2: { type: "string" },
    city: { type: "string" },
    region: { type: "string", description: "State / province code, e.g. CA" },
    postalCode: { type: "string" },
    country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. US" },
    phone: { type: "string" },
  },
};
const buyer = {
  type: "object",
  required: ["email"],
  properties: { email: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, phone: { type: "string" } },
};
const routePrefs = {
  type: "object",
  description: "Optional routing preferences (OpenRouter-style).",
  properties: {
    only: { type: "array", items: { enum: ["ucp", "acp", "rye", "computer_use"] } },
    ignore: { type: "array", items: { enum: ["ucp", "acp", "rye", "computer_use"] } },
    allowFallbacks: { type: "boolean" },
    sort: { enum: ["native", "latency"] },
    dataPolicy: { enum: ["allow_all", "deny_automation"], description: "deny_automation = never drive a browser" },
    region: { type: "string" },
  },
};
const idArg = { type: "object", required: ["checkoutId"], properties: { checkoutId: { type: "string" } } };

export const TOOLS = [
  {
    name: "list_merchants",
    description: "List merchants the router can buy from and which routes (ucp, acp, rye, computer_use) reach each one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_products",
    description:
      "Search products across merchants. Returns router product ids (merchantId:variantId) with prices in minor units (cents). Pass an id to create_checkout.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        merchants: { type: "array", items: { type: "string" }, description: "Restrict to these merchant ids" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        route: routePrefs,
      },
    },
  },
  {
    name: "create_checkout",
    description:
      "Start a checkout at ONE merchant. Items take a productId from search_products, or a productUrl for any store (Amazon, Target...). The router picks the best route and falls back automatically. Returns totals, shipping options and a status: needs_info | ready | requires_action | requires_approval | processing | completed | failed.",
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["quantity"],
            properties: { productId: { type: "string" }, productUrl: { type: "string" }, quantity: { type: "integer", minimum: 1 } },
          },
        },
        buyer,
        shipTo: address,
        route: routePrefs,
      },
    },
  },
  { name: "get_checkout", description: "Refresh a checkout's status and totals.", inputSchema: idArg },
  {
    name: "update_checkout",
    description: "Set buyer, shipping address, or pick a fulfillment option on a checkout.",
    inputSchema: {
      type: "object",
      required: ["checkoutId"],
      properties: { checkoutId: { type: "string" }, buyer, shipTo: address, fulfillmentOptionId: { type: "string" } },
    },
  },
  {
    name: "complete_checkout",
    description:
      "Pay for a ready checkout. Spend policy runs first: large orders return requires_approval until a human approves, and wallet-only merchants return requires_action with a continueUrl for the human. Confirm the total with the user before calling.",
    inputSchema: idArg,
  },
  { name: "cancel_checkout", description: "Cancel a checkout that hasn't completed.", inputSchema: idArg },
];

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export async function callTool(name: string, a: any) {
  switch (name) {
    case "list_merchants":
      return api("GET", "/v1/merchants");
    case "search_products":
      return api("POST", "/v1/search", a);
    case "create_checkout":
      return api("POST", "/v1/checkouts", a);
    case "get_checkout":
      return api("GET", `/v1/checkouts/${encodeURIComponent(a.checkoutId)}`);
    case "update_checkout": {
      const { checkoutId, ...rest } = a;
      return api("PATCH", `/v1/checkouts/${encodeURIComponent(checkoutId)}`, rest);
    }
    case "complete_checkout":
      return api("POST", `/v1/checkouts/${encodeURIComponent(a.checkoutId)}/complete`);
    case "cancel_checkout":
      return api("POST", `/v1/checkouts/${encodeURIComponent(a.checkoutId)}/cancel`);
    default:
      return { ok: false, data: { error: `unknown tool ${name}` } };
  }
}

async function handle(msg: any): Promise<any> {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "merchant-router", version: "0.1.0" },
        instructions:
          "Shopping tools. Flow: search_products -> create_checkout -> update_checkout until status is ready -> confirm the total with the user -> complete_checkout. Prices are in minor units (cents).",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      try {
        const { ok, data } = await callTool(msg.params.name, msg.params.arguments ?? {});
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: !ok };
      } catch (err) {
        return { content: [{ type: "text", text: `router unreachable at ${BASE}: ${(err as Error).message}` }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
  }
}

if (isMain(import.meta.url)) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return; // notification
    try {
      const result = await handle(msg);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    } catch (err) {
      const e = err as Error & { code?: number };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } }) + "\n");
    }
  });
}
