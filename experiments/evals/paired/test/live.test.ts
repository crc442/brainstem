import { expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE, CODING_TASKS, gradeCode, maximumRunCost } from "../live/protocol";
import { LiveTransport } from "../live/transport";
import { runLiveTask } from "../live/driver";

test("frozen live matrix fits the reservation ceiling; grader rejects unrelated edits", () => {
  expect(maximumRunCost()).toBeLessThan(LIVE.limits.perRunUsd);
  expect(maximumRunCost() * CODING_TASKS.length * LIVE.arms.length).toBeLessThan(LIVE.limits.studyUsd);
  const task = CODING_TASKS[0]!;
  const files = { ...task.files, [task.target]: JSON.stringify(task.expected) };
  expect(gradeCode(task, files).passed).toBe(true);
  expect(gradeCode(task, { ...files, "README.md": "unrelated edit" }).passed).toBe(false);
});

test("transport reserves before dispatch, makes no retries, and preserves unknown cache cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-budget-"));
  const key = process.env.ZAI_API_KEY; process.env.ZAI_API_KEY = "unit-test-placeholder";
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
    const failing = new LiveTransport(join(dir, "failure.jsonl"), new AbortController().signal, vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch);
    await expect(failing.request("main", body)).rejects.toThrow("503");
    expect(failing.calls).toHaveLength(1);
    expect(failing.calls[0]?.reservedUsd).toBeGreaterThan(0);
    expect(failing.calls[0]?.measuredCostUsd).toBeUndefined();
  } finally { if (key === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = key; rmSync(dir, { recursive: true, force: true }); }
});

test("live host dispatches normalized tool declarations and grades actual writes without provider calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-host-"));
  const key = process.env.ZAI_API_KEY; process.env.ZAI_API_KEY = "unit-test-placeholder";
  let count = 0;
  const task = CODING_TASKS[1]!;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    expect(request.tools.map((t: any) => t.function.name)).toContain("write");
    expect(request.messages[0].content).toContain("coding agent");
    const message = count++ === 0 ? { content: null, tool_calls: [{ id: "write-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: task.target, content: JSON.stringify(task.expected) }) } }] } : { content: "done" };
    return Response.json({ model: request.model, choices: [{ message, finish_reason: count === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 0 } } });
  }));
  try {
    const result = await runLiveTask(task, "baseline", join(dir, "calls.jsonl"));
    expect(result.status).toBe("completed"); expect(result.completed).toBe(true);
    expect(result.calls).toHaveLength(2); expect(result.approvals).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); if (key === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = key; rmSync(dir, { recursive: true, force: true }); }
});
