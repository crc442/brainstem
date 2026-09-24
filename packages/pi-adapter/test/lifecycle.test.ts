import { expect, test } from "vitest";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createReflexes } from "@brainstem/reflexes";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer, type Answer, type CapabilityDescriptor } from "@brainstem/core";
import { attachReflexes } from "../src";
import { createHarness } from "../../cli/src/harness";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function message(content: AssistantMessage["content"], stopReason: "toolUse" | "stop"): AssistantMessage {
  return { role: "assistant", content, stopReason, api: "anthropic-messages", provider: "anthropic", model: "main", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function scripted(script: AssistantMessage[], seen: { model: string; context: any }[]): StreamFn {
  let i = 0;
  return (model, context) => {
    seen.push({ model: model?.id, context: structuredClone(context) });
    const stream = createAssistantMessageEventStream();
    const m = script[Math.min(i++, script.length - 1)]!;
    queueMicrotask(() => { stream.push({ type: "done", reason: m.stopReason as "stop", message: m }); stream.end(m); });
    return stream;
  };
}
const done = message([{ type: "text", text: "done" }], "stop");
function tool(name: string, text: string, executed = () => {}): AgentTool {
  return { name, label: name, description: name, parameters: { type: "object", properties: { path: { type: "string" }, command: { type: "string" }, content: { type: "string" } } } as never, execute: async () => { executed(); return { content: [{ type: "text", text }], details: {} }; } };
}
const provider = () => mockSystemOne((_state, q) => Object.fromEntries(Object.entries(q).map(([id, question]) => [id,
  question.type === "choice" ? choiceAnswer(id === "model_tier" ? "mini" : "auto_run", 0.99) : question.type === "score" ? scoreAnswer(id === "result_quality" || id === "worth_continuing" ? 2 : 0, 0.99) : noulAnswer(["on_task", "satisfies_intent", "evidence_of_success", "progressing"].includes(id) || id.startsWith("select__") ? 0.99 : 0.01),
])) as Record<string, Answer>);
const desc: CapabilityDescriptor = { id: "browser", kind: "tool", description: "inspect browser", version: "1", contentHash: "v1", requires: [], useWhen: [], avoidWhen: [], alwaysAvailable: false };

test("prompt wrapper loads and uses a suggested tool, routes actual requests, then restores hooks", async () => {
  const seen: { model: string; context: any }[] = [];
  let executions = 0;
  let applications = 0;
  const agent = new Agent({ initialState: { model: { id: "main" } as never, tools: [] }, streamFn: scripted([message([{ type: "toolCall", id: "b", name: "browser", arguments: {} }], "toolUse"), done], seen) });
  const oldBefore = agent.beforeToolCall;
  const oldStream = agent.streamFunction;
  const plugin = attachReflexes(agent, createReflexes({ judge: provider() }), {
    cwd: "/tmp", modes: { select: "active", steer: "active", messageGate: "active" }, miniModel: { id: "mini" } as never,
    capabilities: () => ({ catalog: [desc], available: ["browser"], baseline: [] }),
    applyCapabilities: (r) => { applications++; agent.state.tools = r.ids.includes("browser") ? [tool("browser", "UI inspected", () => executions++)] : []; },
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
    const plugin = attachReflexes(agent, createReflexes({ judge }), { cwd: "/tmp", modes: { messageGate: "active" }, gateBehavior: behavior });
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
  const judge = mockSystemOne((state) => { review = state; return { ...providerAnswers(), disposition: choiceAnswer("ask_user", 0.99) }; });
  const plugin = attachReflexes(agent, createReflexes({ judge, root: "/tmp" }), {
    cwd: "/tmp", actionEvidence: async () => ({ changeSummary: "+approved bytes" }),
    approve: async (r) => { (r.subject as any).arguments.content = "callback mutation"; args.content = "concurrent mutation"; return true; },
  });
  const result = await agent.beforeToolCall!({ toolCall: { id: "w", name: "write", arguments: args }, args } as never);
  expect(review.action.changeSummary).toBe("+approved bytes");
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("changed");
  plugin.dispose();
});
function providerAnswers(): Record<string, Answer> { return { destructive: scoreAnswer(0, 1), touches_credentials: noulAnswer(0), exfiltrates: noulAnswer(0), on_task: noulAnswer(1), disposition: choiceAnswer("auto_run", 1) }; }

test("Pulse can stop at the host checkpoint without dispatching another request", async () => {
  const seen: { model: string; context: any }[] = [];
  const judge = mockSystemOne((_state, questions) => Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === "score" ? scoreAnswer(0, 1) : noulAnswer(id === "repeating" || id === "stuck_on_same_error" ? 1 : 0)])));
  const agent = new Agent({ streamFn: scripted([message([{ type: "toolCall", id: "t", name: "probe", arguments: {} }], "toolUse"), done], seen), initialState: { tools: [tool("probe", "same failure")] } });
  const plugin = attachReflexes(agent, createReflexes({ judge }), { cwd: "/tmp", modes: { pulse: "active", gate: "off", sanitize: "off", verify: "off" }, pulseEveryTurns: 1 });
  await plugin.prompt("fix this");
  expect(seen).toHaveLength(1);
  plugin.dispose();
});

for (const adapter of ["cli", "pi"] as const) {
  test(`${adapter}: long error/output evidence is bounded and only the reviewed view reaches the next request`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "brainstem-contract-"));
    try {
      const source = "x".repeat(9000) + "UNREVIEWED_TAIL";
      writeFileSync(join(dir, "log.txt"), source);
      const seen: { model: string; context: any }[] = [];
      const script = [message([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "log.txt" } }], "toolUse"), done];
      const judge = provider();
      if (adapter === "cli") {
        const harness = createHarness({ cwd: dir, systemOne: judge, streamFn: scripted(script, seen), model: undefined as never, trust: 0.3, journalPath: join(dir, "journal.jsonl") });
        await harness.prompt("read diagnostics"); harness.endSession();
      } else {
        const agent = new Agent({ streamFn: scripted(script, seen), initialState: { tools: [tool("read", source)] } });
        const plugin = attachReflexes(agent, createReflexes({ judge, root: dir }), { cwd: dir });
        await plugin.prompt("read diagnostics"); plugin.dispose();
      }
      const observed = judge.calls.find((call) => "contains_agent_directive" in call.questions)?.state as { content: string };
      const delivered = JSON.stringify(seen[1]?.context);
      expect(observed.content.length).toBeLessThanOrEqual(8000);
      expect(delivered).not.toContain("UNREVIEWED_TAIL");
      expect(delivered).toContain(observed.content.slice(0, 100));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
