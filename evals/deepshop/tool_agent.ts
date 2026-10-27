// Claude with one provider's search API as its only tool: how an agent builder
// would wire up Channel3, Shopify's catalog or a web search API today. Each
// provider in providers.ts becomes one system under test.

import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, asinFromUrl, client, resolveUrl, usageOf, type Answer, type Task } from "./common.ts";

export interface Provider {
  system: string;
  /** Env vars the provider needs; `--system all` skips providers missing any of them. */
  env: string[];
  /** true: the agent may pick from any retailer, and "on Amazon" is dropped from the task. */
  anyRetailer: boolean;
  tool: Anthropic.Tool;
  /** One search. `pages` maps each result url to the provider's own record, used to judge non-Amazon picks. */
  search(input: any): Promise<{ results: unknown[]; pages?: Record<string, unknown> }>;
}

const MAX_SEARCHES = 4;

/** The record for the agent's pick; agents often echo a url without its tracking query string. */
function findPage(pages: Record<string, unknown>, url: string) {
  if (pages[url]) return pages[url];
  // Without the query string, only a unique match identifies the product.
  const bare = (u: string) => u.split(/[?#]/)[0].replace(/\/$/, "");
  const matches = Object.entries(pages).filter(([u]) => bare(u) === bare(url));
  return matches.length === 1 ? matches[0][1] : undefined;
}

export function toolAgent(provider: Provider) {
  return async function run(task: Task): Promise<Answer> {
    const t0 = Date.now();
    let input = 0, output = 0, calls = 0;
    const pages: Record<string, unknown> = {};
    const ques = provider.anyRetailer ? task.ques.replace(/\s*\b(?:on|in|from|at) amazon(?:\.com)?\b/gi, "") : task.ques;
    const instructions =
      `You are a shopping agent. Use ${provider.tool.name} (at most ${MAX_SEARCHES} times) to complete the task below` +
      `${provider.anyRetailer ? "" : " on Amazon (amazon.com); the tool only returns Amazon results"}. ` +
      "Answer with the single product that best satisfies it and any information the task asks for. " +
      "End your answer with one line of the form `FINAL_URL: <the product's url exactly as the tool returned it>`.";
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: `${instructions}\n\nTask: ${ques}` }];

    let msg: Anthropic.Message | undefined;
    for (let turn = 0; turn <= MAX_SEARCHES; turn++) {
      msg = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        output_config: { effort: "medium" },
        tools: [provider.tool],
        tool_choice: turn === MAX_SEARCHES ? { type: "none" } : { type: "auto" }, // the last turn has to answer
        messages,
      });
      const u = usageOf(msg);
      input += u.input;
      output += u.output;
      if (msg.stop_reason !== "tool_use") break;

      messages.push({ role: "assistant", content: msg.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type !== "tool_use") continue;
        let content: string;
        try {
          const r = await provider.search(block.input);
          Object.assign(pages, r.pages);
          content = JSON.stringify(r.results);
          calls++;
        } catch (err) {
          content = `search failed: ${String(err).slice(0, 300)}`;
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content });
      }
      messages.push({ role: "user", content: results });
    }

    const text = (msg?.content ?? []).filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const finalUrl = text.match(/FINAL_URL:\s*(\S+)/)?.[1]?.replace(/[`.,)>]+$/, "") ?? null;
    let asin = asinFromUrl(finalUrl);
    let url = finalUrl;
    if (finalUrl && !asin) {
      url = await resolveUrl(finalUrl); // buy links can be tracking redirects to Amazon
      asin = asinFromUrl(url);
    }

    return {
      taskId: task.id,
      system: provider.system,
      asin,
      url: asin ? `https://www.amazon.com/dp/${asin}` : url,
      response: text.replace(/FINAL_URL:.*$/m, "").trim(),
      inputTokens: input,
      outputTokens: output,
      latencyMs: Date.now() - t0,
      rainforestCalls: 0,
      apiCalls: calls,
      page: !asin && finalUrl ? findPage(pages, finalUrl) : undefined,
      error: msg?.stop_reason === "refusal" ? "refusal" : undefined,
    };
  };
}
