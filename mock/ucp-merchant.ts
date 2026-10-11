// A spec-shaped UCP merchant for demos and tests. Serves /.well-known/ucp and the
// shopping service over REST (rest.openapi.json paths) or MCP (Shopify-style tools).
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export interface CatalogItem {
  id: string;
  title: string;
  price: number; // cents
  tags?: string[];
}

export interface UcpMerchantOpts {
  name: string;
  transport: "rest" | "mcp";
  /** payment_handlers map, e.g. { "com.stripe.payments": [{ id: "stripe" }] } */
  handlers: Record<string, Array<{ id: string; config?: any }>>;
  catalog: CatalogItem[];
}

const VERSION = "2026-08-25";

export function startUcpMerchant(opts: UcpMerchantOpts): Promise<{ url: string; server: Server; sessions: Map<string, any> }> {
  const sessions = new Map<string, any>();
  let base = "";

  const find = (id: string) => opts.catalog.find((c) => c.id === id);

  function recompute(s: any) {
    let subtotal = 0;
    for (const li of s.line_items) {
      const amount = li.item.price * li.quantity;
      subtotal += amount;
      li.totals = [
        { type: "subtotal", amount },
        { type: "total", amount },
      ];
    }
    const method = s.fulfillment?.methods?.[0];
    const dest = method?.destinations?.[0];
    if (method && dest && !method.groups) {
      method.id ??= "fm_1";
      method.line_item_ids = s.line_items.map((l: any) => l.id);
      method.selected_destination_id = dest.id ??= "dest_1";
      method.groups = [
        {
          id: "fg_1",
          line_item_ids: method.line_item_ids,
          selected_option_id: "standard", // merchants typically preselect the cheapest option
          options: [
            { id: "standard", title: "Standard (5-7 days)", totals: [{ type: "total", amount: 500 }] },
            { id: "express", title: "Express (2 days)", totals: [{ type: "total", amount: 1500 }] },
          ],
        },
      ];
    }
    const group = method?.groups?.[0];
    const ship = group?.options?.find((o: any) => o.id === group.selected_option_id)?.totals[0].amount ?? 0;
    const tax = dest ? Math.round(subtotal * 0.08) : 0;
    s.totals = [
      { type: "subtotal", amount: subtotal },
      ...(ship ? [{ type: "fulfillment", amount: ship }] : []),
      ...(tax ? [{ type: "tax", amount: tax }] : []),
      { type: "total", amount: subtotal + ship + tax },
    ];
    const missing: any[] = [];
    if (!s.buyer?.email) missing.push({ type: "error", code: "missing", path: "$.buyer.email", content: "Buyer email is required", severity: "requires_buyer_input" });
    if (!dest) missing.push({ type: "error", code: "missing", path: "$.fulfillment", content: "Shipping address is required", severity: "requires_buyer_input" });
    s.messages = missing;
    if (!["completed", "canceled"].includes(s.status)) s.status = missing.length ? "incomplete" : "ready_for_complete";
    return s;
  }

  function create(body: any) {
    const id = "chk_" + randomUUID().slice(0, 8);
    const line_items = (body.line_items ?? []).map((li: any, i: number) => {
      const c = find(li.item?.id);
      if (!c) throw Object.assign(new Error(`unknown item ${li.item?.id}`), { status: 400 });
      return { id: `li_${i + 1}`, item: { id: c.id, title: c.title, price: c.price }, quantity: li.quantity };
    });
    const s = {
      ucp: { version: VERSION },
      id,
      status: "incomplete",
      currency: "USD",
      buyer: body.buyer,
      line_items,
      fulfillment: body.fulfillment,
      links: [{ type: "terms_of_service", url: `${base}/terms` }],
      continue_url: `${base}/checkouts/${id}`,
    };
    sessions.set(id, recompute(s));
    return s;
  }

  function update(id: string, body: any) {
    const s = sessions.get(id);
    if (!s) throw Object.assign(new Error("not found"), { status: 404 });
    if (body.buyer) s.buyer = body.buyer;
    const nm = body.fulfillment?.methods?.[0];
    if (nm) {
      const cur = s.fulfillment?.methods?.[0];
      if (nm.destinations) {
        s.fulfillment = { methods: [{ type: "shipping", destinations: nm.destinations }] };
      } else if (cur?.groups && nm.groups?.[0]?.selected_option_id) {
        cur.groups[0].selected_option_id = nm.groups[0].selected_option_id;
      }
    }
    return recompute(s);
  }

  function complete(id: string, body: any) {
    const s = sessions.get(id);
    if (!s) throw Object.assign(new Error("not found"), { status: 404 });
    if (s.status !== "ready_for_complete") throw Object.assign(new Error(`checkout is ${s.status}`), { status: 409 });
    const inst = body.payment?.instruments?.[0];
    const handlerIds = Object.values(opts.handlers).flat().map((h) => h.id);
    if (!inst || !handlerIds.includes(inst.handler_id)) throw Object.assign(new Error("unsupported payment handler"), { status: 400 });
    if (inst.handler_id !== "stripe" && inst.handler_id !== "test") throw Object.assign(new Error("wallet handler needs buyer session"), { status: 400 });
    if (!inst.credential?.token) throw Object.assign(new Error("missing credential token"), { status: 400 });
    s.status = "completed";
    s.order = { id: "ord_" + randomUUID().slice(0, 8), permalink_url: `${base}/orders/${s.id}` };
    return s;
  }

  function search(body: any) {
    const terms = String(body.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const products = opts.catalog
      .filter((c) => terms.every((t) => `${c.title} ${(c.tags ?? []).join(" ")}`.toLowerCase().includes(t)))
      .slice(0, body.pagination?.limit ?? 10)
      .map((c) => ({
        id: "prod_" + c.id,
        title: c.title,
        description: { plain: c.title },
        url: `${base}/products/${c.id}`,
        price_range: { min: { amount: c.price, currency: "USD" }, max: { amount: c.price, currency: "USD" } },
        variants: [{ id: c.id, title: c.title, description: { plain: c.title }, price: { amount: c.price, currency: "USD" }, url: `${base}/products/${c.id}` }],
      }));
    return { ucp: { version: VERSION }, products };
  }

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, "http://x");
    const json = (status: number, data: any) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname === "/.well-known/ucp") {
        return json(200, {
          ucp: {
            version: VERSION,
            services: { "dev.ucp.shopping": [{ version: VERSION, transport: opts.transport, endpoint: `${base}/ucp${opts.transport === "mcp" ? "/mcp" : ""}` }] },
            capabilities: { "dev.ucp.shopping.checkout": [{ version: VERSION }] },
            payment_handlers: opts.handlers,
          },
        });
      }

      if (opts.transport === "mcp" && url.pathname === "/ucp/mcp") {
        const { id: rpcId, method, params } = body;
        if (method !== "tools/call") return json(200, { jsonrpc: "2.0", id: rpcId, result: { tools: [] } });
        const a = params.arguments ?? {};
        if (!a.meta?.["ucp-agent"]?.profile) {
          return json(200, { jsonrpc: "2.0", id: rpcId, error: { code: -32001, message: "UCP discovery failed", data: { code: "profile_unreachable" } } });
        }
        const handlers: Record<string, () => any> = {
          search_catalog: () => search(a.catalog),
          create_checkout: () => create(a.checkout),
          get_checkout: () => sessions.get(a.id),
          update_checkout: () => update(a.id, a.checkout),
          complete_checkout: () => complete(a.id, a.checkout),
          cancel_checkout: () => Object.assign(sessions.get(a.id), { status: "canceled" }),
        };
        try {
          const out = handlers[params.name]();
          return json(200, { jsonrpc: "2.0", id: rpcId, result: { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out) }] } });
        } catch (e: any) {
          return json(200, { jsonrpc: "2.0", id: rpcId, result: { isError: true, content: [{ type: "text", text: e.message }] } });
        }
      }

      if (opts.transport === "rest" && url.pathname.startsWith("/ucp/")) {
        if (!req.headers["ucp-agent"]) return json(400, { message: "UCP-Agent header required" });
        const p = url.pathname.slice(4);
        if (req.method === "POST" && req.headers["idempotency-key"] === undefined && p !== "/catalog/search") {
          return json(400, { message: "Idempotency-Key required" });
        }
        if (p === "/catalog/search") return json(200, search(body));
        if (p === "/checkout-sessions" && req.method === "POST") return json(201, create(body));
        const m = p.match(/^\/checkout-sessions\/([\w-]+)(?:\/(complete|cancel))?$/);
        if (m) {
          if (!m[2] && req.method === "GET") return sessions.has(m[1]) ? json(200, sessions.get(m[1])) : json(404, { message: "not found" });
          if (!m[2] && req.method === "PUT") return json(200, update(m[1], body));
          if (m[2] === "complete") return json(200, complete(m[1], body));
          if (m[2] === "cancel") return json(200, Object.assign(sessions.get(m[1]), { status: "canceled" }));
        }
      }
      json(404, { message: "not found" });
    } catch (e: any) {
      json(e.status ?? 500, { message: e.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve({ url: base, server, sessions });
    });
  });
}
