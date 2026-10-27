// Usage: node --env-file=.env evals/deepshop/run.ts [--system all|<name>[,<name>...]] [--pilot | --test [--sample N [--offset M]] | --limit N] [--report | --judge-pending]
// --pilot is the dev set (10 tasks we tuned on); --test is the other 140, for reporting;
// --sample N keeps a fixed pseudo-random N of the selected tasks (ordered by a hash of the task id);
// --offset M skips the first M of that order, e.g. `--test --offset 70 --sample 20` for test tasks outside the published 70.
// AMAZON_DATA=scraperapi switches the Amazon data source; its results go to results/scraperapi/.
// AMAZON_SEARCH=serpapi sends only searches to SerpApi; AMAZON_MAX_LIVE_CALLS caps uncached Amazon lookups.
// Systems: ours, ours_jev/ours_v2/ours_v3/ours_v4 (need TYPESAFE_API_KEY), baseline, and one per provider in providers.ts. `all` runs every system whose API keys are set.
// --judge-pending judges answers written by other runners (browser_use/run.py) that have no verdict yet.
// --rejudge judges the selected systems' latest answers again (to record the judge's reasons); the new verdicts replace the old.
// It skips answers whose latest verdict already has reasons, so an interrupted re-judge resumes.
// Results append to evals/deepshop/results/{answers,verdicts}.jsonl; finished tasks are skipped on re-run.

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { AMAZON_DATA, apiLiveCalls, appendJsonl, loadTasks, amazonLiveCalls, readJsonl, type Answer, type Task } from "./common.ts";
import { runOurs } from "./ours.ts";
import { runOursJev, runOursV2, runOursV3, runOursV4 } from "./ours_jev.ts";
import { runBaseline } from "./baseline.ts";
import { judge, type Verdict } from "./judge.ts";
import { PROVIDERS } from "./providers.ts";
import { toolAgent } from "./tool_agent.ts";

const { values: args } = parseArgs({
  options: {
    system: { type: "string", default: "all" },
    pilot: { type: "boolean", default: false },
    test: { type: "boolean", default: false },
    sample: { type: "string" },
    offset: { type: "string", default: "0" },
    limit: { type: "string" },
    report: { type: "boolean", default: false },
    "judge-pending": { type: "boolean", default: false },
    rejudge: { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
  },
});

const RESULTS = AMAZON_DATA === "rainforest" ? "./results/" : `./results/${AMAZON_DATA}/`;
const ANSWERS = new URL(`${RESULTS}answers.jsonl`, import.meta.url);
const VERDICTS = new URL(`${RESULTS}verdicts.jsonl`, import.meta.url);
const SYSTEMS: Record<string, (t: Task) => Promise<Answer>> = {
  ours: runOurs,
  ours_jev: runOursJev,
  ours_v2: runOursV2,
  ours_v3: runOursV3,
  ours_v4: runOursV4,
  baseline: runBaseline,
  ...Object.fromEntries(PROVIDERS.map((p) => [p.system, toolAgent(p)])),
};
const REPORTED = [...Object.keys(SYSTEMS), "browser_use"];
const ENV: Record<string, string[]> = { ours_jev: ["TYPESAFE_API_KEY"], ours_v2: ["TYPESAFE_API_KEY"], ours_v3: ["TYPESAFE_API_KEY"], ours_v4: ["TYPESAFE_API_KEY"], ...Object.fromEntries(PROVIDERS.map((p) => [p.system, p.env])) };
const missingEnv = (system: string) => (ENV[system] ?? []).filter((e) => !process.env[e]);

let tasks = loadTasks();
const isPilot = (_: Task, i: number) => i % 15 === 0; // 10 tasks spread over categories and difficulties
if (args.pilot) tasks = tasks.filter(isPilot);
if (args.test) tasks = tasks.filter((t, i) => !isPilot(t, i));
if (args.sample) {
  const h = (id: string) => createHash("sha256").update(id).digest("hex");
  tasks = [...tasks].sort((a, b) => h(a.id).localeCompare(h(b.id))).slice(Number(args.offset), Number(args.offset) + Number(args.sample));
}
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

if (args["judge-pending"] || args.rejudge) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const latestVerdicts = new Map(readJsonl<Verdict>(VERDICTS).map((v) => [`${v.system}:${v.taskId}`, v]));
  const judged = new Set([...latestVerdicts].filter(([, v]) => !args.rejudge || v.reasons).map(([k]) => k));
  const latestAnswers = new Map(readJsonl<Answer>(ANSWERS).filter((a) => !a.error).map((a) => [`${a.system}:${a.taskId}`, a]));
  const pending = [...latestAnswers.values()].filter((a) =>
    byId.has(a.taskId) && !judged.has(`${a.system}:${a.taskId}`) && (!args.rejudge || systems.includes(a.system)));
  await pool(pending, Number(args.concurrency), async (a) => {
    let v: Verdict;
    try {
      v = await judge(byId.get(a.taskId)!, a);
    } catch (err) {
      console.log(`judge ${a.system} ${a.taskId} ERROR ${String(err).slice(0, 120)}`); // left pending for the next run
      return;
    }
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
  console.log(`amazon data (${AMAZON_DATA}) live calls this run: ${amazonLiveCalls()}`);
  console.log(`provider live calls this run: ${JSON.stringify(apiLiveCalls())}`);
}

// ---------------------------------------------------------------------------
// Report: latest answer + verdict per (system, task), restricted to the selected tasks.

const ids = new Set(tasks.map((t) => t.id));
const latest = <T extends { taskId: string; system: string }>(rows: T[]) =>
  new Map(rows.filter((r) => ids.has(r.taskId)).map((r) => [`${r.system}:${r.taskId}`, r]));
const answers = latest(readJsonl<Answer>(ANSWERS));
const verdicts = latest(readJsonl<Verdict>(VERDICTS));
/** 95% Wilson score interval for k successes out of n, in percent. */
const wilson = (k: number, n: number) => {
  if (!n) return "-";
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return `${Math.round(100 * Math.max(0, c - h))}-${Math.round(100 * Math.min(1, c + h))}%`;
};
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
    // Over every task in the split: a task the system never answered counts as a failure.
    success: `${Math.round((100 * v.filter((x) => x.success).length) / tasks.length)}%`,
    "95% CI": wilson(v.filter((x) => x.success).length, tasks.length),
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
