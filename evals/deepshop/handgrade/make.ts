// Blind hand-grading sheet: 30 seeded-random verdicts from the fresh run, system and judge verdict in a separate key.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getProduct, amazonPageText, readJsonl } from "../common.ts";
const root = new URL("../", import.meta.url).pathname;
const ids = new Set(readFileSync(process.argv[2], "utf8").split(/[\s,]+/).filter(Boolean));
const SYS = ["ours_v6","ours_v11","ours","ours_v4","parallel","exa","baseline","tavily","linkup"];
const tasks = new Map(readFileSync(root + "tasks.jsonl", "utf8").split("\n").filter(Boolean).map((l) => { const t = JSON.parse(l); return [t.id, t]; }));
const latest = (rows: any[]) => new Map(rows.filter((r) => ids.has(r.taskId) && SYS.includes(r.system)).map((r) => [`${r.system}:${r.taskId}`, r]));
const answers = latest(readJsonl<any>(new URL(`file://${root}results/scraperapi/answers.jsonl`)));
const verdicts = latest(readJsonl<any>(new URL(`file://${root}results/scraperapi/verdicts.jsonl`)));
const h = (s: string) => createHash("sha256").update("handgrade-2026-10-28:" + s).digest("hex");
const picked = [...verdicts.keys()].sort((a, b) => h(a).localeCompare(h(b))).slice(0, 30);
const csv = (xs: unknown[]) => xs.map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`).join(",");
const sheet = [csv(["#","task","attribute requirement","filter requirement","sort requirement","product url","title","price","rating","reviews","page facts (fetched 2026-10-28)","agent's answer","your verdict: attribute (pass/fail)","filter (pass/fail)","sort (pass/fail)","overall (pass/fail)","notes"])];
const key = [csv(["#","system","task","judge attribute","judge filter","judge sort","judge overall"])];
for (const [i, k] of picked.entries()) {
  const v = verdicts.get(k), a = answers.get(k), t = tasks.get(v.taskId);
  const p = a?.asin ? await getProduct(a.asin).catch(() => null) : null;
  const page = p ? await amazonPageText(a.asin).catch(() => "(page not fetched)") : null;
  const dim = (d: string) => (t[d] && t[d] !== "None" ? t[d] : "(none)");
  sheet.push(csv([i + 1, t.ques, dim("attribute"), dim("filter"), dim("sort"), a?.url ?? "(no product)", p?.title, p?.price?.raw ?? p?.price?.value ?? p?.price, p?.rating, p?.ratings_total ?? p?.reviews_total, page, a?.response?.slice(0, 1500)]));
  const j = (d: string) => (v.dims[d] === undefined ? "" : v.dims[d] ? "pass" : "fail");
  key.push(csv([i + 1, v.system, v.taskId, j("attribute"), j("filter"), j("sort"), v.success ? "pass" : "fail"]));
}
writeFileSync(root + "handgrade/sheet.csv", sheet.join("\n") + "\n");
writeFileSync(root + "handgrade/key.csv", key.join("\n") + "\n");
console.log(picked.map((k) => k.split(":")[0]).reduce((m: any, s) => ((m[s] = (m[s] ?? 0) + 1), m), {}), "judge passes:", picked.filter((k) => verdicts.get(k).success).length);
