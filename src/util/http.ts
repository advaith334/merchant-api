import { randomUUID } from "node:crypto";
import { RouteError } from "../types.ts";

export interface RequestOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  idempotent?: boolean; // adds Idempotency-Key
}

/** JSON fetch with timeout. Network errors, timeouts and 5xx/429 are retriable. */
export async function requestJson<T = any>(url: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotent) headers["idempotency-key"] ??= randomUUID();

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new RouteError(`network error calling ${url}: ${(err as Error).message}`, { retriable: true });
  }

  const text = await res.text();
  let data: any = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = data?.message ?? data?.error?.message ?? data?.error ?? text.slice(0, 200);
    throw new RouteError(`${res.status} from ${new URL(url).host}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, {
      status: res.status,
      retriable: res.status >= 500 || res.status === 429,
    });
  }
  return data as T;
}
