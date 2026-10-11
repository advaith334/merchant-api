import { Guardrails, policyFromEnv } from "./guardrails.ts";
import { paymentProviderFromEnv } from "./payments.ts";
import { Registry } from "./registry.ts";
import { Router } from "./router.ts";

export function createRouterFromEnv(env = process.env): Router {
  return new Router({
    registry: Registry.fromFile(env.MERCHANTS_FILE ?? new URL("../merchants.json", import.meta.url)),
    payments: paymentProviderFromEnv(env),
    guardrails: new Guardrails(policyFromEnv(env)),
  });
}

export { Router } from "./router.ts";
export { Registry } from "./registry.ts";
export { Guardrails } from "./guardrails.ts";
export * from "./types.ts";
