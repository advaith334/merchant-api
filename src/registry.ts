import { readFileSync } from "node:fs";
import type { Merchant } from "./types.ts";

const DEFAULT_FILE = new URL("../merchants.json", import.meta.url);

export class Registry {
  merchants: Map<string, Merchant>;
  constructor(merchants: Merchant[]) {
    this.merchants = new Map(merchants.map((m) => [m.id, m]));
  }

  static fromFile(path: string | URL = process.env.MERCHANTS_FILE ?? DEFAULT_FILE): Registry {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return new Registry(data.merchants ?? data);
  }

  list(): Merchant[] {
    return [...this.merchants.values()];
  }

  get(id: string): Merchant | undefined {
    return this.merchants.get(id);
  }

  /**
   * Find the merchant for a product URL. Unknown domains get an ad-hoc entry that
   * tries UCP discovery first (covers every Shopify store), then universal checkout.
   */
  forUrl(url: string): Merchant {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    for (const m of this.merchants.values()) {
      if (m.domains.some((d) => host === d.replace(/^www\./, "") || host.endsWith("." + d.replace(/^www\./, "")))) return m;
    }
    const adhoc: Merchant = {
      id: host,
      name: host,
      domains: [host],
      routes: [{ protocol: "ucp" }, { protocol: "rye" }, { protocol: "computer_use" }],
      agentPolicy: "unknown",
      notes: "auto-discovered",
    };
    this.merchants.set(host, adhoc);
    return adhoc;
  }
}
