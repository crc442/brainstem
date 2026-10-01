import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choiceAnswer, mockSystemOne, noulAnswer, scoreAnswer, type Answer } from "@brainstem/core";
import { createDaemon } from "../src/daemon/main";
import { decodeCapturedChunks, forwardSignal, runWrapper } from "../src/output/filter";
import { resolveConfig } from "../src/config";
import { shellQuote } from "../src/output/command";

let directory = "";
let closeDaemon: (() => Promise<void>) | undefined;
let judgedViews: string[] = [];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Test cleanup is best effort for a process already reaped.
  }
}

afterEach(async () => {
  await closeDaemon?.();
  closeDaemon = undefined;
  judgedViews = [];
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

function outputAnswers(state: unknown): Record<string, Answer> {
  const snapshot = state as { action?: unknown; content?: string };
  const content = snapshot.content ?? "";
  if (snapshot.action === undefined) judgedViews.push(content);
  const gate = {
    destructive: scoreAnswer(0, 0.9),
    touches_credentials: noulAnswer(0.02),
    exfiltrates: noulAnswer(0.01),
    on_task: noulAnswer(0.95),
    disposition: choiceAnswer("auto_run", 0.95, { auto_run: 0.95 }),
  };
  const output = {
    contains_agent_directive: noulAnswer(0.01),
    tries_to_override: noulAnswer(content.includes("BLOCK_SENTINEL") ? 0.99 : content.includes("REVIEW_SENTINEL") ? 0.5 : 0.01),
    requests_dangerous_action: noulAnswer(0.01),
    severity: scoreAnswer(content.includes("BLOCK_SENTINEL") ? 3 : 0, 0.95),
    satisfies_intent: noulAnswer(content.includes("MISMATCH_SENTINEL") || content.includes("BLOCK_SENTINEL") ? 0.01 : 0.9),
    evidence_of_success: noulAnswer(content.includes("MISMATCH_SENTINEL") || content.includes("BLOCK_SENTINEL") ? 0.01 : 0.9),
    operational_failure: noulAnswer(0.01),
    result_quality: scoreAnswer(2, 0.9),
  };
  return snapshot.action ? gate : output;
}

async function start(config: Parameters<typeof resolveConfig>[0] = {}) {
  judgedViews = [];
  directory = mkdtempSync(join(tmpdir(), "bs-output-wrapper-"));
  const socket = join(directory, "daemon.sock");
  const daemon = await createDaemon({ socket, judge: mockSystemOne(outputAnswers), config: resolveConfig(config), root: directory });
  closeDaemon = () => daemon.close();
  return socket;
}

async function run(socket: string, command: string, timeoutMs?: number): Promise<{ code: number; text: string }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  try {
    const code = await runWrapper(["--socket", socket, "--tool-use-id", "call wrapper test", "--command", command], timeoutMs);
    return { code, text: chunks.join("") };
  } finally {
    spy.mockRestore();
  }
}

describe("output wrapper and daemon integration", () => {
  test("decodes UTF-8 split between retained chunks", () => {
    const bytes = Buffer.from("café 😀");
    expect(decodeCapturedChunks([bytes.subarray(0, 6), bytes.subarray(6)])).toBe("café 😀");
  });

  test("forwards cancellation to the child process group", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      forwardSignal({ pid: 43210 } as never, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-43210, "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });

  test("built wrapper kills TERM-resistant descendants on cancellation", async () => {
    const socket = await start();
    const bundle = join(directory, "filter-wrapper.mjs");
    const source = join(process.cwd(), "packages/claude-plugin/src/output/filter.ts");
    execFileSync("bun", ["build", source, "--target=node", "--outfile", bundle], { stdio: "ignore" });

    const readyFile = join(directory, "children.json");
    const marker = join(directory, "still-running.log");
    const nodePath = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
    const tickSource = `const { appendFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); setInterval(() => appendFileSync(${JSON.stringify(marker)}, "g"), 25);`;
    const parentSource = [
      `const { spawn } = require("node:child_process");`,
      `const { writeFileSync, appendFileSync } = require("node:fs");`,
      `const child = spawn(${JSON.stringify(nodePath)}, ["-e", ${JSON.stringify(tickSource)}], { stdio: "ignore" });`,
      `writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify([process.pid, child.pid]));`,
      `process.on("SIGTERM", () => {});`,
      `setInterval(() => appendFileSync(${JSON.stringify(marker)}, "p"), 25);`,
    ].join(" ");
    const command = `${shellQuote(nodePath)} -e ${shellQuote(parentSource)}`;
    const child = spawn("node", [bundle, "--socket", socket, "--tool-use-id", "cancel-real-process", "--command", command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let pids: number[] = [];
    try {
      const readyDeadline = Date.now() + 5_000;
      while (!existsSync(readyFile) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(readyFile), `wrapper stderr: ${stderr}`).toBe(true);
      pids = JSON.parse(readFileSync(readyFile, "utf8")) as number[];
      child.kill("SIGTERM");
      const result = await closed;
      expect(result.code).toBe(143);
      expect(stdout).toContain("source capture limited");
      expect(stdout).not.toContain("still-running");
      const markerSize = existsSync(marker) ? readFileSync(marker).length : 0;
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(marker) ? readFileSync(marker).length : 0).toBe(markerSize);
      const goneDeadline = Date.now() + 2_000;
      while (pids.some(pidAlive) && Date.now() < goneDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pids.filter(pidAlive)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        for (const pid of pids) killPid(pid);
        await Promise.race([closed.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3_000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      for (const pid of pids) killPid(pid);
      if (child.exitCode === null && child.signalCode === null) await closed.catch(() => undefined);
    }
  });

  test("repeated cancellation force-kills the group and bounds drain of escaped pipe holders", async () => {
    const socket = await start();
    const bundle = join(directory, "filter-wrapper.mjs");
    execFileSync(
      "bun",
      ["build", join(process.cwd(), "packages/claude-plugin/src/output/filter.ts"), "--target=node", "--outfile", bundle],
      { stdio: "ignore" },
    );
    const readyFile = join(directory, "escaped-children.json");
    const nodePath = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
    const tickSource = `const { appendFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); setInterval(() => appendFileSync(${JSON.stringify(
      join(directory, "escaped.log"),
    )}, "x"), 25);`;
    const parentSource = [
      `const { spawn } = require("node:child_process");`,
      `const { writeFileSync } = require("node:fs");`,
      `const child = spawn(${JSON.stringify(nodePath)}, ["-e", ${JSON.stringify(tickSource)}], { detached: true, stdio: "inherit" });`,
      `writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify([process.pid, child.pid]));`,
      `process.on("SIGTERM", () => {});`,
      `setInterval(() => {}, 1000);`,
    ].join(" ");
    const command = `${shellQuote(nodePath)} -e ${shellQuote(parentSource)}`;
    const wrapper = spawn("node", [bundle, "--socket", socket, "--tool-use-id", "cancel-with-pipe-holder", "--command", command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    wrapper.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    const closed = new Promise<{ code: number | null }>((resolve, reject) => {
      wrapper.once("error", reject);
      wrapper.once("close", (code) => resolve({ code }));
    });
    let pids: number[] = [];
    let repeatedSignal: ReturnType<typeof setTimeout> | undefined;
    try {
      const readyDeadline = Date.now() + 5_000;
      while (!existsSync(readyFile) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(readyFile)).toBe(true);
      pids = JSON.parse(readFileSync(readyFile, "utf8")) as number[];
      const started = performance.now();
      wrapper.kill("SIGTERM");
      repeatedSignal = setTimeout(() => wrapper.kill("SIGTERM"), 75);
      const result = await Promise.race([
        closed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("wrapper did not bound pipe drainage")), 4_000)),
      ]);
      expect(result.code).toBe(143);
      expect(performance.now() - started).toBeLessThan(3_500);
      expect(stdout).toContain("source capture limited");
      expect(pidAlive(pids[0]!)).toBe(false);
      expect(pidAlive(pids[1]!)).toBe(true);
    } finally {
      if (repeatedSignal) clearTimeout(repeatedSignal);
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGTERM");
      if (existsSync(readyFile)) pids = JSON.parse(readFileSync(readyFile, "utf8")) as number[];
      for (const pid of pids) killPid(pid);
      await Promise.race([closed.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3_000))]);
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
      for (const pid of pids) killPid(pid);
    }
  });

  test("delivers only the reviewed view and preserves successful/failing child statuses", async () => {
    const socket = await start();
    const success = await run(socket, "printf 'safe café 😀\\n'; printf 'diagnostic\\n' >&2");
    expect(success.code).toBe(0);
    expect(success.text).toContain("safe café 😀");
    expect(success.text).toContain("--- stderr ---");
    expect(success.text).toContain("diagnostic");

    const blocked = await run(socket, "printf 'BLOCK_SENTINEL\\n'; exit 7");
    expect(blocked.code).toBe(7);
    expect(blocked.text).toContain("blocked tool output");
    expect(blocked.text).not.toContain("BLOCK_SENTINEL");
  });

  test("prepends review and Verify mismatch notices while preserving the child result", async () => {
    const socket = await start();
    const review = await run(socket, "printf 'REVIEW_SENTINEL'");
    expect(review.code).toBe(0);
    expect(review.text).toContain("review this content");
    expect(review.text).toContain("REVIEW_SENTINEL");

    const mismatch = await run(socket, "printf 'MISMATCH_SENTINEL'; exit 6");
    expect(mismatch.code).toBe(6);
    expect(mismatch.text).toContain("verify: this output may not satisfy");
    expect(mismatch.text).toContain("MISMATCH_SENTINEL");
  });

  test("keeps stderr failure evidence in the reviewed view after noisy stdout", async () => {
    const socket = await start();
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      [
        "#!/bin/bash",
        "i=0",
        "while [ $i -lt 1200 ]; do printf 'progress '; i=$((i + 1)); done",
        "printf '\\nFAIL src/example.test.ts\\n  AssertionError: expected 1 to be 2\\n    Expected: 2\\n    Received: 1\\n      at src/example.test.ts:27:9\\n        continuation detail\\n' >&2",
        "exit 7",
        "",
      ].join("\n"),
    );
    chmodSync(npm, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
      const result = await run(socket, "npm test --silent");
      expect(result.code).toBe(7);
      expect(judgedViews).toHaveLength(1);
      expect(judgedViews[0]).toContain("FAIL src/example.test.ts");
      expect(judgedViews[0]).toContain("Expected: 2");
      expect(judgedViews[0]).toContain("Received: 1");
      expect(judgedViews[0]).toContain("continuation detail");
      expect(result.text).toContain("FAIL src/example.test.ts");
      expect(result.text).toContain("Expected: 2");
      expect(result.text).toContain("--- stderr ---");
      expect(result.text.startsWith(judgedViews[0]!)).toBe(true);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  test("actual wrapper delivers UTF-8 intact when the framed daemon response splits a character", async () => {
    directory = mkdtempSync(join(tmpdir(), "bs-output-split-response-"));
    const socket = join(directory, "reply.sock");
    const response = Buffer.from(`${JSON.stringify({ kind: "observe", text: "reviewed café 😀\n" })}\n`);
    const splitAt = response.indexOf(Buffer.from("é")) + 1;
    const server = createServer((conn) => {
      conn.on("data", () => {
        conn.write(response.subarray(0, splitAt));
        setTimeout(() => conn.end(response.subarray(splitAt)), 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const result = await run(socket, "printf 'unreviewed child output'; exit 7");
      expect(result.code).toBe(7);
      expect(result.text).toBe("reviewed café 😀\n");
      expect(result.text).not.toContain("unreviewed child output");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("shadow Sanitize remains advisory while active Verify can still annotate", async () => {
    const socket = await start({ modes: { sanitize: "shadow", verify: "active" } });
    const result = await run(socket, "printf 'BLOCK_SENTINEL'; exit 0");
    expect(result.code).toBe(0);
    expect(result.text).toContain("BLOCK_SENTINEL");
    expect(result.text).not.toContain("blocked tool output");
  });

  test("withholds captured source when the daemon is unavailable", async () => {
    directory = mkdtempSync(join(tmpdir(), "bs-output-dead-"));
    const result = await run(join(directory, "missing.sock"), "printf 'PRIVATE_SENTINEL\\n'; exit 3");
    expect(result.code).toBe(3);
    expect(result.text).toContain("output review unavailable");
    expect(result.text).not.toContain("PRIVATE_SENTINEL");
  });

  test("bounded capture is explicit and never claims full output was reviewed", async () => {
    const socket = await start();
    const result = await run(socket, "head -c 270000 /dev/zero | tr '\\000' A");
    expect(result.code).toBe(0);
    expect(result.text.length).toBeLessThan(20_000);
    expect(result.text).toContain("capture limit reached; additional bytes omitted");
    expect(result.text).toContain("source capture limited");
  });

  test("malformed and slow daemons withhold output and preserve child status", async () => {
    directory = mkdtempSync(join(tmpdir(), "bs-output-socket-"));
    const socket = join(directory, "daemon.sock");
    let release: (() => void) | undefined;
    const server: Server = createServer((conn) => {
      conn.on("data", () => {
        if (process.env.BRAINSTEM_TEST_DAEMON === "malformed") conn.end("not-json\n");
        else release = () => conn.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      process.env.BRAINSTEM_TEST_DAEMON = "malformed";
      const malformed = await run(socket, "printf 'MALFORMED_SENTINEL'; exit 4", 100);
      expect(malformed.code).toBe(4);
      expect(malformed.text).toContain("output review unavailable");
      expect(malformed.text).not.toContain("MALFORMED_SENTINEL");
      process.env.BRAINSTEM_TEST_DAEMON = "slow";
      const slow = await run(socket, "printf 'SLOW_SENTINEL'; exit 5", 25);
      expect(slow.code).toBe(5);
      expect(slow.text).toContain("output review unavailable");
      expect(slow.text).not.toContain("SLOW_SENTINEL");
      release?.();
    } finally {
      delete process.env.BRAINSTEM_TEST_DAEMON;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
