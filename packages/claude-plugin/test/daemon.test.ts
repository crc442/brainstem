import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer, type Answer } from "@brainstem/core";
import { createDaemon } from "../src/daemon/main";
import { request } from "../src/hook/client";
import { resolveConfig, type RawConfig } from "../src/config";

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
