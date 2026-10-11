# merchant-router

One API key that lets an AI agent buy from any merchant. Like OpenRouter, but for checkout. The router speaks every agent-commerce protocol that exists today. For each merchant it picks the best route, falls back when one fails, and enforces spend limits in code the agent can't reach.

```
agent (Claude, any MCP client, or plain HTTP)
        │  one key
        ▼
┌──────────────── merchant-router ────────────────┐
│ search fan-out · route selection · fallbacks     │
│ spend guardrails · human approvals · scoped pay  │
└───┬──────────┬──────────┬───────────┬───────────┘
    ▼          ▼          ▼           ▼
   UCP        ACP        Rye      computer-use
(Google +  (OpenAI +  (universal   (your browser-agent
 Shopify)   Stripe)    checkout)    runner, or human handoff)
```

## What it connects to (checked 2026-10-11)

| Route | Who's on it | How the router pays |
|---|---|---|
| **UCP** ([ucp.dev](https://ucp.dev)), REST or MCP transport | **Every Shopify store** publishes `/.well-known/ucp` → `/api/ucp/mcp` (verified live on allbirds.com). Etsy and Wayfair have UCP checkout live inside Google AI Mode. Target and Walmart co-wrote the spec. | Stripe handler → scoped Shared Payment Token. Shop Pay / Google Pay only → the router builds the cart and hands `continueUrl` to the human. |
| **ACP** ([agenticcommerce.dev](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol), `2026-04-17`) | Merchants that onboard you as an agent and issue you a bearer key (the ChatGPT Instant Checkout merchant set) | Stripe Shared Payment Token (`spt_…`), capped at the exact total, expires in 15 min |
| **Rye** universal checkout | Any product URL: Amazon, Target, Best Buy, … | Rye drawdown balance or Stripe token |
| **computer-use** | Last resort for sites with no API, via a runner you host (contract in `src/adapters/computer-use.ts`) | The runner holds its own virtual card; the router only passes a spend cap. Without a runner: human handoff. |
| **Stripe** | Not a merchant. It's the payment layer. | `POST /v1/shared_payment/issued_tokens` (agentic-commerce preview) |

Domains not in `merchants.json` are auto-discovered: the router tries UCP first, so any Shopify store just works, then Rye, then computer-use.

**What doesn't exist:** Amazon, Target and Walmart have no public purchase API for agents. Best Buy's and Walmart's product APIs are read-only. Google's Content API for Shopping was sunset in Aug 2026. Those merchants are reached only through the gap-filler routes. Amazon is marked `agentPolicy: "prohibited"` (its terms forbid unauthorized automated agents), so the router never sends it to computer-use.

## Quickstart

Requires Node ≥ 24. There are no runtime dependencies; Node runs the `.ts` files directly.

```bash
npm install          # dev deps only (typescript, @types/node)
npm run demo         # full walkthrough against local mock merchants, no real money
npm test             # 14 end-to-end tests
```

Run the API:

```bash
ROUTER_API_KEY=sk_agent_123 ROUTER_ADMIN_KEY=sk_admin_456 npm start   # http://localhost:8787
```

Give it to Claude Code (or any MCP client):

```bash
claude mcp add merchant-router -e MERCHANT_ROUTER_URL=http://localhost:8787 -e MERCHANT_ROUTER_API_KEY=sk_agent_123 -- node /abs/path/merchant-router/src/mcp.ts
```

Tools: `list_merchants`, `search_products`, `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout`. There is deliberately no approve tool.

## HTTP API

All `/v1` calls take `Authorization: Bearer $ROUTER_API_KEY`. Money is integer cents.

| | |
|---|---|
| `GET /v1/merchants` | merchants and their usable routes |
| `POST /v1/search` | `{ query, merchants?, limit?, route? }` → products from every merchant, ids like `trailco:tc-shoe-1` |
| `POST /v1/checkouts` | `{ items: [{ productId \| productUrl, quantity }], buyer?, shipTo?, route? }` |
| `GET /v1/checkouts/:id` | refresh |
| `PATCH /v1/checkouts/:id` | `{ buyer?, shipTo?, fulfillmentOptionId? }` |
| `POST /v1/checkouts/:id/complete` | runs guardrails, mints a scoped credential, pays |
| `POST /v1/checkouts/:id/cancel` | |
| `GET /v1/routes/health` | EWMA latency and failures per merchant × route |
| `GET /v1/approvals`, `POST /v1/approvals/:id/approve\|deny` | **admin key only** |
| `GET /.well-known/ucp` | this router's UCP agent profile (merchants fetch it) |

Checkout `status`: `needs_info` → `ready` → (`requires_approval` | `requires_action`) → `processing` → `completed` / `failed` / `canceled`. Every checkout reports `routeAttempts`, e.g. `[✗ucp, ✓rye]`.

**Routing preferences** (`route` field, OpenRouter-style):

```json
{ "only": ["ucp", "acp"], "ignore": ["computer_use"], "allowFallbacks": true,
  "sort": "latency", "dataPolicy": "deny_automation", "region": "EU" }
```

`deny_automation` never drives a browser (it drops Rye and computer-use). `sort: "latency"` uses live route health. A circuit breaker pushes a route to the back after 3 consecutive failures, for 60 seconds.

## Guardrails (env)

| var | default | |
|---|---|---|
| `SPEND_MAX_PER_ORDER` | 500 | dollars; hard block |
| `SPEND_MAX_PER_DAY` | 1000 | dollars; hard block |
| `SPEND_APPROVAL_ABOVE` | 100 | above this, a human approves with the admin key |
| `SPEND_ALLOW_MERCHANTS` / `SPEND_BLOCK_MERCHANTS` | | comma-separated merchant ids |

The router refreshes the checkout before paying, so limits apply to the merchant's current total. An approval covers only the amount the human saw; a price increase needs a new approval. The agent never sees card data. It holds a checkout id, and the merchant gets a single-use token capped at that total.

## Going live

1. **Deploy publicly** (any Node host) and set `ROUTER_UCP_PROFILE=https://<host>/.well-known/ucp`. Shopify fetches this profile on every call and rejects agents it can't reach; this is verified, not assumed.
2. **Payments:** set `STRIPE_SECRET_KEY` and `STRIPE_PAYMENT_METHOD` (the buyer's saved `pm_…`). Shared Payment Tokens are a Stripe private preview, so request access. Without these, the router mints test tokens only.
3. **ACP merchants:** onboard with each merchant, then add `{ "protocol": "acp", "baseUrl", "apiKeyEnv", "feedUrl", "stripeProfile" }` to `merchants.json`.
4. **Gap-fillers:** `RYE_API_KEY` (staging by default; `RYE_ENV=production` for real orders). Optionally set `COMPUTER_USE_RUNNER_URL`.

## Layout

```
src/router.ts          route selection, fallbacks, health, checkout lifecycle
src/adapters/ucp.ts    UCP over REST + MCP (discovery, catalog, checkout)
src/adapters/acp.ts    ACP 2026-04-17 checkout_sessions + product feed search
src/adapters/rye.ts    Rye checkout-intents
src/adapters/computer-use.ts   runner contract + human handoff
src/guardrails.ts      spend caps, allow/block lists, approvals
src/payments.ts        Stripe SPT minting / test tokens
src/server.ts, src/mcp.ts      HTTP API and MCP server
mock/                  spec-shaped mock UCP/ACP/Rye/runner merchants for demo + tests
```

## Known gaps

- Checkouts, approvals and spend history are in memory. Add a database before running more than one instance.
- No Shop Pay token minting yet. That requires registering as a Shopify agent (`client_id`); until then, Shopify wallet-only stores end in a human handoff.
- UCP RFC 9421 request signing and ACP `Signature` headers aren't sent yet. Both are optional in the specs but some merchants will require them.
- ACP sessions are created in USD. Rye's offer fields are parsed defensively because the public docs don't list them.
- Product search covers UCP catalogs and ACP feeds. Rye and computer-use routes take product URLs.

## License

MIT
