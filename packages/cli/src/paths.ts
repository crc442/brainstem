import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveParentForWrite } from "@brainstem/core";

export { isInside, resolveParentForWrite, resolvePath } from "@brainstem/core";

/** Local demo tools provide ordinary filesystem access, not sandbox isolation. */
export function writeCapability(): "local-demo" {
  return "local-demo";
}

export interface PreparedDemoWrite {
  readonly root: string;
  readonly path: string;
  readonly target: string;
  readonly content: string;
  readonly expectedState: string;
}

function fileState(target: string): { key: string; mode?: number } {
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { key: "absent" };
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new Error("write target must be a regular file");
    const mode = Number(stat.mode & 0o777n);
    const digest = createHash("sha256").update(readFileSync(fd)).digest("hex");
    return { key: `${stat.dev}:${stat.ino}:${mode}:${digest}`, mode };
  } finally {
    closeSync(fd);
  }
}

/** Snapshot the action before judgment/approval; full contents never become a log summary. */
export function prepareDemoWrite(root: string, path: string, content: string): PreparedDemoWrite {
  const target = resolveParentForWrite(root, path);
  const expectedState = fileState(target).key;
  return Object.freeze({ root, path, target, content, expectedState });
}

/** Best-effort stale-file detection; this is not an atomic compare-and-replace operation. */
export function checkDemoWrite(prepared: PreparedDemoWrite): { changed: boolean; reason: string } {
  try {
    if (resolveParentForWrite(prepared.root, prepared.path) !== prepared.target || fileState(prepared.target).key !== prepared.expectedState) {
      return { changed: true, reason: "write target or contents changed since review" };
    }
    return { changed: false, reason: "" };
  } catch {
    return { changed: true, reason: "write target is no longer an accessible regular file" };
  }
}

/**
 * Ordinary local file replacement for the reference CLI. Private staging and
 * descriptor-based chmod avoid following a staging symlink to change permissions.
 * The final check and rename are separate operations: concurrent writers can
 * still race them. Host isolation/concurrency policy is outside the plugin.
 */
export function executeDemoWrite(prepared: PreparedDemoWrite): { target: string; bytes: number } {
  const initial = checkDemoWrite(prepared);
  if (initial.changed) throw new Error(initial.reason);
  const mode = fileState(prepared.target).mode;
  const parent = dirname(prepared.target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".brainstem-write-"));
  const temporary = join(staging, "content");
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, prepared.content, "utf8");
      // Change permissions through the descriptor, never through a mutable path.
      fchmodSync(fd, mode ?? (0o666 & ~process.umask()));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const final = checkDemoWrite(prepared);
    if (final.changed) throw new Error(final.reason);
    renameSync(temporary, prepared.target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { target: prepared.target, bytes: Buffer.byteLength(prepared.content, "utf8") };
}
