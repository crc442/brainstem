import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choiceAnswer, mockSystemOne, noulAnswer, scoreAnswer, type Answer } from "@brainstem/core";
import { createDaemon } from "../src/daemon/main";
import { decodeCapturedChunks, forwardSignal, runWrapper } from "../src/output/filter";
import { resolveConfig } from "../src/config";

let directory = "";
let closeDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeDaemon?.();
  closeDaemon = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

function outputAnswers(state: unknown): Record<string, Answer> {
  const snapshot = state as { action?: unknown; content?: string };
  const content = snapshot.content ?? "";
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
