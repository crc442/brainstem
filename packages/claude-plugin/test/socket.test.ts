import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketPath, ensureSocketDir } from "../src/socket";

describe("socketPath", () => {
  test("prefers XDG_RUNTIME_DIR when it is set", () => {
    const path = socketPath("sess-1", { XDG_RUNTIME_DIR: "/run/user/501" });
    expect(path.startsWith("/run/user/501/brainstem/")).toBe(true);
  });

  test("falls back to a uid-scoped TMPDIR directory, which is the macOS case", () => {
    const path = socketPath("sess-1", { TMPDIR: "/var/folders/xy/" });
    expect(path).toMatch(/^\/var\/folders\/xy\/brainstem-\d+\//);
  });

  test("hashes the session id and stays inside the platform path limit", () => {
    const path = socketPath("a".repeat(400), { XDG_RUNTIME_DIR: "/run/user/501" });
    expect(path).not.toContain("aaaa");
    expect(Buffer.byteLength(path)).toBeLessThan(104);
  });

  test("is stable for the same session and distinct across sessions", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/501" };
    expect(socketPath("s1", env)).toBe(socketPath("s1", env));
    expect(socketPath("s1", env)).not.toBe(socketPath("s2", env));
  });
});

describe("ensureSocketDir", () => {
  test("creates the directory with 0700", () => {
    const base = mkdtempSync(join(tmpdir(), "bs-sock-"));
    const dir = join(base, "brainstem");
    ensureSocketDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    rmSync(base, { recursive: true, force: true });
  });

  test("refuses a directory that is group- or world-accessible", () => {
    const base = mkdtempSync(join(tmpdir(), "bs-sock-"));
    const dir = join(base, "brainstem");
    mkdirSync(dir, { mode: 0o755 });
    expect(() => ensureSocketDir(dir)).toThrow(/permissions/);
    rmSync(base, { recursive: true, force: true });
  });
});
