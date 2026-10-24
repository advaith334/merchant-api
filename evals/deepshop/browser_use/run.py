"""Browser Use baseline: an open-source browser agent (Claude driving a real
headless Chromium) shopping on live Amazon, the way DeepShop's web agents do.

Writes answers in the same shape as run.ts to results/answers.jsonl with
system "browser_use"; judge them with `run.ts --judge-pending`.

Usage: python evals/deepshop/browser_use/run.py [--pilot] [--ids Amazon--31,...] [--max-steps 40]
Needs ANTHROPIC_API_KEY. If Amazon shows a CAPTCHA the agent must not solve it;
the task is recorded as failed with error "blocked".
"""

import argparse
import asyncio
import json
import os
import re
import time
from pathlib import Path

from browser_use import Agent, BrowserProfile
from browser_use.llm import ChatAnthropic

HERE = Path(__file__).resolve().parent.parent
TASKS = HERE / "tasks.jsonl"
ANSWERS = HERE / "results" / "answers.jsonl"
# browser-use 0.13 forces tool_choice on every step, which Opus 5.5 rejects (400) and
# ignores in auto mode, so the browser agent runs on the previous Opus with API thinking off.
# use_thinking=False drops browser-use's "thinking" output field, which Opus 5 refuses to fill.
MODEL = "claude-opus-5"

INSTRUCTIONS = (
    "You are a shopping agent. Complete the task below on amazon.com using the browser. "
    "Answer with the single product that best satisfies it and any information the task asks for. "
    "End your answer with one line of the form `FINAL_URL: https://www.amazon.com/dp/<ASIN>`. "
    "If Amazon shows a CAPTCHA or bot check, do not try to solve it: stop and answer `BLOCKED`."
)


def asin_from(text: str | None) -> str | None:
    m = re.search(r"(?:/dp/|/gp/product/|/gp/aw/d/)([A-Z0-9]{10})", text or "")
    return m.group(1) if m else None


async def run_task(task: dict, max_steps: int) -> dict:
    t0 = time.time()
    agent = Agent(
        task=f"{INSTRUCTIONS}\n\nTask: {task['ques']}",
        llm=ChatAnthropic(model=MODEL, max_tokens=16000, thinking={"type": "disabled"}),
        browser_profile=BrowserProfile(headless=True, executable_path=os.environ.get("BROWSER_PATH")),
        calculate_cost=True,
        use_thinking=False,
    )
    error = None
    try:
        history = await agent.run(max_steps=max_steps)
        text = history.final_result() or ""
        urls = [u for u in history.urls() if u]
        usage = history.usage
    except Exception as e:  # noqa: BLE001 - record and move on
        text, urls, usage, error = "", [], None, repr(e)[:300]
    finally:
        await agent.close()

    final = re.search(r"FINAL_URL:\s*(\S+)", text)
    asin = asin_from(final.group(1) if final else None) or asin_from(text) or next(
        (a for a in map(asin_from, reversed(urls)) if a), None
    )
    if not text and not error:
        error = "no_final_result"
    if "BLOCKED" in text or any("captcha" in u.lower() for u in urls):
        error = error or "blocked"
    return {
        "taskId": task["id"],
        "system": "browser_use",
        "asin": asin,
        "url": f"https://www.amazon.com/dp/{asin}" if asin else None,
        "response": re.sub(r"FINAL_URL:.*$", "", text, flags=re.M).strip(),
        "inputTokens": usage.total_prompt_tokens if usage else 0,
        "outputTokens": usage.total_completion_tokens if usage else 0,
        "latencyMs": int((time.time() - t0) * 1000),
        "rainforestCalls": 0,
        "steps": len(urls),
        "costUsd": round(usage.total_cost, 4) if usage else None,
        **({"error": error} if error else {}),
    }


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--pilot", action="store_true")
    p.add_argument("--ids")
    p.add_argument("--max-steps", type=int, default=40)
    args = p.parse_args()

    tasks = [json.loads(l) for l in TASKS.read_text().splitlines() if l.strip()]
    if args.pilot:
        tasks = tasks[::15]
    if args.ids:
        wanted = set(args.ids.split(","))
        tasks = [t for t in tasks if t["id"] in wanted]

    done = set()
    if ANSWERS.exists():
        for l in ANSWERS.read_text().splitlines():
            a = json.loads(l)
            if a["system"] == "browser_use" and not a.get("error"):
                done.add(a["taskId"])

    ANSWERS.parent.mkdir(exist_ok=True)
    for task in tasks:  # one browser at a time: parallel sessions look more like a bot
        if task["id"] in done:
            continue
        a = await run_task(task, args.max_steps)
        with ANSWERS.open("a") as f:
            f.write(json.dumps(a) + "\n")
        print(f"browser_use {task['id']} {a.get('error') or a['asin'] or 'no product'} "
              f"{a['latencyMs'] / 1000:.0f}s {a['inputTokens'] + a['outputTokens']} tok ${a['costUsd']}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
