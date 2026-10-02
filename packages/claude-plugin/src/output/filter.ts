#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { runIfEntry } from "../hook/io";
import { request } from "../hook/client";
import type { ObserveResponse, Request, Response } from "../protocol";

const STREAM_CAP = 256 * 1024;
const REVIEW_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 2_000;
const PIPE_DRAIN_GRACE_MS = 250;
const REVIEW_UNAVAILABLE = "[brainstem] output review unavailable; captured command output withheld.";
const SIGNAL_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGTERM: 143,
};

interface CapturedStream {
  chunks: Buffer[];
  bytes: number;
  captureLimited: boolean;
  complete: boolean;
  closed: boolean;
  result: Promise<void>;
  forceFinish(): void;
}

function streamCapture(child: ChildProcess, name: "stdout" | "stderr"): CapturedStream {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let captureLimited = false;
  let complete = false;
  let closed = false;
  let resolveResult!: () => void;
  const result = new Promise<void>((resolve) => (resolveResult = resolve));
  const pipe = child[name];
  if (!pipe) {
    closed = true;
    complete = true;
    resolveResult();
    return { chunks, bytes, captureLimited, complete, closed, result, forceFinish() {} };
  }
  const finish = (endedComplete: boolean) => {
    if (closed) return;
    closed = true;
    complete = endedComplete;
    resolveResult();
  };
  pipe.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const keep = Math.max(0, Math.min(buffer.length, STREAM_CAP - bytes));
    if (keep) {
      chunks.push(buffer.subarray(0, keep));
      bytes += keep;
    }
    if (keep < buffer.length) captureLimited = true;
  });
  pipe.once("end", () => finish(true));
  pipe.once("close", () => finish(false));
  return {
    get chunks() {
      return chunks;
    },
    get bytes() {
      return bytes;
    },
    get captureLimited() {
      return captureLimited;
    },
    get complete() {
      return complete;
    },
    get closed() {
      return closed;
    },
    result,
    forceFinish() {
      if (closed) return;
      finish(false);
      pipe.destroy();
    },
  };
}

function renderedCapture(stdout: CapturedStream, stderr: CapturedStream, executionComplete = true): { text: string; complete: boolean } {
  const out = decodeCapturedChunks(stdout.chunks);
  const err = decodeCapturedChunks(stderr.chunks);
  const sections = [
    `--- stdout ---${stdout.captureLimited ? " [capture limit reached; additional bytes omitted]" : !stdout.complete ? " [stream capture incomplete]" : ""}\n${out}`,
    `--- stderr ---${stderr.captureLimited ? " [capture limit reached; additional bytes omitted]" : !stderr.complete ? " [stream capture incomplete]" : ""}\n${err}`,
  ];
  return {
    text: sections.join("\n"),
    complete:
      executionComplete &&
      stdout.closed &&
      stderr.closed &&
      stdout.complete &&
      stderr.complete &&
      !stdout.captureLimited &&
      !stderr.captureLimited,
  };
}

export function decodeCapturedChunks(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal && SIGNAL_CODES[signal]) return SIGNAL_CODES[signal];
  return code ?? 1;
}

export function forwardSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || process.platform === "win32") {
    try {
      child.kill(signal);
    } catch {
      // Process may have exited while cancellation was being forwarded.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      // Bun may reject negative pids before they reach kill(2). Use kill(1)
      // as the CLI adapter does so the whole child process group is targeted.
      execFileSync("kill", [`-${signal.slice(3)}`, "--", `-${child.pid}`], { stdio: "ignore" });
      return;
    } catch {
      // The group may already have exited.
    }
    try {
      child.kill(signal);
    } catch {
      // Process may have exited while cancellation was being forwarded.
    }
  }
}

async function review(
  socket: string,
  toolUseId: string,
  command: string,
  text: string,
  complete: boolean,
  code: number,
  signal?: NodeJS.Signals | null,
  timeoutMs = REVIEW_TIMEOUT_MS,
): Promise<string> {
  const payload: Request = {
    kind: "observe",
    source: "wrapper",
    tool: "Bash",
    action: command,
    command,
    text,
    status: code === 0 ? "ok" : "error",
    exitCode: code,
    signal: signal ?? undefined,
    complete,
    toolUseId,
  };
  try {
    const response: Response = await request(socket, payload, timeoutMs);
    if (response.kind === "observe" && typeof (response as ObserveResponse).text === "string") return (response as ObserveResponse).text!;
  } catch {
    // The wrapper never emits captured source on a failed review request.
  }
  return REVIEW_UNAVAILABLE;
}

