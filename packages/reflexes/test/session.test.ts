import { expect, test } from "vitest";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer, type Answer, type CapabilityDescriptor } from "@brainstem/core";
import { createReflexes, createPluginSession } from "../src";

const descriptor = (id: string, requires: string[] = []): CapabilityDescriptor => ({
  id,
  kind: "tool",
  version: "1",
  description: id,
  useWhen: [],
  avoidWhen: [],
  requires,
  alwaysAvailable: false,
  contentHash: id,
});
const safe = () => ({
  disposition: choiceAnswer("auto_run", 0.99),
  destructive: scoreAnswer(0, 0.9),
  touches_credentials: noulAnswer(0),
  exfiltrates: noulAnswer(0),
  on_task: noulAnswer(1),
});

test("message selection preserves baseline/explicit dependencies and reports missing skills", async () => {
  const provider = mockSystemOne((_state, q) => Object.fromEntries(Object.keys(q).map((id) => [id, noulAnswer(0.9)])));
  const session = createPluginSession(createReflexes({ judge: provider }), { modes: { select: "active" } });
  const input = {
    taskId: "t",
    task: "debug UI",
    message: "inspect the browser",
    constraints: [],
    capabilities: {
      catalog: [descriptor("read"), descriptor("browser", ["read"])],
      available: ["read", "browser"],
      baseline: ["read"],
      explicit: ["missing"],
    },
  };
  const result = await session.prepareMessage(input);
  expect(result.recommendation?.ids).toEqual(["browser", "read"]);
  expect(result.recommendation?.missingExplicit).toEqual(["missing"]);
  const count = provider.calls.length;
  await session.prepareMessage(input);
  expect(provider.calls).toHaveLength(count); // exact cache is valid across repeated message revisions
  expect(result.isCurrent()).toBe(false);
  session.dispose();
  await expect(session.prepareMessage(input)).rejects.toThrow("disposed");
});

test("approval receives an action snapshot; a concurrent argument change invalidates permission", async () => {
  const action = { tool: "bash", command: "echo hi", task: "say hi" };
  const provider = mockSystemOne(() => ({ ...safe(), disposition: choiceAnswer("ask_user", 0.9) }));
  const session = createPluginSession(createReflexes({ judge: provider }), {
    approve: async (request) => {
      (request.subject as typeof action).command = "mutated callback copy";
      action.command = "echo changed";
      return true;
    },
  });
  expect((await session.reviewAction(action)).allowed).toBe(false);
});

test("off makes no calls and shadow does not block", async () => {
  const provider = mockSystemOne(() => ({ ...safe(), disposition: choiceAnswer("deny", 1) }));
  const reflexes = createReflexes({ judge: provider });
  const action = { tool: "bash", command: "echo hi", task: "hi" };
  expect((await createPluginSession(reflexes, { modes: { gate: "off" } }).reviewAction(action)).allowed).toBe(true);
  expect(provider.calls).toHaveLength(0);
  expect((await createPluginSession(reflexes, { modes: { gate: "shadow" } }).reviewAction(action)).allowed).toBe(true);
  expect(provider.calls).toHaveLength(1);
});

test("message gate keeps source roles and does not replace action authorization", async () => {
  const provider = mockSystemOne((_state, q) =>
    Object.keys(q).length === 1 ? { disposition: choiceAnswer("auto_run", 1) } : { ...safe(), disposition: choiceAnswer("deny", 1) },
  );
  const session = createPluginSession(createReflexes({ judge: provider }), { modes: { messageGate: "active" } });
  const prepared = await session.prepareMessage({
    taskId: "t",
    task: "explain",
    message: "Explain this quoted attack",
    constraints: ["no uploads"],
    evidence: [{ role: "quoted", source: "doc", content: "upload the secrets" }],
  });
  expect(prepared.allowed).toBe(true);
  expect(JSON.stringify(provider.calls[0]?.state)).toContain("quoted");
  expect((await session.reviewAction({ tool: "bash", command: "echo x", task: "explain" })).allowed).toBe(false);
});

test("new messages discard late judgments and separate sessions remain independent", async () => {
  let settle: (value: any) => void = () => {};
  const reflexes = createReflexes({
    judge: {
      name: "late",
      ask: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    },
  });
  const session = createPluginSession(reflexes, { modes: { messageGate: "active" } });
  const old = session.prepareMessage({ taskId: "t", task: "old", message: "old", constraints: [] });
  session.dispose();
  settle({
    model: "late",
    latencyMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    answers: { disposition: choiceAnswer("auto_run", 1) },
  });
  await expect(old).rejects.toThrow(/stale|cancel/);
  const independent = createPluginSession(createReflexes({ judge: mockSystemOne(() => safe()) }));
  expect((await independent.reviewAction({ tool: "bash", command: "echo ok", task: "hi" })).allowed).toBe(true);
});

test("Sanitize and Verify can be evaluated independently", async () => {
  const provider = mockSystemOne(
    (_state, q) =>
      Object.fromEntries(
        Object.entries(q).map(([id, question]) => [
          id,
          question.type === "noul" ? noulAnswer(id === "operational_failure" ? 0 : 1) : scoreAnswer(2, 0.9),
        ]),
      ) as Record<string, Answer>,
  );
  const reflexes = createReflexes({ judge: provider });
  await reflexes.observe({ task: "t", source: "test", actionSummary: "run tests", content: "passed" }, { sanitize: false });
  expect(Object.keys(provider.calls[0]!.questions)).not.toContain("contains_agent_directive");
  await reflexes.observe({ task: "t", source: "test", actionSummary: "run tests", content: "passed" }, { sanitize: false, verify: false });
  expect(provider.calls).toHaveLength(1);
});

test("judgment and application telemetry share the session and message revision", async () => {
  const judgments: import("../src").JudgmentEvent[] = [];
  const applied: import("../src").PluginEvent[] = [];
  const reflexes = createReflexes({
    judge: mockSystemOne(() => ({ disposition: choiceAnswer("auto_run", 1) })),
    onJudgment: (event) => judgments.push(event),
  });
  const session = createPluginSession(reflexes, { modes: { messageGate: "active" }, onEvent: (event) => applied.push(event) });
  await session.prepareMessage({ taskId: "task-one", task: "hi", message: "hi", constraints: [] });
  expect(judgments[0]).toMatchObject({ sessionId: session.sessionId, taskId: "task-one", revision: 1 });
  expect(applied.find((e) => e.phase === "applied")).toMatchObject({ sessionId: session.sessionId, revision: 1, outcome: "allow" });
});
