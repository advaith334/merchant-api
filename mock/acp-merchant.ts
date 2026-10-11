// A spec-shaped ACP (2026-04-17) merchant: /checkout_sessions + a product feed.
// Checks bearer auth, API-Version and Idempotency-Key, and only accepts Stripe SPTs.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { CatalogItem } from "./ucp-merchant.ts";

export function startAcpMerchant(opts: { name: string; apiKey: string; catalog: CatalogItem[] }): Promise<{ url: string; server: Server }> {
  const sessions = new Map<string, any>();
  let base = "";

  const handler = {
    id: "card_tokenized",
    name: "dev.acp.tokenized.card",
    display_name: "Credit Card",
    version: "2026-01-22",
    requires_delegate_payment: true,
    psp: "stripe",
    config: { psp: "stripe" },
  };

  function recompute(s: any) {
    const counts = new Map<string, number>();
    for (const id of s._items) counts.set(id, (counts.get(id) ?? 0) + 1);
    let subtotal = 0;
    s.line_items = [...counts.entries()].map(([id, qty], i) => {
      const c = opts.catalog.find((x) => x.id === id)!;
      const amt = c.price * qty;
      subtotal += amt;
      return { id: `line_item_${i + 1}`, item: { id }, quantity: qty, name: c.title, unit_amount: c.price, totals: [{ type: "subtotal", display_text: "Subtotal", amount: amt }, { type: "total", display_text: "Total", amount: amt }] };
    });
    const addr = s.fulfillment_details?.address;
    s.fulfillment_options = addr
      ? [
          { type: "shipping", id: "ground", title: "Ground", carrier: "UPS", totals: [{ type: "total", display_text: "Shipping", amount: 0 }] },
          { type: "shipping", id: "next_day", title: "Next day", carrier: "UPS", totals: [{ type: "total", display_text: "Shipping", amount: 2500 }] },
        ]
      : [];
    if (addr && !s.selected_fulfillment_options?.length) s.selected_fulfillment_options = [{ type: "shipping", option_id: "ground", item_ids: [...counts.keys()] }];
    const sel = s.fulfillment_options.find((o: any) => o.id === s.selected_fulfillment_options?.[0]?.option_id);
    const ship = sel?.totals[0].amount ?? 0;
    const tax = addr ? Math.round(subtotal * 0.0875) : 0;
    s.totals = [
      { type: "subtotal", display_text: "Subtotal", amount: subtotal },
      { type: "fulfillment", display_text: "Shipping", amount: ship },
      { type: "tax", display_text: "Tax", amount: tax },
      { type: "total", display_text: "Total", amount: subtotal + ship + tax },
    ];
    s.messages = addr ? [] : [{ type: "error", code: "missing", param: "$.fulfillment_details", content: "Shipping address required", resolution: "requires_buyer_input" }];
    if (!["completed", "canceled"].includes(s.status)) s.status = addr && s.buyer?.email ? "ready_for_payment" : "not_ready_for_payment";
    return s;
  }

  const view = (s: any) => {
    const { _items, ...rest } = s;
    return rest;
  };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url!, "http://x");
    const json = (status: number, data: any) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const err = (status: number, code: string, message: string) => json(status, { type: "invalid_request", code, message });

    if (url.pathname === "/feed.json") {
      return json(200, {
        products: opts.catalog.map((c) => ({
          id: "prod_" + c.id,
          title: c.title,
          description: { plain: c.title },
          tags: c.tags,
          url: `${base}/p/${c.id}`,
          variants: [{ id: c.id, title: c.title, price: { amount: c.price, currency: "USD" }, url: `${base}/p/${c.id}` }],
        })),
      });
    }
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) return err(401, "unauthorized", "bad API key");
    if (!req.headers["api-version"]) return err(400, "missing_api_version", "API-Version header required");
    if (req.method === "POST" && !req.headers["idempotency-key"]) return err(400, "idempotency_key_required", "Idempotency-Key required");

    if (url.pathname === "/checkout_sessions" && req.method === "POST") {
      const items: string[] = (body.line_items ?? []).map((li: any) => li.id);
      const bad = items.find((id) => !opts.catalog.some((c) => c.id === id));
      if (bad) return err(400, "invalid_item", `unknown item ${bad}`);
      const s = {
        id: "cs_" + randomUUID().slice(0, 8),
        protocol: { version: "2026-04-17" },
        capabilities: { payment: { handlers: [handler] } },
        status: "incomplete",
        currency: body.currency ?? "usd",
        buyer: body.buyer,
        fulfillment_details: body.fulfillment_details,
        links: [{ type: "terms_of_use", url: `${base}/terms` }],
        _items: items,
      };
      sessions.set(s.id, recompute(s));
      return json(201, view(s));
    }
    const m = url.pathname.match(/^\/checkout_sessions\/([\w-]+)(?:\/(complete|cancel))?$/);
    const s = m && sessions.get(m[1]);
    if (!s) return err(404, "not_found", "no such session");
    if (!m![2] && req.method === "GET") return json(200, view(s));
    if (!m![2] && req.method === "POST") {
      if (body.buyer) s.buyer = body.buyer;
      if (body.fulfillment_details) s.fulfillment_details = body.fulfillment_details;
      if (body.selected_fulfillment_options) s.selected_fulfillment_options = body.selected_fulfillment_options;
      return json(200, view(recompute(s)));
    }
    if (m![2] === "complete") {
      if (s.status !== "ready_for_payment") return err(400, "not_ready", `session is ${s.status}`);
      const pd = body.payment_data;
      if (pd?.handler_id !== handler.id || pd?.instrument?.credential?.type !== "spt" || !/^spt_/.test(pd.instrument.credential.token ?? "")) {
        return err(400, "payment_declined", "expected a Stripe shared payment token");
      }
      s.status = "completed";
      s.order = { id: "ord_" + randomUUID().slice(0, 8), checkout_session_id: s.id, permalink_url: `${base}/orders/${s.id}` };
      return json(200, view(s));
    }
    if (m![2] === "cancel") {
      s.status = "canceled";
      return json(200, view(s));
    }
    err(404, "not_found", "no route");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve({ url: base, server });
    });
  });
}
