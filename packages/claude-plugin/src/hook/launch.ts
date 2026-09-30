import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { UNREACHABLE, errorCode, request, requestOrDefer } from "./client";
import { distPath } from "./io";
import { ensureSocketDir, socketDir, socketPath } from "../socket";
import type { Request, Response } from "../protocol";

const READY_TIMEOUT_MS = 3_000;

const ping = (socket: string, timeoutMs: number) => requestOrDefer(socket, { kind: "ping" }, timeoutMs);

export async function ensureDaemon(sessionId: string): Promise<boolean> {
  const socket = socketPath(sessionId);
  if (await ping(socket, 1_000)) return true;

  ensureSocketDir(socketDir());
  const log = openSync(socket.replace(/\.sock$/, ".log"), "a");
  spawn(process.execPath, [distPath("daemon/main.mjs"), "--socket", socket], {
    detached: true,
    stdio: ["ignore", log, log],
    cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  }).unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping(socket, 200)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** Never throws. An unreachable daemon is respawned once; the new one starts with empty session state. */
export async function requestSession(sessionId: string, payload: Request, timeoutMs?: number): Promise<Response | undefined> {
  const socket = socketPath(sessionId);
  try {
    return await request(socket, payload, timeoutMs);
  } catch (error) {
    if (!UNREACHABLE.has(errorCode(error))) return undefined;
  }
  return (await ensureDaemon(sessionId)) ? requestOrDefer(socket, payload, timeoutMs) : undefined;
}