export async function runWrapper(argv = process.argv.slice(2), reviewTimeoutMs = REVIEW_TIMEOUT_MS): Promise<number> {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        socket: { type: "string" },
        "tool-use-id": { type: "string" },
        command: { type: "string" },
      },
    }));
  } catch {
    process.stdout.write(`${REVIEW_UNAVAILABLE}\n`);
    return 1;
  }
  if (typeof values.socket !== "string" || typeof values.command !== "string" || typeof values["tool-use-id"] !== "string") {
    process.stdout.write(`${REVIEW_UNAVAILABLE}\n`);
    return 1;
  }

  const child = spawn("/bin/bash", ["-c", values.command], {
    cwd: process.cwd(),
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = streamCapture(child, "stdout");
  const stderr = streamCapture(child, "stderr");
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (spawnError) => resolve({ code: null, signal: null, spawnError }));
  });
  let interrupted: NodeJS.Signals | undefined;
  let killedBy: "timeout" | "cancelled" | undefined;
  let forceKilled = false;
  let killGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const forceKillGroup = () => {
    if (forceKilled) return;
    forceKilled = true;
    if (killGraceTimer) clearTimeout(killGraceTimer);
    forwardSignal(child, "SIGKILL");
    // Descendants outside the group, or ones that retained pipe handles, cannot
    // keep this wrapper alive after this bounded final drain.
    drainTimer = setTimeout(() => {
      stdout.forceFinish();
      stderr.forceFinish();
    }, PIPE_DRAIN_GRACE_MS);
  };
  const beginTermination = (reason: "timeout" | "cancelled", signal: NodeJS.Signals) => {
    if (killedBy) {
      forceKillGroup();
      return;
    }
    killedBy = reason;
    if (reason === "cancelled") interrupted = signal;
    forwardSignal(child, "SIGTERM");
    killGraceTimer = setTimeout(forceKillGroup, KILL_GRACE_MS);
    // The shell can exit on TERM while an in-group child ignores it. Reap the
    // entire group as soon as the leader exits instead of waiting out the grace.
    void exitPromise.then(() => forceKillGroup());
  };
  const onHup = () => beginTermination("cancelled", "SIGHUP");
  const onInt = () => beginTermination("cancelled", "SIGINT");
  const onQuit = () => beginTermination("cancelled", "SIGQUIT");
  const onTerm = () => beginTermination("cancelled", "SIGTERM");
  process.on("SIGHUP", onHup);
  process.on("SIGINT", onInt);
  process.on("SIGQUIT", onQuit);
  process.on("SIGTERM", onTerm);

  let didTimeout = false;
  const timeout = setTimeout(
    () => {
      didTimeout = true;
      beginTermination("timeout", "SIGTERM");
    },
    30 * 60 * 1000,
  );
  timeout.unref?.();

  const closeResult = await exitPromise;
  if (closeResult.spawnError) {
    stdout.forceFinish();
    stderr.forceFinish();
  }
  await Promise.all([stdout.result, stderr.result]);
  clearTimeout(timeout);
  if (killGraceTimer) clearTimeout(killGraceTimer);
  if (drainTimer) clearTimeout(drainTimer);
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGHUP", onHup);
  process.removeListener("SIGQUIT", onQuit);
  process.removeListener("SIGTERM", onTerm);

  const captured = renderedCapture(stdout, stderr, !didTimeout && !interrupted && closeResult.signal === null);
  const code = didTimeout ? 124 : interrupted ? (SIGNAL_CODES[interrupted] ?? 130) : exitCode(closeResult.code, closeResult.signal);
  const output = await review(
    values.socket,
    values["tool-use-id"],
    values.command,
    captured.text,
    captured.complete,
    code,
    closeResult.signal,
    reviewTimeoutMs,
  );
  process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
  return code;
}

runIfEntry(import.meta.url, async () => {
  const code = await runWrapper();
  process.exitCode = code;
});
