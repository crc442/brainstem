import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function socketDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "brainstem");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(env.TMPDIR ?? "/tmp", `brainstem-${uid}`);
}

export function socketPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  // Unix socket paths are capped near 104 bytes on macOS, so the session id is
  // hashed rather than embedded.
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return join(socketDir(env), `${key}.sock`);
}

export function ensureSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = statSync(dir);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`refusing to use ${dir}: owned by uid ${stats.uid}`);
  }
  // Narrowing a pre-existing wide-open directory in place would silently defeat the
  // refusal this guards: refuse instead of repairing it.
  if (stats.mode & 0o077) throw new Error(`refusing to use ${dir}: permissions allow other users`);
}
