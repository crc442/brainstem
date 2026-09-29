import { createServer, type Server } from "node:net";
import { unlinkSync } from "node:fs";
// policyForTrust lives in @brainstem/core; @brainstem/reflexes consumes it but does not re-export it.
import { policyForTrust } from "@brainstem/core";
import { createReflexes, createPluginSession, type SystemOne } from "@brainstem/reflexes";
import { handle, type DaemonState } from "./handlers";
import { composeEnvironment } from "../environment";
import { distPath } from "../hook/io";
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
  settingsFiles?: string[];
  filterPath?: string;
}

export async function createDaemon(options: DaemonOptions): Promise<{ close(): Promise<void> }> {
  const reflexes = createReflexes({
    judge: options.judge,
    root: options.root,
    environment: composeEnvironment(options.config),
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
    settingsFiles: options.settingsFiles ?? [],
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
