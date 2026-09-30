import { connect } from "node:net";
import { unlinkSync } from "node:fs";
import type { Request, Response } from "../protocol";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Error codes meaning no daemon is listening, as opposed to one that is slow. */
export const UNREACHABLE = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);
const STALE_FILE = new Set(["ECONNREFUSED", "ENOTSOCK"]);

export const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? "";

export function request(socket: string, payload: Request, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const client = connect(socket);
    let buffer = "";
    const done = (error?: Error, response?: Response) => {
      clearTimeout(timer);
      client.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(() => done(new Error(`brainstem daemon timed out after ${timeoutMs}ms`)), timeoutMs);
    client.on("connect", () => client.write(`${JSON.stringify(payload)}\n`));
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        done(undefined, JSON.parse(buffer.slice(0, newline)) as Response);
      } catch (error) {
        done(error as Error);
      }
    });
    client.on("error", (error) => done(error));
    client.on("close", () => done(new Error("brainstem daemon closed the connection")));
  });
}

/**
 * Never throws. An unavailable daemon yields `undefined`, which callers render as
 * "no decision" so Claude Code applies its own permission rules.
 */
export async function requestOrDefer(socket: string, payload: Request, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response | undefined> {
  try {
    return await request(socket, payload, timeoutMs);
  } catch (error) {
    if (STALE_FILE.has(errorCode(error))) {
      try {
        unlinkSync(socket);
      } catch {
        // Another client already removed it.
      }
    }
    return undefined;
  }
}
