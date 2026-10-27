// Usage: node --env-file=.env evals/deepshop/run.ts [--system all|<name>[,<name>...]] [--pilot | --limit N] [--report | --judge-pending]
// Systems: ours, baseline, and one per provider in providers.ts. `all` runs every system whose API keys are set.
// --judge-pending judges answers written by other runners (browser_use/run.py) that have no verdict yet.
// Results append to evals/deepshop/results/{answers,verdicts}.jsonl; finished tasks are skipped on re-run.

import { parseArgs } from "node:util";
import { apiLiveCalls, appendJsonl, loadTasks, rainforestLiveCalls, readJsonl, type Answer, type Task } from "./common.ts";
import { runOurs } from "./ours.ts";
import { runBaseline } from "./baseline.ts";
import { judge, type Verdict } from "./judge.ts";
import { PROVIDERS } from "./providers.ts";
import { toolAgent } from "./tool_agent.ts";

const { values: args } = parseArgs({
  options: {
    system: { type: "string", default: "all" },
    pilot: { type: "boolean", default: false },
    limit: { type: "string" },
    report: { type: "boolean", default: false },
    "judge-pending": { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
  },
});

const ANSWERS = new URL("./results/answers.jsonl", import.meta.url);
const VERDICTS = new URL("./results/verdicts.jsonl", import.meta.url);
const SYSTEMS: Record<string, (t: Task) => Promise<Answer>> = {
  ours: runOurs,
  baseline: runBaseline,
  ...Object.fromEntries(PROVIDERS.map((p) => [p.system, toolAgent(p)])),
};
const REPORTED = [...Object.keys(SYSTEMS), "browser_use"];
const missingEnv = (system: string) => (PROVIDERS.find((p) => p.system === system)?.env ?? []).filter((e) => !process.env[e]);

let tasks = loadTasks();
if (args.pilot) tasks = tasks.filter((_, i) => i % 15 === 0); // 10 tasks spread over categories and difficulties
if (args.limit) tasks = tasks.slice(0, Number(args.limit));
let systems = args.system === "all" ? Object.keys(SYSTEMS) : args.system!.split(",");
for (const s of systems) {
  if (!SYSTEMS[s]) throw new Error(`unknown system ${s}; known: ${Object.keys(SYSTEMS).join(", ")}`);
  const missing = missingEnv(s);
  if (missing.length && !args.report) console.log(`skipping ${s}: ${missing.join(", ")} not set`);
}
systems = systems.filter((s) => !missingEnv(s).length);

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { for (let x; (x = queue.shift()); ) await fn(x); }));
}

if (args["judge-pending"]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const judged = new Set(readJsonl<Verdict>(VERDICTS).map((v) => `${v.system}:${v.taskId}`));
  const pending = readJsonl<Answer>(ANSWERS).filter((a) => !a.error && byId.has(a.taskId) && !judged.has(`${a.system}:${a.taskId}`));
  await pool(pending, Number(args.concurrency), async (a) => {
    const v = await judge(byId.get(a.taskId)!, a);
    appendJsonl(VERDICTS, v);
    console.log(`judge ${a.system} ${a.taskId} ${v.success ? "SUCCESS" : "NOT SUCCESS"} ${JSON.stringify(v.dims)}`);
  });
} else if (!args.report) {
  for (const system of systems) {
    const done = new Set(readJsonl<Answer>(ANSWERS).filter((a) => a.system === system && !a.error).map((a) => a.taskId));
    await pool(tasks.filter((t) => !done.has(t.id)), Number(args.concurrency), async (task) => {
      let answer: Answer;
      try {
        answer = await SYSTEMS[system](task);
      } catch (err) {
        answer = { taskId: task.id, system, asin: null, url: null, response: "", inputTokens: 0, outputTokens: 0, latencyMs: 0, rainforestCalls: 0, error: String(err) };
      }
      appendJsonl(ANSWERS, answer);
      console.log(`${system} ${task.id} ${answer.error ? "ERROR " + answer.error.slice(0, 120) : answer.asin ?? "no product"} ${(answer.latencyMs / 1000).toFixed(1)}s ${answer.inputTokens + answer.outputTokens} tok`);
      if (answer.error) return;
      const v = await judge(task, answer);
      appendJsonl(VERDICTS, v);
      console.log(`  judge ${v.success ? "SUCCESS" : "NOT SUCCESS"} ${JSON.stringify(v.dims)}`);
    });
  }
  console.log(`rainforest live calls this run: ${rainforestLiveCalls()}`);
  console.log(`provider live calls this run: ${JSON.stringify(apiLiveCalls())}`);
}

// ---------------------------------------------------------------------------
// Report: latest answer + verdict per (system, task), restricted to the selected tasks.

const ids = new Set(tasks.map((t) => t.id));
const latest = <T extends { taskId: string; system: string }>(rows: T[]) =>
  new Map(rows.filter((r) => ids.has(r.taskId)).map((r) => [`${r.system}:${r.taskId}`, r]));
const answers = latest(readJsonl<Answer>(ANSWERS));
const verdicts = latest(readJsonl<Verdict>(VERDICTS));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const rows = REPORTED.map((system) => {
  const a = [...answers.values()].filter((x) => x.system === system && !x.error);
  const v = a.map((x) => verdicts.get(`${system}:${x.taskId}`)).filter(Boolean) as Verdict[];
  if (!a.length) return null;
  const rate = (d: "attribute" | "filter" | "sort") => {
    const xs = v.filter((x) => x.dims[d] !== undefined);
    return xs.length ? `${Math.round((100 * xs.filter((x) => x.dims[d]).length) / xs.length)}%` : "-";
  };
  return {
    system,
    tasks: `${v.length}/${tasks.length}`,
    success: `${Math.round((100 * v.filter((x) => x.success).length) / Math.max(1, v.length))}%`,
    attribute: rate("attribute"),
    filter: rate("filter"),
    sort: rate("sort"),
    "median tokens": median(a.map((x) => x.inputTokens + x.outputTokens)),
    "median latency s": +(median(a.map((x) => x.latencyMs)) / 1000).toFixed(1),
    "amazon calls/task": +(a.reduce((s, x) => s + x.rainforestCalls, 0) / a.length).toFixed(1),
    "api calls/task": +(a.reduce((s, x) => s + (x.apiCalls ?? 0), 0) / a.length).toFixed(1),
  };
}).filter(Boolean);
console.table(rows);
