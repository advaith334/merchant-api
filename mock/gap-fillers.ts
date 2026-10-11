// Mock Rye checkout-intents API and a mock computer-use runner, so the
// "merchants with no API" routes can be exercised without real orders.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

/** Prices by URL substring, so the mock can "price" arbitrary store pages. */
const PRICES: Array<[RegExp, number, string]> = [
  [/target\.com/, 2499, "Target item"],
  [/amazon\.com/, 3999, "Amazon item"],
  [/bestbuy\.com/, 12999, "Best Buy item"],
  [/./, 1999, "Item"],
];

function serve(handler: (req: any, body: any, url: URL) => [number, any]): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const [status, data] = handler(req, body, new URL(req.url!, "http://x"));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, server })),
  );
}

export function startRyeMock(apiKey: string) {
  const intents = new Map<string, any>();
  return serve((req, body, url) => {
    if (req.headers.authorization !== `Bearer ${apiKey}`) return [401, { name: "AuthenticationError", message: "bad key" }];
    if (url.pathname === "/api/v1/checkout-intents" && req.method === "POST") {
      if (!body.productUrl || !body.buyer?.email || !body.buyer?.address1) return [400, { message: "productUrl and buyer required" }];
      const [, price] = PRICES.find(([re]) => re.test(body.productUrl))!;
      const id = "ci_" + randomUUID().slice(0, 8);
      const qty = Number(body.quantity);
      intents.set(id, { id, state: "retrieving_offer", productUrl: body.productUrl, quantity: qty, _price: price, _polls: 0 });
      return [200, intents.get(id)];
    }
    const m = url.pathname.match(/^\/api\/v1\/checkout-intents\/([\w-]+)(\/confirm)?$/);
    const it = m && intents.get(m[1]);
    if (!it) return [404, { name: "NotFoundError", message: "not found" }];
    if (m![2]) {
      if (it.state !== "awaiting_confirmation") return [409, { name: "InvalidCheckoutIntentStateError", message: "bad state", state: it.state }];
      if (!["drawdown", "stripe_token"].includes(body.paymentMethod?.type)) return [400, { message: "paymentMethod required" }];
      it.state = "placing_order";
      return [200, it];
    }
    // Advance the lifecycle on reads, like the real async pipeline.
    if (it.state === "retrieving_offer") {
      const sub = it._price * it.quantity;
      it.state = "awaiting_confirmation";
      it.offer = {
        cost: {
          subtotal: { amountSubunits: sub, currencyCode: "USD" },
          shipping: { amountSubunits: 599, currencyCode: "USD" },
          tax: { amountSubunits: Math.round(sub * 0.07), currencyCode: "USD" },
          total: { amountSubunits: sub + 599 + Math.round(sub * 0.07), currencyCode: "USD" },
        },
        shipping: { availableOptions: [{ id: "std", label: "Standard", cost: { amountSubunits: 599, currencyCode: "USD" } }], selectedOptionId: "std" },
      };
    } else if (it.state === "placing_order") {
      it.state = "completed";
      it.orderId = "rye_ord_" + randomUUID().slice(0, 8);
    }
    const { _price, _polls, ...pub } = it;
    return [200, pub];
  });
}

export function startRunnerMock() {
  const tasks = new Map<string, any>();
  return serve((req, body, url) => {
    if (url.pathname === "/tasks" && req.method === "POST") {
      const [, price, title] = PRICES.find(([re]) => re.test(body.productUrl))!;
      const id = "task_" + randomUUID().slice(0, 8);
      const total = price * body.quantity + 899;
      tasks.set(id, { id, status: "quoted", title, total: { amount: total, currency: "USD" }, message: `Cart built for ${title}; ready to pay.` });
      return [200, tasks.get(id)];
    }
    const m = url.pathname.match(/^\/tasks\/([\w-]+)(\/confirm)?$/);
    const t = m && tasks.get(m[1]);
    if (!t) return [404, { message: "no task" }];
    if (m![2]) {
      if (body.authorization?.maxAmount < t.total.amount) return [200, { ...t, status: "failed", message: "total exceeds authorization" }];
      Object.assign(t, { status: "completed", orderId: "cu_ord_" + randomUUID().slice(0, 8), message: "Order placed by browser agent." });
    }
    return [200, t];
  });
}
