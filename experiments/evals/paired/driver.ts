import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { choiceAnswer, noulAnswer, scoreAnswer, type Answer, type CapabilityDescriptor, type SystemOne } from "@brainstem/core";
import { createReflexes, type JudgmentEvent, type PluginEvent } from "@brainstem/reflexes";
import { attachReflexes } from "@brainstem/pi-adapter";
import type { Arm, Protocol } from "./protocol";
import type { Fixture } from "./fixtures";

export interface Observation {
  status: "completed" | "blocked" | "budget" | "error";
  error?: string;
  durationMs: number;
  files: Record<string, string>;
  final: string;
  delivered: string[];
  proposals: { tool: string; args: Record<string, string> }[];
  effects: { tool: string; args: Record<string, string> }[];
  approvals: { allowed: boolean; required: boolean; boundary: "host" | "plugin" }[];
  mainCalls: { model: string; requestBytes: number; durationMs: number }[];
  judgeCalls: { state: unknown; questions: string[]; requestBytes: number }[];
  judgments: JudgmentEvent[];
  events: PluginEvent[];
  recovery: { calls: number; bytes: number };
  costUsd: 0;
  usageProvenance: "scripted-no-provider";
  providerCache: null;
}

function assistant(content: AssistantMessage["content"], stopReason: "toolUse" | "stop"): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
    api: "anthropic-messages",
    provider: "offline",
    model: "script",
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
function descriptor(id: string): CapabilityDescriptor {
  return {
    id,
    kind: "tool",
    description: `${id} tool`,
    version: "fixture-v1",
    contentHash: id,
    requires: [],
    useWhen: [],
    avoidWhen: [],
    alwaysAvailable: false,
  };
}
export async function runFixture(fixture: Fixture, arm: Arm, protocol: Protocol): Promise<Observation> {
  const start = performance.now();
  const result: Observation = {
    status: "completed",
    durationMs: 0,
    files: structuredClone(fixture.files),
    final: "",
    delivered: [],
    proposals: [],
    effects: [],
    approvals: [],
    mainCalls: [],
    judgeCalls: [],
    judgments: [],
    events: [],
    recovery: { calls: 0, bytes: 0 },
    costUsd: 0,
    usageProvenance: "scripted-no-provider",
    providerCache: null,
  };
  let budgetExceeded = false;
  const guard = (calls: number, max: number, bytes: number) => {
    if (calls >= max || bytes > protocol.limits.requestBytes || performance.now() - start > protocol.limits.elapsedMs) {
      budgetExceeded = true;
      throw new Error("offline execution budget exceeded");
    }
  };
  const judge: SystemOne = {
    name: "offline-script-v1",
    async ask(state, questions) {
      const bytes = Buffer.byteLength(JSON.stringify({ state, questions }));
      guard(result.judgeCalls.length, protocol.limits.judgeCalls, bytes);
      result.judgeCalls.push({ state: structuredClone(state), questions: Object.keys(questions), requestBytes: bytes });
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "choice") {
          const disposition = Object.keys(questions).length === 1 ? fixture.judge.message : fixture.judge.action;
          answers[id] = choiceAnswer(
            id === "model_tier" ? (fixture.judge.complex ? "frontier" : "mini") : (disposition ?? "auto_run"),
            0.99,
          );
        } else if (q.type === "score") {
          answers[id] = scoreAnswer(
            id === "severity"
              ? fixture.judge.hostile
                ? 3
                : 0
              : id === "result_quality"
                ? fixture.judge.mismatch
                  ? 0
                  : 2
                : id === "worth_continuing"
                  ? fixture.judge.stuck
                    ? 0
                    : 2
                  : 0,
            0.99,
          );
        } else {
          let yes = ["on_task", "satisfies_intent", "evidence_of_success", "progressing", "approach_changed"].includes(id);
          if (id.startsWith("select__")) yes = fixture.judge.browser === true && q.instructions.includes("browser");
          if (id.startsWith("focus__")) yes = !id.endsWith("__contradicts") && q.instructions.includes("ANSWER=");
          if (["contains_agent_directive", "tries_to_override", "requests_dangerous_action"].includes(id))
            yes = fixture.judge.hostile === true;
          if (["satisfies_intent", "evidence_of_success"].includes(id)) yes = !fixture.judge.mismatch;
          if (["repeating", "stuck_on_same_error"].includes(id)) yes = fixture.judge.stuck === true;
          if (["progressing", "approach_changed"].includes(id)) yes = !fixture.judge.stuck;
          answers[id] = noulAnswer(yes ? 0.99 : 0.01);
        }
      }
      return { answers, model: "offline-script-v1", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  let step = 0;
  const stream: StreamFn = (model, context) => {
    const callStart = performance.now();
    const bytes = Buffer.byteLength(JSON.stringify(context));
    guard(result.mainCalls.length, protocol.limits.mainCalls, bytes);
    const toolResults = context.messages.filter((m) => m.role === "toolResult");
    result.delivered = toolResults.map((m) =>
      m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    );
    const next = fixture.steps[step++];
    // The scripted agent follows an authored action trace; it has no access to rubric labels.
    const text = result.delivered.join("\n");
    const final = [...text.matchAll(/ANSWER=([^\s]+)/g)].at(-1)?.[1] ?? "done";
    const m = next
      ? assistant([{ type: "toolCall", id: `step-${step}`, name: next.tool, arguments: structuredClone(next.args) }], "toolUse")
      : assistant([{ type: "text", text: final }], "stop");
    if (next) result.proposals.push(structuredClone(next));
    else result.final = final;
    result.mainCalls.push({ model: model.id, requestBytes: bytes, durationMs: performance.now() - callStart });
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "done", reason: m.stopReason as "stop", message: m });
      events.end(m);
    });
    return events;
  };
  const tools: AgentTool[] = ["read", "write", "bash", "read_output", "browser"].map((name) => ({
    name,
    label: name,
    description: `Offline ${name} recording stub; never executes a command or accesses the filesystem.`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" }, source: { type: "string" }, tail: { type: "string" } },
    } as never,
    execute: async (_id, args) => {
      const a = args as Record<string, string>;
      result.effects.push({ tool: name, args: structuredClone(a) });
      let text = fixture.output;
      if (name === "write") {
        result.files[a.path!] = a.content!;
        text = "write completed";
      }
      if (name === "read_output") {
        text = fixture.output.slice(-Math.min(7000, Math.max(0, Number(a.tail) || 7000)));
        result.recovery.calls++;
        result.recovery.bytes += Buffer.byteLength(text);
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  }));
  const agent = new Agent({ initialState: { model: { id: "offline-primary" } as never, tools }, streamFn: stream });
  const approve = async (boundary: "host" | "plugin", path?: string) => {
    const allowed = path === "config.txt";
    result.approvals.push({ boundary, allowed, required: path === "config.txt" });
    if (protocol.approvalDelayMs) await new Promise((resolve) => setTimeout(resolve, protocol.approvalDelayMs));
    return allowed;
  };
  agent.beforeToolCall = async (context) => {
    const args = context.args as Record<string, string>;
    // Fixed host permission boundary, composed ahead of Brainstem in every arm.
    if (args.path?.startsWith("/") || args.path?.includes("..")) return { block: true, reason: "host path policy" };
    if (context.toolCall.name === "write" && args.path === "config.txt" && !(await approve("host", args.path)))
      return { block: true, reason: "host approval denied" };
  };
  if (!arm.plugin)
    agent.afterToolCall = async (context) => ({
      content: context.result.content.map((c) => (c.type === "text" ? { ...c, text: c.text.slice(0, 8000) } : c)),
    });
  const reflexes = createReflexes({
    judge,
    root: process.cwd(),
    maxJudgmentCalls: protocol.limits.judgeCalls,
    onJudgment: (e) => result.judgments.push(e),
  });
  const plugin = arm.plugin
    ? attachReflexes(agent, reflexes, {
        cwd: process.cwd(),
        modes: arm.modes,
        miniModel: { id: "offline-mini" } as never,
        pulseEveryTurns: 1,
        capabilities: () => ({ catalog: [descriptor("browser")], available: ["browser"], baseline: [] }),
        // Advisory Select leaves the same complete tool catalog available to every arm.
        onEvent: (e) => result.events.push(e),
        approve: (review) => approve("plugin", "path" in review.subject ? review.subject.path : undefined),
        actionEvidence: async (context) => ({ changeSummary: JSON.stringify(context.args) }),
        outputSource: (context, text) => ({
          kind: "captured",
          sourceId: context.toolCall.id,
          text,
          stream: "output",
          completeness: "complete",
          recovery: {
            sessionId: reflexes.sessionId,
            sourceId: "source-1",
            instructions: "use read_output with source source-1 and tail 7000",
          },
        }),
      })
    : undefined;
  const timer = setTimeout(() => {
    budgetExceeded = true;
    agent.abort();
  }, protocol.limits.elapsedMs);
  try {
    if (plugin) await plugin.prompt(fixture.message, { taskId: fixture.id, constraints: fixture.constraints });
    else await agent.prompt(fixture.message);
    const last = agent.state.messages.at(-1);
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      result.status = "error";
      result.error = last.errorMessage ?? last.stopReason;
    }
  } catch (error) {
    result.error = String(error);
    result.status = result.error.includes("[brainstem] message") ? "blocked" : "error";
  } finally {
    clearTimeout(timer);
    plugin?.dispose();
    agent.abort();
    if (budgetExceeded) result.status = "budget";
    result.durationMs = performance.now() - start;
  }
  return result;
}
