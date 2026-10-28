// Live demo for the application video: runs one shopping request and prints each step as it happens,
// with a running clock and token count. Run our pipeline and the Claude + web search baseline in two
// terminals side by side.
//
// Usage: node --env-file=.env evals/deepshop/demo.ts [--system ours_v11|baseline] [--fresh] (--task Amazon--128 | "<request>")
// --fresh skips cached Amazon and Jev responses, so the clock shows live timing (each run spends ~8 ScraperAPI calls).

import { parseArgs } from "node:util";
import type { Task } from "./common.ts";
import type { Step } from "./ours_jev.ts";

const { values: args, positionals } = parseArgs({
  options: {
    system: { type: "string", default: "ours_v11" },
    task: { type: "string" },
    fresh: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
// Set before the pipeline loads: it reads these at import.
process.env.AMAZON_DATA ??= "scraperapi";
if (args.fresh) process.env.EVAL_FRESH = "1";

const { loadTasks, amazonLiveCalls } = await import("./common.ts");
const { runOursV11 } = await import("./ours_jev.ts");
const { runBaseline } = await import("./baseline.ts");

const task: Task = args.task
  ? loadTasks().find((t) => t.id === args.task) ?? (() => { throw new Error(`no task ${args.task}`); })()
  : { id: "demo", ques: positionals.join(" "), attribute: "", filter: "", sort: "", category: "", difficulty: "easy" };
if (!task.ques) throw new Error('give a request: --task Amazon--128 or "a yoga mat under $50 ..."');

const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m", reset: "\x1b[0m" };
const WIDTH = Math.min(process.stdout.columns || 100, 100);
const t0 = Date.now();
const clock = (ms = Date.now() - t0) => `${c.dim}[${(ms / 1000).toFixed(1).padStart(5)}s]${c.reset}`;
const tokens = (n: number) => n.toLocaleString("en-US");
const wrap = (text: string, indent = "  ") => {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && (indent + line + " " + word).length > WIDTH) { lines.push(indent + line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(indent + line);
  }
  return lines.join("\n");
};
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** ✓ verified, ✗ fails, ? not shown in the data seen so far (search results have no shipping or returns). */
const mark = (ok: boolean | null) => (ok === null ? `${c.yellow}?${c.reset}` : ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`);
const markdown = (text: string) => text.replace(/\*\*(.+?)\*\*/g, `${c.bold}$1${c.reset}`);

console.log(`\n${c.bold}Request${c.reset}`);
console.log(wrap(task.ques));
console.log();

if (args.system === "baseline") {
  // Claude with web search: nothing to show until it answers, so a ticking clock.
  console.log(`${c.bold}Claude + web search${c.reset} ${c.dim}(searching and reading pages)${c.reset}`);
  const tick = setInterval(() => process.stdout.write(`\r  ${clock()} working…`), 200);
  const a = await runBaseline(task);
  clearInterval(tick);
  process.stdout.write("\r\x1b[K");
  console.log(`\n${c.bold}Answer${c.reset}  ${a.url ?? "no product"}`);
  console.log(markdown(wrap(a.response)));
  console.log(`\n${c.bold}${c.yellow}Done in ${(a.latencyMs / 1000).toFixed(1)}s · ${tokens(a.inputTokens + a.outputTokens)} tokens${c.reset}\n`);
} else if (args.system === "ours_v11") {
  let plan: any;
  // The filters the plan asks for, checked on a product's own numbers.
  const filters = (r: any): [string, boolean | null][] => [
    ...(plan.min_price != null || plan.max_price != null
      ? [[`$${r.price ?? "?"}`, r.price == null ? null : r.price >= (plan.min_price ?? 0) && r.price <= (plan.max_price ?? Infinity)] as [string, boolean | null]]
      : []),
    ...(plan.min_rating != null ? [[`★${r.rating ?? "?"}`, r.rating == null ? null : r.rating >= plan.min_rating] as [string, boolean | null]] : []),
    ...(plan.min_reviews != null
      ? [[`${r.ratings_total == null ? "?" : tokens(r.ratings_total)} reviews`, r.ratings_total == null ? null : r.ratings_total >= plan.min_reviews] as [string, boolean | null]]
      : []),
  ];
  const row = (r: any, checks: (readonly [string, number])[]) =>
    `${[...filters(r).map(([label, ok]) => `${mark(ok)} ${label}`), ...checks.map(([label, p]) => `${mark(p >= 0.7 ? true : p <= 0.3 ? false : null)} ${short(label, 24)}`)].join("  ")}`;

  const onStep = (s: Step) => {
    const at = clock(s.ms);
    if (s.kind === "plan") {
      plan = s.plan;
      console.log(`${at} ${c.bold}1. Understood the request${c.reset}`);
      const asks = [
        `search "${plan.search_term}"`,
        plan.min_price != null || plan.max_price != null ? `price ${plan.min_price != null ? `$${plan.min_price}` : ""}–${plan.max_price != null ? `$${plan.max_price}` : ""}` : null,
        plan.min_rating != null ? `rating ${plan.min_rating}+` : null,
        plan.min_reviews != null ? `${plan.min_reviews}+ reviews` : null,
        plan.sort_by !== "featured" ? `sorted by ${plan.sort_by.replace(/_/g, " ")}` : null,
        ...plan.must_have.map((m: string) => `must: ${m}`),
      ].filter(Boolean);
      console.log(wrap(asks.join(" · "), "         "));
    } else if (s.kind === "search") {
      console.log(`${at} ${c.bold}2. Searched Amazon${c.reset} ${c.dim}"${s.term}", ${s.sort_by.replace(/_/g, " ")}: ${s.results} products so far${c.reset}`);
    } else if (s.kind === "checked") {
      console.log(`${at} ${c.bold}3. Checked every requirement on all ${s.total} results${c.reset} ${c.dim}(best 8 shown)${c.reset}`);
      console.log(`         ${c.dim}From search results only: a ✗ can mean the listing doesn't show it. Product pages come next.${c.reset}`);
      for (const x of s.top) {
        console.log(`         ${c.cyan}${short(x.r.title ?? "", WIDTH - 10)}${c.reset}`);
        console.log(`           ${row(x.r, x.checks)}`);
      }
    } else if (s.kind === "page") {
      console.log(`${at} ${c.bold}4. Read the full product page${c.reset} ${c.dim}(price, shipping, returns, sizes, rank)${c.reset}`);
      console.log(`         ${c.cyan}${short(s.r.title ?? "", WIDTH - 10)}${c.reset}`);
      console.log(`           ${row(s.r, s.checks)}`);
    } else if (s.kind === "answer") {
      console.log(`${at} ${c.bold}5. Picked the product${c.reset}`);
    }
  };

  const a = await runOursV11(task, onStep);
  console.log(`\n${c.bold}Answer${c.reset}  ${a.url ?? "no product"}`);
  console.log(markdown(wrap(a.response)));
  console.log(
    `\n${c.bold}${c.green}Done in ${(a.latencyMs / 1000).toFixed(1)}s · ${tokens(a.inputTokens + a.outputTokens)} Claude tokens${c.reset}` +
    ` ${c.dim}(+ ${tokens(a.jevTokens ?? 0)} on Jev, the small checking model) · ${amazonLiveCalls()} live Amazon lookups${c.reset}\n`,
  );
} else {
  throw new Error(`--system must be ours_v11 or baseline, not ${args.system}`);
}
