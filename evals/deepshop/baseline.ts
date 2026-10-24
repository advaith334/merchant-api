// Baseline: a current general agent doing the task the way agents shop today,
// with web search and page fetches (Claude's server-side web tools).

import type Anthropic from "@anthropic-ai/sdk";
import { MODEL, asinFromUrl, client, usageOf, type Answer, type Task } from "./common.ts";

const TOOLS: Anthropic.ToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
];

const INSTRUCTIONS =
  "You are a shopping agent. Complete the task below on Amazon (amazon.com) using web search and page fetches. " +
  "Answer with the single product that best satisfies it and any information the task asks for. " +
  "End your answer with one line of the form `FINAL_URL: https://www.amazon.com/dp/<ASIN>`.";

export async function runBaseline(task: Task): Promise<Answer> {
  const t0 = Date.now();
  let input = 0, output = 0;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `${INSTRUCTIONS}\n\nTask: ${task.ques}` }];

  let msg: Anthropic.Message | undefined;
  for (let turn = 0; turn < 6; turn++) {
    msg = await client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      output_config: { effort: "medium" },
      tools: TOOLS,
      messages,
    }).finalMessage();
    const u = usageOf(msg);
    input += u.input;
    output += u.output;
    if (msg.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: msg.content }); // server resumes from the trailing tool call
  }

  const text = (msg?.content ?? []).filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const finalUrl = text.match(/FINAL_URL:\s*(\S+)/)?.[1] ?? null;
  const asin = asinFromUrl(finalUrl) ?? asinFromUrl(text.match(/https?:\/\/\S*amazon\.com\S*/g)?.at(-1));

  return {
    taskId: task.id,
    system: "baseline",
    asin,
    url: asin ? `https://www.amazon.com/dp/${asin}` : finalUrl,
    response: text.replace(/FINAL_URL:.*$/m, "").trim(),
    inputTokens: input,
    outputTokens: output,
    latencyMs: Date.now() - t0,
    rainforestCalls: 0,
    error: msg?.stop_reason === "refusal" ? "refusal" : undefined,
  };
}
