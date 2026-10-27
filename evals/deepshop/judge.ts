// DeepShop's judge, adapted: the paper's evaluator prompt verbatim except that
// "Result Screenshots" become structured data from the chosen product's Amazon
// page, fetched independently of the system under test. As in the paper, each
// sub-criterion (attribute / filter / sort) is judged separately and a task
// succeeds only if every applicable one does (strict_rule_eval_overall.py).

import { MODEL, amazonPageText, client, getProduct, usageOf, type Answer, type Task } from "./common.ts";

/**
 * 2: Amazon picks are judged on the structured page plus the full page's key sections (returns, sizes,
 * ships-from, rank), closer to the paper's screenshots. 1: structured page only.
 */
export const JUDGE_VERSION = 2;

const SYSTEM_PROMPT = `As an evaluator, you will be presented with three primary components to assist you in your role:

1. Web Task Instruction: A clear and precise natural language directive that specifies an online shopping activity to be executed. The instruction may involve locating products that meet certain attribute requirements (e.g., color, size, brand), applying specific search filters (e.g., price range, customer ratings, availability), or fulfilling user-defined sorting preferences (e.g., lowest price, newest arrivals, best sellers). Tasks may also include verifying product details, comparing offers, or checking for shipping and return policies, depending on the scenario.

2. Product Page Data: Data from the Amazon product page of the product the agent selected, fetched independently of the agent. It serves as proof of what the agent actually selected.

3. Result Response: This is a textual response obtained after the execution of the web task. It serves as textual result in response to the instruction.

-- You DO NOT NEED to interact with web pages or perform actions such as booking flights or conducting searches on websites.
-- You SHOULD NOT make assumptions based on information not presented in the product page data when comparing it to the instructions.
-- Your primary responsibility is to conduct a thorough assessment of the web task instruction against the outcome shown in the product page data and in the response, evaluating whether the actions taken align with the given instructions.
-- NOTE that the instruction may involve more than one task, for example, locating the garage and summarizing the review. Failing to complete either task, such as not providing a summary, should be considered unsuccessful.
-- NOTE that the product page data is authentic, but the response provided by LLM is generated at the end of web browsing, and there may be discrepancies between the text and the product page data.
-- Note the difference: 1) Result response may contradict the product page data, then the content of the product page data prevails, 2) The content in the Result response is not mentioned in the product page data, choose to believe the content.
-- If no product was selected (no product page data), the task is NOT SUCCESS.

You should elaborate on how you arrived at your final evaluation and then provide a definitive verdict on whether the task has been successfully accomplished, either as 'SUCCESS' or 'NOT SUCCESS'.`;

export type Dim = "attribute" | "filter" | "sort";
export interface Verdict {
  taskId: string;
  system: string;
  dims: Partial<Record<Dim, boolean>>;
  success: boolean;
  judgeTokens: number;
  judgeVersion?: number;
  /** The judge's explanation for each dimension it failed, to diagnose failures. Doesn't affect the verdict. */
  reasons?: Partial<Record<Dim, string>>;
}

function parseVerdict(text: string): boolean {
  const last = text.toUpperCase().lastIndexOf("SUCCESS");
  if (last < 0) return false;
  return !text.toUpperCase().slice(Math.max(0, last - 4), last).includes("NOT");
}

export async function judge(task: Task, answer: Answer): Promise<Verdict> {
  // Amazon picks: the Amazon page, fetched independently. Non-Amazon picks (channel3,
  // shopify_catalog): the provider's own record of the product, as the agent saw it.
  const product = answer.asin ? await getProduct(answer.asin).catch(() => null) : null;
  const fullPage = product ? await amazonPageText(answer.asin!).catch(() => null) : null;
  const page = answer.asin ? (product && fullPage ? { ...product, full_page: fullPage } : product) : (answer.page ?? null);
  const dims: Partial<Record<Dim, boolean>> = {};
  const reasons: Partial<Record<Dim, string>> = {};
  let tokens = 0;

  for (const dim of ["attribute", "filter", "sort"] as const) {
    if (task[dim] === "None") continue;
    if (!page) { dims[dim] = false; continue; }
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `TASK: ${task[dim]}\nResult Response: ${answer.response}\nProduct Page Data: ${JSON.stringify(page)}\nYour verdict:\n`,
      }],
    });
    const u = usageOf(msg);
    tokens += u.input + u.output;
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    dims[dim] = parseVerdict(text);
    if (!dims[dim]) reasons[dim] = text.slice(-1500);
  }

  return {
    taskId: task.id,
    system: answer.system,
    dims,
    success: Object.values(dims).every(Boolean) && page != null,
    judgeTokens: tokens,
    judgeVersion: JUDGE_VERSION,
    reasons,
  };
}
