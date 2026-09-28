import { expect, test, vi } from "vitest";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createReflexes } from "@brainstem/reflexes";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer, hashAction, type Answer, type CapabilityDescriptor } from "@brainstem/core";
import { attachReflexes } from "../src";
import { createHarness } from "../../cli/src/harness";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function message(content: AssistantMessage["content"], stopReason: "toolUse" | "stop"): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "main",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function scripted(script: AssistantMessage[], seen: { model: string; context: any }[]): StreamFn {
  let i = 0;
  return (model, context) => {
    seen.push({ model: model?.id, context: structuredClone(context) });
    const stream = createAssistantMessageEventStream();
    const m = script[Math.min(i++, script.length - 1)]!;
    queueMicrotask(() => {
      stream.push({ type: "done", reason: m.stopReason as "stop", message: m });
      stream.end(m);
    });
    return stream;
  };
}
const done = message([{ type: "text", text: "done" }], "stop");
function tool(name: string, text: string, executed = () => {}): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, command: { type: "string" }, content: { type: "string" } },
    } as never,
    execute: async () => {
      executed();
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}
const provider = () =>
  mockSystemOne(
    (_state, q) =>
      Object.fromEntries(
        Object.entries(q).map(([id, question]) => [
          id,
          question.type === "choice"
            ? choiceAnswer(id === "model_tier" ? "mini" : "auto_run", 0.99)
            : question.type === "score"
              ? scoreAnswer(id === "result_quality" || id === "worth_continuing" ? 2 : 0, 0.99)
              : noulAnswer(
                  ["on_task", "satisfies_intent", "evidence_of_success", "progressing"].includes(id) || id.startsWith("select__")
                    ? 0.99
                    : 0.01,
                ),
        ]),
      ) as Record<string, Answer>,
  );
const desc: CapabilityDescriptor = {
  id: "browser",
  kind: "tool",
  description: "inspect browser",
  version: "1",
  contentHash: "v1",
  requires: [],
  useWhen: [],
  avoidWhen: [],
  alwaysAvailable: false,
};

test("prompt wrapper loads and uses a suggested tool, routes actual requests, then restores hooks", async () => {
  const seen: { model: string; context: any }[] = [];
  let executions = 0;
  let applications = 0;
  const agent = new Agent({
    initialState: { model: { id: "main" } as never, tools: [] },
    streamFn: scripted([message([{ type: "toolCall", id: "b", name: "browser", arguments: {} }], "toolUse"), done], seen),
  });
  const oldBefore = agent.beforeToolCall;
  const oldStream = agent.streamFunction;
  const plugin = attachReflexes(agent, createReflexes({ judge: provider() }), {
    cwd: "/tmp",
    modes: { select: "active", steer: "active", messageGate: "active" },
    miniModel: { id: "mini" } as never,
    capabilities: () => ({ catalog: [desc], available: ["browser"], baseline: [] }),
    loadCapabilities: async (r) => {
      applications++;
      return { tools: r.ids.includes("browser") ? [tool("browser", "UI inspected", () => executions++)] : [] };
    },
  });
  await plugin.prompt("inspect the UI");
  expect(executions).toBe(1);
  expect(seen[0]?.model).toBe("mini");
  expect(JSON.stringify(seen[0]?.context)).toContain("browser");
  await plugin.prompt("inspect the UI");
  expect(applications).toBe(1);
  plugin.dispose();
  expect(agent.beforeToolCall).toBe(oldBefore);
  expect(agent.streamFunction).toBe(oldStream);
});

test("message deny prevents dispatch; advisory mode passes the same judgment", async () => {
  const seen: { model: string; context: any }[] = [];
  const judge = mockSystemOne(() => ({ disposition: choiceAnswer("deny", 0.99) }));
  for (const behavior of ["enforce", "advisory"] as const) {
    const agent = new Agent({ streamFn: scripted([done], seen) });
    const plugin = attachReflexes(agent, createReflexes({ judge }), {
      cwd: "/tmp",
      modes: { messageGate: "active" },
      gateBehavior: behavior,
    });
    if (behavior === "enforce") await expect(plugin.prompt("expose secrets")).rejects.toThrow("denied");
    else await plugin.prompt("expose secrets");
    plugin.dispose();
  }
  expect(seen).toHaveLength(1);
});

