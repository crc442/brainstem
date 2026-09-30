#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { runIfEntry } from "../hook/io";
import { request } from "../hook/client";
import type { ObserveResponse, Request, Response } from "../protocol";

const STREAM_CAP = 256 * 1024;
const REVIEW_TIMEOUT_MS = 15_000;
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
  omitted: boolean;
  closed: boolean;
}

function streamCapture(child: ChildProcess, name: "stdout" | "stderr"): CapturedStream {
  const stream = { chunks: [] as Buffer[], bytes: 0, omitted: false, closed: false };
  const pipe = child[name];
  if (!pipe) {
    stream.closed = true;
    return stream;
  }
  pipe.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const keep = Math.max(0, Math.min(bytes.length, STREAM_CAP - stream.bytes));
    if (keep) {
      stream.chunks.push(bytes.subarray(0, keep));
      stream.bytes += keep;
    }
    if (keep < bytes.length) stream.omitted = true;
  });
  pipe.on("end", () => {
    stream.closed = true;
  });
  return stream;
}

function renderedCapture(stdout: CapturedStream, stderr: CapturedStream): { text: string; complete: boolean } {
  const out = decodeCapturedChunks(stdout.chunks);
  const err = decodeCapturedChunks(stderr.chunks);
  const sections = [
    `--- stdout ---${stdout.omitted ? " [capture limit reached; additional bytes omitted]" : ""}\n${out}`,
    `--- stderr ---${stderr.omitted ? " [capture limit reached; additional bytes omitted]" : ""}\n${err}`,
  ];
  return { text: sections.join("\n"), complete: stdout.closed && stderr.closed && !stdout.omitted && !stderr.omitted };
}

export function decodeCapturedChunks(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal && SIGNAL_CODES[signal]) return SIGNAL_CODES[signal];
  return code ?? 1;
}

export function forwardSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Process may have exited while cancellation was being forwarded.
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
  let interrupted: NodeJS.Signals | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    if (!interrupted) interrupted = signal;
    forwardSignal(child, signal);
  };
  const onHup = () => forward("SIGHUP");
  const onInt = () => forward("SIGINT");
  const onQuit = () => forward("SIGQUIT");
  const onTerm = () => forward("SIGTERM");
  process.once("SIGHUP", onHup);
  process.once("SIGINT", onInt);
  process.once("SIGQUIT", onQuit);
  process.once("SIGTERM", onTerm);

  let didTimeout = false;
  timeout = setTimeout(
    () => {
      didTimeout = true;
      forward("SIGTERM");
      const kill = setTimeout(() => forward("SIGKILL"), 2_000);
      kill.unref?.();
      child.once("close", () => clearTimeout(kill));
    },
    30 * 60 * 1000,
  );
  timeout.unref?.();

  let closeResult: { code: number | null; signal: NodeJS.Signals | null };
  try {
    closeResult = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
    ]);
  } catch {
    clearTimeout(timeout);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGHUP", onHup);
    process.removeListener("SIGQUIT", onQuit);
    process.removeListener("SIGTERM", onTerm);
    process.stdout.write(`${REVIEW_UNAVAILABLE}\n`);
    return 1;
  }
  clearTimeout(timeout);
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGHUP", onHup);
  process.removeListener("SIGQUIT", onQuit);
  process.removeListener("SIGTERM", onTerm);

  // Child close fires after both output pipes have closed. Do not send an incomplete
  // claim while Node still has buffered stream data to deliver.
  const captured = renderedCapture(stdout, stderr);
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
