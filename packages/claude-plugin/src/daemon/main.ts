#!/usr/bin/env node
import { createServer, type Server } from "node:net";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
// policyForTrust lives in @brainstem/core; @brainstem/reflexes consumes it but does not re-export it.
import { policyForTrust } from "@brainstem/core";
import { createReflexes, createPluginSession, REVIEW_CHAR_CAP, type SystemOne } from "@brainstem/reflexes";
import { handle, type DaemonState } from "./handlers";
import { composeEnvironment } from "../environment";
import { distPath, runIfEntry } from "../hook/io";
import { requestOrDefer } from "../hook/client";
import { loadRawConfig, resolveConfig } from "../config";
import { buildJudge, selectJudge } from "../judge";
import type { PluginConfig } from "../config";
import type { Request } from "../protocol";

// The idle exit only reaps orphans whose SessionEnd never fired. A live session that
// outlasts it loses nothing but warm state: any hook respawns the daemon (Task 9).
const IDLE_EXIT_MS = 30 * 60 * 1000;

export interface DaemonOptions {
  socket: string;
  judge: SystemOne;
  config: PluginConfig;
  root: string;
  filterPath?: string;
}

export async function createDaemon(options: DaemonOptions): Promise<{ close(): Promise<void> }> {
  const environment = composeEnvironment(options.config);
  if (!environment.complete) {
    process.stderr.write(
      `brainstem: policy evidence exceeds the ${REVIEW_CHAR_CAP}-character review limit (${environment.totalChars} characters); shorten the policy\n`,
    );
  }
  const reflexes = createReflexes({
    judge: options.judge,
    root: options.root,
    environment: environment.text,
    policy: policyForTrust(options.config.trust),
    journalPath: options.config.journalPath,
  });
  const session = createPluginSession(reflexes, { modes: options.config.modes });

  let idleTimer: ReturnType<typeof setTimeout>;
  const state: DaemonState = {
    reflexes,
    session,
    config: options.config,
    root: options.root,
    socket: options.socket,
    environmentComplete: environment.complete,
    environmentTotalChars: environment.totalChars,
    filterPath: options.filterPath ?? distPath("output/filter.mjs"),
    task: "unspecified",
    toolTurns: 0,
    checkpointedAt: 0,
    recent: [],
    wrapped: new Set(),
    observed: new Set(),
    onShutdown: () => void close(),
  };

  const server: Server = createServer((socket) => {
    resetIdle();
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        try {
          const response = await handle(JSON.parse(line) as Request, state);
          socket.write(`${JSON.stringify(response)}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ kind: "error", message: String(error) })}\n`);
        }
      }
    });
    socket.on("error", () => socket.destroy());
  });

  function resetIdle() {
    clearTimeout(idleTimer);
    // An orphaned daemon reaps itself if SessionEnd never fires.
    idleTimer = setTimeout(() => void close(), IDLE_EXIT_MS);
    idleTimer.unref?.();
  }

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    session.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(options.socket);
    } catch {
      // Already removed; nothing to clean up.
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socket, () => resolve());
  });
  resetIdle();

  return { close };
}

const JUDGE_BACKED_MODES = {
  sanitize: "off",
  verify: "off",
  focus: "off",
  select: "off",
  pulse: "off",
  steer: "off",
  messageGate: "off",
} as const;

async function startFromCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { socket: { type: "string" }, "print-config": { type: "boolean" } } });
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const { raw, ignored } = loadRawConfig({ home: homedir(), projectDir });
  const selection = selectJudge(process.env);
  const config = resolveConfig(selection.kind === "unavailable" ? { ...raw, modes: { ...raw.modes, ...JUDGE_BACKED_MODES } } : raw);

  if (values["print-config"]) {
    process.stdout.write(`${JSON.stringify({ config, judge: selection, ignored }, null, 2)}\n`);
    return;
  }
  if (!values.socket) throw new Error("brainstemd requires --socket <path>");
  for (const entry of ignored) process.stderr.write(`brainstem: ignored project-scoped key ${entry}\n`);
  if (selection.kind !== "jev") process.stderr.write(`brainstem: ${selection.note}\n`);

  const options = {
    socket: values.socket,
    judge: await buildJudge(selection),
    config,
    root: projectDir,
  };
  try {
    await createDaemon(options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    // Either a live daemon already serves this session, or a crash left the file
    // behind. requestOrDefer unlinks a file nothing listens on, so one retry binds.
    if (await requestOrDefer(values.socket, { kind: "ping" }, 1_000)) return;
    await createDaemon(options);
  }
}

runIfEntry(import.meta.url, () => startFromCli(process.argv.slice(2)));