test("write evidence is reviewed and approval mutation cannot change executed arguments", async () => {
  const agent = new Agent({ streamFn: scripted([done], []) });
  const args = { path: "file.txt", content: "approved bytes" };
  let review: any;
  const judge = mockSystemOne((state) => {
    review = state;
    return { ...providerAnswers(), disposition: choiceAnswer("ask_user", 0.99) };
  });
  const plugin = attachReflexes(agent, createReflexes({ judge, root: "/tmp" }), {
    cwd: "/tmp",
    actionEvidence: async () => ({ changeSummary: "+approved bytes" }),
    approve: async (r) => {
      (r.subject as any).arguments.content = "callback mutation";
      args.content = "concurrent mutation";
      return true;
    },
  });
  const result = await agent.beforeToolCall!({ toolCall: { id: "w", name: "write", arguments: args }, args } as never);
  expect(review.action.changeSummary).toBe("+approved bytes");
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("changed");
  plugin.dispose();
});
function providerAnswers(): Record<string, Answer> {
  return {
    destructive: scoreAnswer(0, 1),
    touches_credentials: noulAnswer(0),
    exfiltrates: noulAnswer(0),
    on_task: noulAnswer(1),
    disposition: choiceAnswer("auto_run", 1),
  };
}

for (const adapter of ["cli", "pi"] as const) {
  test(`${adapter}: one approval per write, and changed writes require a fresh approval`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brainstem-approval-contract-"));
    const approved: string[] = [];
    const duplicatePrompt = vi.fn(async () => true);
    const judge = mockSystemOne(() => ({ ...providerAnswers(), disposition: choiceAnswer("ask_user", 0.99) }));
    const script = ["first", "changed"].map((content, i) =>
      message([{ type: "toolCall", id: `w${i}`, name: "write", arguments: { path: "note.txt", content } }], "toolUse"),
    );
    script.push(done);
    let dispose = () => {};
    try {
      let prompt: (text: string) => Promise<void>;
      if (adapter === "cli") {
        const harness = createHarness({
          cwd,
          trust: 0.3,
          journalPath: join(cwd, "journal.ndjson"),
          model: undefined as never,
          streamFn: scripted(script, []),
          systemOne: judge,
          reflexModes: { select: "off", sanitize: "off", verify: "off", pulse: "off" },
          approvalHandler: async (request) => {
            approved.push((request.validatedArgs as { content: string }).content);
            return "approve_once";
          },
        });
        prompt = (text) => harness.prompt(text);
        dispose = () => harness.endSession();
      } else {
        const hostApprovals = new Map<string, string>();
        const agent = new Agent({
          streamFn: scripted(script, []),
          initialState: {
            tools: [
              {
                ...tool("write", "written"),
                execute: async (_id, args) => {
                  const value = args as { path: string; content: string };
                  writeFileSync(join(cwd, value.path), value.content);
                  return { content: [{ type: "text", text: "written" }], details: {} };
                },
              },
            ],
          },
          beforeToolCall: async (context) => {
            approved.push((context.args as { content: string }).content);
            hostApprovals.set(context.toolCall.id, hashAction(context.args));
          },
        });
        const handle = attachReflexes(agent, createReflexes({ judge, root: cwd }), {
          cwd,
          modes: { sanitize: "off", verify: "off" },
          approve: duplicatePrompt,
          resolveActionApproval: async (review) => {
            const prior = hostApprovals.get(review.toolCallId);
            hostApprovals.delete(review.toolCallId);
            return prior === hashAction((review.subject as { arguments: unknown }).arguments) ? "approved" : "unknown";
          },
        });
        prompt = (text) => handle.prompt(text);
        dispose = () => handle.dispose();
      }
      await prompt("Write first then changed to note.txt.");
      expect(approved).toEqual(["first", "changed"]);
      expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("changed");
      expect(duplicatePrompt).not.toHaveBeenCalled();
    } finally {
      dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("a nonblocking host hook is not implicit approval", async () => {
  const approve = vi.fn(async () => true);
  const agent = new Agent({ streamFn: scripted([done], []), beforeToolCall: async () => undefined });
  const plugin = attachReflexes(
    agent,
    createReflexes({ judge: mockSystemOne(() => ({ ...providerAnswers(), disposition: choiceAnswer("ask_user", 0.99) })) }),
    {
      cwd: "/tmp",
      approve,
    },
  );
  const args = { command: "echo hi" };
  expect((await agent.beforeToolCall!({ toolCall: { id: "b", name: "bash", arguments: args }, args } as never))?.block).not.toBe(true);
  expect(approve).toHaveBeenCalledTimes(1);
  plugin.dispose();
});

test.each(["host", "lookup"] as const)("argument mutation during %s invalidates authorization before another prompt", async (phase) => {
  const args = { path: "note.txt", content: "before" };
  const approve = vi.fn(async () => true);
  const agent = new Agent({
    streamFn: scripted([done], []),
    beforeToolCall: async () => {
      if (phase === "host") args.content = "changed";
    },
  });
  const resolver = vi.fn(async () => {
    if (phase === "lookup") args.content = "changed";
    return "unknown" as const;
  });
  const plugin = attachReflexes(
    agent,
    createReflexes({ judge: mockSystemOne(() => ({ ...providerAnswers(), disposition: choiceAnswer("ask_user", 0.99) })) }),
    {
      cwd: "/tmp",
      approve,
      resolveActionApproval: resolver,
    },
  );
  const result = await agent.beforeToolCall!({ toolCall: { id: "w", name: "write", arguments: args }, args } as never);
  expect(result?.block).toBe(true);
  expect(approve).not.toHaveBeenCalled();
  expect(resolver).toHaveBeenCalledTimes(phase === "host" ? 0 : 1);
  plugin.dispose();
});

test("host denial remains authoritative even with an approval resolver", async () => {
  const resolver = vi.fn(async () => "approved" as const);
  const judge = provider();
  const agent = new Agent({ streamFn: scripted([done], []), beforeToolCall: async () => ({ block: true, reason: "host denied" }) });
  const plugin = attachReflexes(agent, createReflexes({ judge }), { cwd: "/tmp", resolveActionApproval: resolver });
  const args = { command: "echo hi" };
  expect(await agent.beforeToolCall!({ toolCall: { id: "b", name: "bash", arguments: args }, args } as never)).toEqual({
    block: true,
    reason: "host denied",
  });
  expect(resolver).not.toHaveBeenCalled();
  expect(judge.calls).toHaveLength(0);
  plugin.dispose();
});

test("cancellation stops waiting for an uncooperative host hook", async () => {
  const agent = new Agent({ streamFn: scripted([done], []), beforeToolCall: () => new Promise(() => {}) });
  const plugin = attachReflexes(agent, createReflexes({ judge: provider() }), { cwd: "/tmp" });
  const args = { command: "echo hi" };
  const controller = new AbortController();
  const pending = agent.beforeToolCall!({ toolCall: { id: "b", name: "bash", arguments: args }, args } as never, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow(/cancel/);
  plugin.dispose();
});

test("concurrent identical actions keep invocation-specific host authorization", async () => {
  const seen: string[] = [];
  const approve = vi.fn(async () => false);
  const agent = new Agent({ streamFn: scripted([done], []), beforeToolCall: async () => undefined });
  const plugin = attachReflexes(
    agent,
    createReflexes({ judge: mockSystemOne(() => ({ ...providerAnswers(), disposition: choiceAnswer("ask_user", 0.99) })) }),
    {
      cwd: "/tmp",
      approve,
      resolveActionApproval: async (review) => {
        seen.push(review.toolCallId);
        await Promise.resolve();
        return review.toolCallId === "approved" ? "approved" : "unknown";
      },
    },
  );
  const results = await Promise.all(
    ["approved", "other"].map((id) => {
      const args = { command: "echo hi" };
      return agent.beforeToolCall!({ toolCall: { id, name: "bash", arguments: args }, args } as never);
    }),
  );
  expect(results[0]?.block).not.toBe(true);
  expect(results[1]?.block).toBe(true);
  expect(seen.sort()).toEqual(["approved", "other"]);
  expect(approve).toHaveBeenCalledTimes(1);
  plugin.dispose();
});

test("Pulse can stop at the host checkpoint without dispatching another request", async () => {
  const seen: { model: string; context: any }[] = [];
  const judge = mockSystemOne((_state, questions) =>
    Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [
        id,
        q.type === "score" ? scoreAnswer(0, 1) : noulAnswer(id === "repeating" || id === "stuck_on_same_error" ? 1 : 0),
      ]),
    ),
  );
  const agent = new Agent({
    streamFn: scripted([message([{ type: "toolCall", id: "t", name: "probe", arguments: {} }], "toolUse"), done], seen),
    initialState: { tools: [tool("probe", "same failure")] },
  });
  const plugin = attachReflexes(agent, createReflexes({ judge }), {
    cwd: "/tmp",
    modes: { pulse: "active", gate: "off", sanitize: "off", verify: "off" },
    pulseEveryTurns: 1,
  });
  await plugin.prompt("fix this");
  expect(seen).toHaveLength(1);
  plugin.dispose();
});

for (const adapter of ["cli", "pi"] as const) {
  test(`${adapter}: Pulse cannot reopen a task after its final answer`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainstem-pulse-final-"));
    try {
      writeFileSync(join(dir, "log.txt"), "PASS checks");
      const seen: { model: string; context: any }[] = [];
      const script = [message([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "log.txt" } }], "toolUse"), done];
      const judge = mockSystemOne((_state, questions) =>
        Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "score" ? scoreAnswer(2, 0.99) : noulAnswer(id === "repeating" ? 0.99 : 0.01),
          ]),
        ),
      );
      const modes = {
        select: "off",
        focus: "off",
        messageGate: "off",
        gate: "off",
        sanitize: "off",
        verify: "off",
        steer: "off",
        pulse: "active",
      } as const;
      if (adapter === "cli") {
        const harness = createHarness({
          cwd: dir,
          systemOne: judge,
          streamFn: scripted(script, seen),
          model: { id: "main" } as never,
          trust: 0.3,
          journalPath: join(dir, "journal.jsonl"),
          reflexModes: modes,
          pulseEveryTurns: 2,
        });
        try {
          await harness.prompt("Check the log and finish.");
        } finally {
          harness.endSession();
        }
      } else {
        const agent = new Agent({
          initialState: { model: { id: "main" } as never, tools: [tool("read", "PASS checks")] },
          streamFn: scripted(script, seen),
        });
        const plugin = attachReflexes(agent, createReflexes({ judge, root: dir }), { cwd: dir, modes, pulseEveryTurns: 2 });
        try {
          await plugin.prompt("Check the log and finish.");
        } finally {
          plugin.dispose();
        }
      }
      expect(seen).toHaveLength(2);
      expect(judge.calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${adapter}: long error/output evidence is bounded and only the reviewed view reaches the next request`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainstem-contract-"));
    try {
      const source = "x".repeat(9000) + "UNREVIEWED_TAIL";
      writeFileSync(join(dir, "log.txt"), source);
      const seen: { model: string; context: any }[] = [];
      const script = [message([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "log.txt" } }], "toolUse"), done];
      const judge = provider();
      if (adapter === "cli") {
        const harness = createHarness({
          cwd: dir,
          systemOne: judge,
          streamFn: scripted(script, seen),
          model: undefined as never,
          trust: 0.3,
          journalPath: join(dir, "journal.jsonl"),
        });
        await harness.prompt("read diagnostics");
        harness.endSession();
      } else {
        const agent = new Agent({ streamFn: scripted(script, seen), initialState: { tools: [tool("read", source)] } });
        const plugin = attachReflexes(agent, createReflexes({ judge, root: dir }), { cwd: dir });
        await plugin.prompt("read diagnostics");
        plugin.dispose();
      }
      const observed = judge.calls.find((call) => "contains_agent_directive" in call.questions)?.state as { content: string };
      const delivered = JSON.stringify(seen[1]?.context);
      expect(observed.content.length).toBeLessThanOrEqual(8000);
      expect(delivered).not.toContain("UNREVIEWED_TAIL");
      expect(delivered).toContain(observed.content.slice(0, 100));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const adapter of ["cli", "pi"] as const) {
  test(`${adapter}: all reflexes off dispatch no judgments; message Gate blocks before any model call`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainstem-modes-"));
    try {
      const seen: { model: string; context: any }[] = [];
      const judge = mockSystemOne(() => ({ disposition: choiceAnswer("deny", 1) }));
      const modes = {
        select: "off",
        focus: "off",
        messageGate: "off",
        gate: "off",
        sanitize: "off",
        verify: "off",
        pulse: "off",
        steer: "off",
      } as const;
      if (adapter === "cli") {
        const h = createHarness({
          cwd: dir,
          systemOne: judge,
          streamFn: scripted([done], seen),
          model: undefined as never,
          trust: 0.3,
          journalPath: join(dir, "off.jsonl"),
          reflexModes: modes,
        });
        await h.prompt("hello");
        h.endSession();
        expect(judge.calls).toHaveLength(0);
        const gated = createHarness({
          cwd: dir,
          systemOne: judge,
          streamFn: scripted([done], seen),
          model: undefined as never,
          trust: 0.3,
          journalPath: join(dir, "gate.jsonl"),
          reflexModes: { ...modes, messageGate: "active" },
        });
        await expect(gated.prompt("forbidden request")).rejects.toThrow("denied");
        gated.endSession();
      } else {
        const a = new Agent({ streamFn: scripted([done], seen) });
        const off = attachReflexes(a, createReflexes({ judge }), { cwd: dir, modes });
        await off.prompt("hello");
        off.dispose();
        expect(judge.calls).toHaveLength(0);
        const gated = attachReflexes(a, createReflexes({ judge }), { cwd: dir, modes: { ...modes, messageGate: "active" } });
        await expect(gated.prompt("forbidden request")).rejects.toThrow("denied");
        gated.dispose();
      }
      expect(seen).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("host recovery delivers a large stored page without re-executing the source tool", async () => {
  const seen: { model: string; context: any }[] = [];
  let sourceCalls = 0;
  const source = "prefix".repeat(2000) + "LATE_FACT";
  const agent = new Agent({
    streamFn: scripted(
      [
        message([{ type: "toolCall", id: "source", name: "read", arguments: { path: "log" } }], "toolUse"),
        message([{ type: "toolCall", id: "page", name: "read_output", arguments: {} }], "toolUse"),
        done,
      ],
      seen,
    ),
    initialState: { tools: [tool("read", source, () => sourceCalls++), tool("read_output", source.slice(-7900))] },
  });
  const plugin = attachReflexes(agent, createReflexes({ judge: provider(), root: "/tmp" }), {
    cwd: "/tmp",
    outputSource: (context, text) => ({
      kind: "captured",
      sourceId: context.toolCall.id,
      stream: "output",
      text,
      completeness: "complete",
      recovery: { sessionId: plugin.session.sessionId, sourceId: "source", instructions: "use read_output" },
    }),
  });
  await plugin.prompt("find late fact");
  expect(JSON.stringify(seen[1]?.context)).not.toContain("LATE_FACT");
  expect(JSON.stringify(seen[2]?.context)).toContain("LATE_FACT");
  expect(sourceCalls).toBe(1);
  plugin.dispose();
});

test("disposing during capability loading discards the result before tools reach the agent", async () => {
  let ready!: () => void;
  const loading = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let complete!: (value: { tools: AgentTool[] }) => void;
  const agent = new Agent({ streamFn: scripted([done], []), initialState: { tools: [] } });
  const plugin = attachReflexes(agent, createReflexes({ judge: provider() }), {
    cwd: "/tmp",
    modes: { select: "active" },
    capabilities: () => ({ catalog: [desc], available: ["browser"], baseline: [] }),
    loadCapabilities: () =>
      new Promise((resolve) => {
        complete = resolve;
        ready();
      }),
  });
  const pending = plugin.prompt("inspect browser");
  await loading;
  plugin.dispose();
  complete({ tools: [tool("browser", "late")] });
  await expect(pending).rejects.toThrow(/cancel/);
  expect(agent.state.tools).toHaveLength(0);
});

test("foreign host recovery references are rejected", async () => {
  const agent = new Agent({ streamFn: scripted([done], []) });
  const plugin = attachReflexes(agent, createReflexes({ judge: provider() }), {
    cwd: "/tmp",
    outputSource: (_c, text) => ({
      kind: "captured",
      sourceId: "foreign",
      stream: "output",
      text,
      completeness: "complete",
      recovery: { sessionId: "another-session", sourceId: "foreign", instructions: "read_output" },
    }),
  });
  await expect(
    agent.afterToolCall!({
      toolCall: { id: "r", name: "read", arguments: {} },
      args: {},
      isError: false,
      result: { content: [{ type: "text", text: "secret" }], details: {} },
    } as never),
  ).rejects.toThrow("foreign");
  plugin.dispose();
});

test("without a loader, Select supplies advice to the next model request", async () => {
  const seen: { model: string; context: any }[] = [];
  const agent = new Agent({ streamFn: scripted([done], seen), initialState: { tools: [] } });
  const plugin = attachReflexes(agent, createReflexes({ judge: provider() }), {
    cwd: "/tmp",
    modes: { select: "active" },
    capabilities: () => ({ catalog: [desc], available: ["browser"], baseline: [] }),
  });
  await plugin.prompt("inspect browser");
  expect(JSON.stringify(seen[0]?.context)).toContain("Suggested host-available capabilities: browser");
  expect(agent.state.tools).toHaveLength(0);
  plugin.dispose();
});
