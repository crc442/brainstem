import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside, resolveParentForWrite, resolvePath, writeCapability, writeFileVerified, WRITE_UNAVAILABLE_REASON } from "../src/paths";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("resolvePath", () => {
  test("joins relative targets to root and normalizes . and .. segments", () => {
    expect(resolvePath("/repo", "src/./auth.ts")).toBe("/repo/src/auth.ts");
    expect(resolvePath("/repo", "src/sub/../auth.ts")).toBe("/repo/src/auth.ts");
    expect(resolvePath("/repo", "../escape.txt")).toBe("/escape.txt");
  });

  test("absolute targets bypass root", () => {
    expect(resolvePath("/repo", "/tmp/scratch.txt")).toBe("/tmp/scratch.txt");
    expect(resolvePath("/repo", "/repo/src/auth.ts")).toBe("/repo/src/auth.ts");
  });

  test("~ resolves against HOME", () => {
    const home = process.env.HOME ?? "/";
    expect(resolvePath("/repo", "~/notes.txt")).toBe(join(home, "notes.txt"));
    expect(resolvePath("/repo", "~")).toBe(home);
  });
});

describe("R2: resolvePath/isInside stay consistent when the root itself is a symlink", () => {
  test("a not-yet-existing target under a symlinked root (e.g. os.tmpdir() on macOS) still resolves inside", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-symlink-root-"));
    const resolved = resolvePath(dir, "not-yet-created/file.txt");
    expect(isInside(dir, resolved)).toBe(true);
  });
});

describe("isInside", () => {
  test("handles the sibling-prefix trap", () => {
    expect(isInside("/root", "/root/file.txt")).toBe(true);
    expect(isInside("/root", "/root/sub/file.txt")).toBe(true);
    expect(isInside("/root", "/root")).toBe(true);
    expect(isInside("/root", "/root2/file.txt")).toBe(false);
    expect(isInside("/root", "/root/../root2/file.txt")).toBe(false);
    expect(isInside("/root", "/escape.txt")).toBe(false);
  });
});

describe("resolveParentForWrite", () => {
  test("resolves a not-yet-existing parent chain inside the root", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-"));
    const result = resolveParentForWrite(dir, "new/deep/file.txt");
    expect(result.endsWith(join("new", "deep", "file.txt"))).toBe(true);
    expect(isInside(dir, result)).toBe(true);
  });

  test("existing parents are realpathed so symlinked roots stay contained", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-"));
    const result = resolveParentForWrite(dir, "file.txt");
    expect(result).toBe(join(realpathSync(dir), "file.txt"));
  });

  test("absolute escapes stay outside the root", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-"));
    const result = resolveParentForWrite(dir, "/tmp/brainstem-escape/file.txt");
    expect(isInside(dir, result)).toBe(false);
  });
});

describe("R2/R3: unavailable managed writes have no filesystem effects", () => {
  test("capability is unavailable even when descriptor-relative syscalls are supported", () => {
    expect(writeCapability()).toBe("unavailable");
  });

  test.each(["existing", "absent", "outside", "symlink", "hardlink", "nested", "directory"])("refuses %s targets without staging, replacing, or chmod", (kind) => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-write-unavailable-"));
    const root = join(dir, "repo");
    mkdirSync(root);
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "outside");
    chmodSync(outside, 0o600);
    const existing = join(root, "file.txt");
    writeFileSync(existing, "concurrent edit");
    chmodSync(existing, 0o755);
    symlinkSync(outside, join(root, "link.txt"));
    linkSync(outside, join(root, "hard.txt"));
    mkdirSync(join(root, "folder"));
    const targets: Record<string, string> = {
      existing: "file.txt", absent: "new.txt", outside, symlink: "link.txt",
      hardlink: "hard.txt", nested: "new/deep/file.txt", directory: "folder",
    };
    const before = readdirSync(root).sort();
    const inode = statSync(existing).ino;
    const result = writeFileVerified(root, targets[kind]!, "stale replacement");
    expect(result).toEqual({ ok: false, reason: WRITE_UNAVAILABLE_REASON });
    expect(readFileSync(existing, "utf8")).toBe("concurrent edit");
    expect(statSync(existing).ino).toBe(inode);
    expect(statSync(existing).mode & 0o777).toBe(0o755);
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(statSync(outside).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).sort()).toEqual(before);
    expect(existsSync(join(root, "new"))).toBe(false);
  });
});
