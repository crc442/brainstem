import { expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE, CODING_TASKS, gradeCode, authorized, maximumRunCost } from "../live/protocol";
import { LiveTransport } from "../live/transport";
import { runLiveTask } from "../live/driver";
import { choiceAnswer, noulAnswer, scoreAnswer } from "@brainstem/core";

test("frozen live matrix fits the reservation ceiling; grader rejects unrelated edits", () => {
  expect(maximumRunCost()).toBeLessThan(LIVE.limits.perRunUsd);
  expect(maximumRunCost() * CODING_TASKS.length * LIVE.arms.length + LIVE.priorStudyCostUpperUsd).toBeLessThan(LIVE.limits.studyUsd);
  const task = CODING_TASKS[0]!;
  const files = { ...task.files, [task.target]: JSON.stringify(task.expected) };
  expect(gradeCode(task, files).passed).toBe(true);
  expect(gradeCode(task, { ...files, "README.md": "unrelated edit" }).passed).toBe(false);
});

test("approval oracle allows authorized reads, recovery and checks as well as the requested write", () => {
  const task = CODING_TASKS[0]!;
  for (const tool of ["read", "read_output", "check", "project_help"]) expect(authorized(task, { tool, path: "build.log" })).toBe(true);
  expect(authorized(task, { tool: "write", path: task.target })).toBe(true);
  expect(authorized(task, { tool: "write", path: "audit.json" })).toBe(false);
  expect(authorized(task, { tool: "unknown" })).toBe(false);
  expect(authorized(task, { message: `${task.objective}\nFiles: ${Object.keys(task.files).join(", ")}` })).toBe(true);
  expect(authorized(task, { message: "unauthorized replacement" })).toBe(false);
});

test("transport reserves before dispatch, makes no retries, and preserves unknown cache cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-budget-"));
  const key = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = "unit-test-placeholder";
  try {
    const path = join(dir, "calls.jsonl");
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      const last = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!);
      expect(last.status).toBe("reserved");
      return Response.json({ model: LIVE.models.primary, usage: { prompt_tokens: 100, completion_tokens: 10 } });
    });
    const transport = new LiveTransport(path, new AbortController().signal, fetcher as unknown as typeof fetch);
    const body = { model: LIVE.models.primary, max_tokens: LIVE.limits.outputTokens, thinking: { type: "disabled" }, stream: false };
    for (let i = 0; i < LIVE.limits.mainCalls; i++) await transport.request("main", body);
    await expect(transport.request("main", body)).rejects.toThrow("call budget");
    expect(calls).toBe(6);
    expect(transport.calls[0]?.measuredCostUsd).toBeNull();
    expect(transport.calls[0]?.uncachedCostUpperUsd).toBeGreaterThan(0);
    const failing = new LiveTransport(
      join(dir, "failure.jsonl"),
      new AbortController().signal,
      vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
    );
    await expect(failing.request("main", body)).rejects.toThrow("503");
    expect(failing.calls).toHaveLength(1);
    expect(failing.calls[0]?.reservedUsd).toBeGreaterThan(0);
    expect(failing.calls[0]?.measuredCostUsd).toBeUndefined();
  } finally {
    if (key === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = key;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Jev's known input price does not manufacture a provider cache measurement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-judge-cache-"));
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "unit-test-placeholder";
  try {
    const transport = new LiveTransport(
      join(dir, "calls.jsonl"),
      new AbortController().signal,
      vi.fn(async () =>
        Response.json({ model: LIVE.models.judge, usage: { input_tokens: 100, output_tokens: 20 } }),
      ) as unknown as typeof fetch,
    );
    await transport.request("judge", { model: LIVE.models.judge, state: "fixture", questions: {} });
    expect(transport.calls[0]?.cachedTokens).toBeNull();
    expect(transport.calls[0]?.measuredCostUsd).toBe((100 * 0.042) / 1e6);
  } finally {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live host dispatches normalized tool declarations and grades actual writes without provider calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-host-"));
  const key = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = "unit-test-placeholder";
  let count = 0;
  const task = CODING_TASKS[1]!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      expect(request.tools.map((t: any) => t.function.name)).toContain("write");
      expect(request.messages[0].content).toContain("coding agent");
      const message =
        count++ === 0
          ? {
              content: null,
              tool_calls: [
                {
                  id: "write-1",
                  type: "function",
                  function: { name: "write", arguments: JSON.stringify({ path: task.target, content: JSON.stringify(task.expected) }) },
                },
              ],
            }
          : { content: "done" };
      return Response.json({
        model: request.model,
        choices: [{ message, finish_reason: count === 1 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 0 } },
      });
    }),
  );
  try {
    const result = await runLiveTask(task, "baseline", join(dir, "calls.jsonl"));
    expect(result.status).toBe("completed");
    expect(result.completed).toBe(true);
    expect(result.calls).toHaveLength(2);
    expect(result.approvals).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
    if (key === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = key;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full plugin reuses host authorizations for reads/checks/writes without duplicate prompts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-approval-"));
  const saved = { ZAI_API_KEY: process.env.ZAI_API_KEY, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
  process.env.ZAI_API_KEY = process.env.TYPESAFE_API_KEY = "unit-test-placeholder";
  const task = CODING_TASKS[1]!;
  let index = 0;
  const steps = [
    { name: "read", args: { path: "README.md" } },
    { name: "check", args: {} },
    { name: "write", args: { path: task.target, content: JSON.stringify(task.expected) } },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      if (request.questions)
        return Response.json({
          model: LIVE.models.judge,
          usage: { input_tokens: 100, output_tokens: 20 },
          answers: Object.fromEntries(
            Object.entries(request.questions).map(([id, q]: [string, any]) => [
              id,
              q.type === "choice"
                ? choiceAnswer(id === "model_tier" ? "frontier" : "ask_user", 0.99)
                : q.type === "score"
                  ? scoreAnswer(["result_quality", "worth_continuing"].includes(id) ? 2 : 0, 0.99)
                  : noulAnswer(
                      ["on_task", "satisfies_intent", "evidence_of_success", "progressing", "approach_changed"].includes(id) ? 0.99 : 0.01,
                    ),
            ]),
          ),
        });
      const step = steps[index++];
      const message = step
        ? { tool_calls: [{ id: `call-${index}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
        : { content: "done" };
      return Response.json({
        model: request.model,
        choices: [{ message, finish_reason: step ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 0 } },
      });
    }),
  );
  try {
    const result = await runLiveTask(task, "full", join(dir, "calls.jsonl"));
    expect(result.completed).toBe(true);
    expect(result.effects.map((e) => e.name)).toEqual(["read", "check", "write"]);
    // Incoming message approval is distinct; all three tool authorizations reuse
    // the host's invocation-specific decision. The write still prompts once.
    expect(result.approvals).toEqual([
      { boundary: "plugin", allowed: true },
      { boundary: "host", allowed: true },
    ]);
    expect(
      result.events.filter((event) => event.flow === "gate" && event.phase === "applied" && event.approvalSource === "host"),
    ).toHaveLength(3);
    expect(result.approvals.every((a) => a.allowed)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});
