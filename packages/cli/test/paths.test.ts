import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside, resolveParentForWrite, resolvePath, writeCapability, prepareDemoWrite, executeDemoWrite } from "../src/paths";

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

describe("reference CLI local writes", () => {
  test("advertises local demo execution rather than isolation", () => {
    expect(writeCapability()).toBe("local-demo");
  });

  test("creates nested files and replaces existing files while preserving mode and hardlink contents", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-demo-write-"));
    const linked = join(dir, "linked.txt");
    writeFileSync(linked, "original");
    chmodSync(linked, 0o755);
    linkSync(linked, join(dir, "target.txt"));
    executeDemoWrite(prepareDemoWrite(dir, "new/deep/file.txt", "new"));
    executeDemoWrite(prepareDemoWrite(dir, "target.txt", "replacement"));
    expect(readFileSync(join(dir, "new/deep/file.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(dir, "target.txt"), "utf8")).toBe("replacement");
    expect(readFileSync(linked, "utf8")).toBe("original");
    expect(statSync(join(dir, "target.txt")).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir).some((name) => name.startsWith(".brainstem-write-"))).toBe(false);
  });

  test("rejects final symlinks and directories without changing their targets", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-demo-write-"));
    writeFileSync(join(dir, "original.txt"), "original");
    symlinkSync(join(dir, "original.txt"), join(dir, "link.txt"));
    symlinkSync(join(dir, "absent.txt"), join(dir, "dangling.txt"));
    mkdirSync(join(dir, "folder"));
    for (const path of ["link.txt", "dangling.txt", "folder"]) {
      expect(() => prepareDemoWrite(dir, path, "replacement")).toThrow();
    }
    expect(readFileSync(join(dir, "original.txt"), "utf8")).toBe("original");
    expect(existsSync(join(dir, "absent.txt"))).toBe(false);
  });

  test("detects edits between preparation and execution", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-demo-write-"));
    const target = join(dir, "file.txt");
    writeFileSync(target, "original");
    const prepared = prepareDemoWrite(dir, "file.txt", "replacement");
    writeFileSync(target, "editor change");
    expect(() => executeDemoWrite(prepared)).toThrow(/changed since review/);
    expect(readFileSync(target, "utf8")).toBe("editor change");
  });
});
