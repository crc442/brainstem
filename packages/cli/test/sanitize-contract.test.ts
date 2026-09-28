import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { mockSystemOne, noulAnswer, scoreAnswer, type ReflexModes } from "@brainstem/core";
import { createReflexes } from "@brainstem/reflexes";
import { attachReflexes } from "@brainstem/pi-adapter";
import { createHarness } from "../src/harness";
import { SANITIZE_FIXTURES, SANITIZE_TASK } from "../../../experiments/evals/sanitize-fixtures";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const modes: ReflexModes = {
  select: "off",
  focus: "off",
  messageGate: "off",
  gate: "off",
  sanitize: "active",
  verify: "off",
  pulse: "off",
  steer: "off",
};

function readingTwice(): StreamFn {
  let turn = 0;
  return () => {
    turn++;
    const message: AssistantMessage = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "scripted",
      content:
        turn <= 2
          ? [{ type: "toolCall", id: `read-${turn}`, name: "read", arguments: { path: "notes.txt" } }]
          : [{ type: "text", text: "done" }],
      stopReason: turn <= 2 ? "toolUse" : "stop",
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
      stream.end(message);
    });
    return stream;
  };
}

// Scripted scores test policy and adapter delivery, not the judge's ability to
// understand these texts. The same corpus is separately used for live judgments.
describe.each(["cli", "pi"] as const)("%s Sanitize delivery contract", (adapter) => {
  test.each(SANITIZE_FIXTURES)("$id", async (fixture) => {
    const cwd = mkdtempSync(join(tmpdir(), "brainstem-sanitize-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "notes.txt"), fixture.content);
    const hostile = fixture.expected === "block";
    const judge = mockSystemOne(() => ({
      contains_agent_directive: noulAnswer(0.99),
      tries_to_override: noulAnswer(hostile ? 0.98 : 0.01),
      requests_dangerous_action: noulAnswer(0.01),
      severity: scoreAnswer(0, 0.9),
    }));
    let agent: Agent;
    let dispose: () => void;
    if (adapter === "cli") {
      const harness = createHarness({
        cwd,
        journalPath: join(cwd, "journal.ndjson"),
        trust: 0.3,
        model: undefined as never,
        streamFn: readingTwice(),
        systemOne: judge,
        reflexModes: modes,
      });
      agent = harness.agent;
      dispose = () => harness.endSession();
    } else {
      agent = new Agent({
        initialState: {
          model: undefined as never,
          tools: [
            {
              name: "read",
              label: "read",
              description: "read notes",
              parameters: { type: "object", properties: {} },
              execute: async () => ({ content: [{ type: "text", text: fixture.content }], details: {} }),
            },
          ],
        },
        streamFn: readingTwice(),
      });
      const handle = attachReflexes(agent, createReflexes({ judge, root: cwd }), {
        cwd,
        modes,
        taskText: () => fixture.task ?? SANITIZE_TASK,
      });
      dispose = () => handle.dispose();
    }
    try {
      await agent.prompt(fixture.task ?? SANITIZE_TASK);
      const results = agent.state.messages.filter((m) => m.role === "toolResult");
      expect(results).toHaveLength(2);
      for (const result of results) {
        const text = (result as { content: { type: string; text?: string }[] }).content.map((c) => c.text ?? "").join("\n");
        if (hostile) {
          expect(text).not.toContain(fixture.content);
          expect(text).toContain("block");
        } else {
          for (const line of fixture.content.split("\n")) expect(text).toContain(line);
          expect(text).not.toContain("sanitize: review");
        }
      }
      expect(judge.calls.length).toBeGreaterThan(0);
      expect(judge.calls.every((call) => !("satisfies_intent" in call.questions))).toBe(true);
    } finally {
      dispose();
    }
  });
});
