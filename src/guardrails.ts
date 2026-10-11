// Spend controls enforced in code, outside the agent's reach. The agent can ask
// to complete a checkout; only these rules (and a human, via the admin API)
// decide whether money moves.
import { randomUUID } from "node:crypto";
import type { Checkout, Merchant } from "./types.ts";

export interface SpendPolicy {
  currency: string;
  maxPerOrder: number; // minor units
  maxPerDay: number;
  approvalAbove: number; // orders above this need a human approval
  allowMerchants?: string[];
  blockMerchants?: string[];
}

export interface Approval {
  id: string;
  checkoutId: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
}

export type Verdict =
  | { ok: true }
  | { ok: false; reason: string }
  | { ok: false; approval: Approval };

export function policyFromEnv(env = process.env): SpendPolicy {
  const cents = (v: string | undefined, d: number) => (v ? Math.round(Number(v) * 100) : d);
  const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  return {
    currency: env.SPEND_CURRENCY ?? "USD",
    maxPerOrder: cents(env.SPEND_MAX_PER_ORDER, 500_00),
    maxPerDay: cents(env.SPEND_MAX_PER_DAY, 1000_00),
    approvalAbove: cents(env.SPEND_APPROVAL_ABOVE, 100_00),
    allowMerchants: list(env.SPEND_ALLOW_MERCHANTS),
    blockMerchants: list(env.SPEND_BLOCK_MERCHANTS),
  };
}

export class Guardrails {
  policy: SpendPolicy;
  approvals = new Map<string, Approval>();
  spent: Array<{ at: number; amount: number }> = [];

  constructor(policy: SpendPolicy) {
    this.policy = policy;
  }

  spentToday(): number {
    const since = Date.now() - 24 * 3600_000;
    this.spent = this.spent.filter((s) => s.at >= since);
    return this.spent.reduce((a, s) => a + s.amount, 0);
  }

  /** Checks that apply before any checkout is even created. */
  merchantAllowed(m: Merchant): { ok: true } | { ok: false; reason: string } {
    const p = this.policy;
    if (p.blockMerchants?.includes(m.id)) return { ok: false, reason: `merchant ${m.id} is blocked by policy` };
    if (p.allowMerchants && !p.allowMerchants.includes(m.id)) return { ok: false, reason: `merchant ${m.id} is not on the allowlist` };
    return { ok: true };
  }

  /** Called right before minting a payment credential. */
  checkSpend(co: Checkout, m: Merchant): Verdict {
    const p = this.policy;
    const allowed = this.merchantAllowed(m);
    if (!allowed.ok) return allowed;
    const total = co.totals.total;
    if (co.currency.toUpperCase() !== p.currency.toUpperCase()) {
      return { ok: false, reason: `checkout currency ${co.currency} != policy currency ${p.currency}` };
    }
    if (!(total > 0)) return { ok: false, reason: "checkout has no total yet" };
    if (total > p.maxPerOrder) return { ok: false, reason: `total ${fmt(total)} exceeds per-order cap ${fmt(p.maxPerOrder)}` };
    if (this.spentToday() + total > p.maxPerDay) {
      return { ok: false, reason: `would exceed daily cap ${fmt(p.maxPerDay)} (spent ${fmt(this.spentToday())})` };
    }
    if (total > p.approvalAbove) {
      const existing = [...this.approvals.values()].find((a) => a.checkoutId === co.id && a.status !== "denied");
      // An approval covers the amount a human saw; a price increase needs a new one.
      if (existing?.status === "approved" && existing.amount >= total) return { ok: true };
      if (existing?.status === "pending" && existing.amount === total) return { ok: false, approval: existing };
      const approval: Approval = {
        id: "apr_" + randomUUID().replace(/-/g, "").slice(0, 16),
        checkoutId: co.id,
        merchantId: m.id,
        amount: total,
        currency: co.currency,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      this.approvals.set(approval.id, approval);
      return { ok: false, approval };
    }
    return { ok: true };
  }

  decide(approvalId: string, approve: boolean): Approval | undefined {
    const a = this.approvals.get(approvalId);
    if (!a || a.status !== "pending") return undefined;
    a.status = approve ? "approved" : "denied";
    return a;
  }

  record(amount: number) {
    this.spent.push({ at: Date.now(), amount });
  }
}

export const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
