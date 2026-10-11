// HTTP API. Agents authenticate with ROUTER_API_KEY; approving spend needs the
// separate ROUTER_ADMIN_KEY, so an agent holding its own key can't approve itself.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createRouterFromEnv } from "./index.ts";
import { Router } from "./router.ts";
import { RouteError } from "./types.ts";
import { isMain } from "./util/main.ts";

const UCP_VERSION = "2026-08-25";

/** This router's UCP platform profile. Merchants fetch it before answering (UCP-Agent header). */
export function agentProfile() {
  const v = UCP_VERSION;
  const cap = (name: string, path: string) => ({
    [name]: [{ version: v, spec: `https://ucp.dev/${v}/specification/${path}/`, schema: `https://ucp.dev/${v}/schemas/shopping/${path.split("/").pop()}.json` }],
  });
  return {
    ucp: {
      version: v,
      services: {
        "dev.ucp.shopping": [
          { version: v, spec: `https://ucp.dev/${v}/specification/overview/`, transport: "mcp", schema: `https://ucp.dev/${v}/services/shopping/mcp.openrpc.json` },
          { version: v, spec: `https://ucp.dev/${v}/specification/overview/`, transport: "rest", schema: `https://ucp.dev/${v}/services/shopping/rest.openapi.json` },
        ],
      },
      capabilities: {
        ...cap("dev.ucp.shopping.checkout", "shopping/checkout"),
        ...cap("dev.ucp.shopping.fulfillment", "shopping/extensions/fulfillment"),
        ...cap("dev.ucp.shopping.catalog.search", "shopping/catalog"),
      },
    },
  };
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: IncomingMessage) {
  return (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new RouteError("body too large", { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RouteError("invalid JSON body", { status: 400 });
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

export function createHttpServer(router: Router, env = process.env): Server {
  const apiKey = env.ROUTER_API_KEY;
  const adminKey = env.ROUTER_ADMIN_KEY;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/$/, "") || "/";
    const method = req.method ?? "GET";
    try {
      if (path === "/.well-known/ucp" && method === "GET") return send(res, 200, agentProfile());
      if (path === "/healthz") return send(res, 200, { ok: true });

      const isAdmin = path.startsWith("/v1/approvals");
      if (isAdmin) {
        if (!adminKey || !safeEq(bearer(req), adminKey)) return send(res, 401, { error: "admin key required" });
      } else if (path.startsWith("/v1/") && apiKey && !safeEq(bearer(req), apiKey)) {
        return send(res, 401, { error: "invalid API key" });
      }

      if (path === "/v1/merchants" && method === "GET") {
        return send(res, 200, {
          merchants: router.registry.list().map((m) => ({
            id: m.id,
            name: m.name,
            domains: m.domains,
            region: m.region,
            routes: router.routesFor(m).map((r) => r.protocol),
            agentPolicy: m.agentPolicy,
            notes: m.notes,
          })),
        });
      }
      if (path === "/v1/search" && method === "POST") {
        const b = await readBody(req);
        if (!b.query) throw new RouteError("query required", { status: 400 });
        return send(res, 200, await router.search(b.query, { merchants: b.merchants, limit: b.limit, prefs: b.route }));
      }
      if (path === "/v1/checkouts" && method === "POST") {
        const b = await readBody(req);
        const co = await router.createCheckout({ items: b.items, buyer: b.buyer, shipTo: b.shipTo, prefs: b.route });
        return send(res, 201, Router.view(co));
      }
      let m = path.match(/^\/v1\/checkouts\/([\w-]+)(?:\/(complete|cancel))?$/);
      if (m) {
        const [, id, action] = m;
        if (!action && method === "GET") return send(res, 200, Router.view(await router.getCheckout(id)));
        if (!action && (method === "PATCH" || method === "POST")) {
          return send(res, 200, Router.view(await router.updateCheckout(id, await readBody(req))));
        }
        if (action === "complete" && method === "POST") return send(res, 200, Router.view(await router.completeCheckout(id)));
        if (action === "cancel" && method === "POST") return send(res, 200, Router.view(await router.cancelCheckout(id)));
      }
      if (path === "/v1/routes/health" && method === "GET") return send(res, 200, router.routeHealth());
      if (path === "/v1/approvals" && method === "GET") {
        return send(res, 200, { approvals: [...router.guardrails.approvals.values()], policy: router.guardrails.policy });
      }
      m = path.match(/^\/v1\/approvals\/([\w-]+)\/(approve|deny)$/);
      if (m && method === "POST") {
        const a = router.guardrails.decide(m[1], m[2] === "approve");
        if (!a) return send(res, 404, { error: "no pending approval with that id" });
        return send(res, 200, a);
      }
      return send(res, 404, { error: `no route ${method} ${path}` });
    } catch (err) {
      const e = err as RouteError & { attempts?: unknown };
      const status = e instanceof RouteError ? (e.status && e.status >= 400 ? e.status : 400) : 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: e.message, attempts: e.attempts });
    }
  });
}

if (isMain(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  if (!process.env.ROUTER_API_KEY) console.warn("warning: ROUTER_API_KEY not set; /v1 is open to anyone who can reach this port");
  const router = createRouterFromEnv();
  createHttpServer(router).listen(port, () => {
    console.log(`merchant-router listening on http://localhost:${port}`);
    console.log(`  payments: ${router.payments.name}   merchants: ${router.registry.list().length}`);
  });
}
