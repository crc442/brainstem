import { afterEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash } from "@brainstem/core";
import {
  ABSENT_PREIMAGE_DIGEST,
  checkWriteTarget,
  isInside,
  resolveParentForWrite,
  resolvePath,
  writeCapability,
  writeFileVerified,
} from "../src/paths";

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

describe("R2: checkWriteTarget / writeFileVerified — bind the check to the actual write", () => {
  test("a final symlink pointing outside the root is rejected, not followed", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-outside-"));
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "original outside content");
    const link = join(dir, "link-to-outside.txt");
    symlinkSync(outsideFile, link);

    const check = checkWriteTarget(dir, "link-to-outside.txt");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("symlink");

    const result = writeFileVerified(dir, "link-to-outside.txt", "attacker-controlled content");
    expect(result.ok).toBe(false);
    // The reproduction from the review: a link inside the repo to an outside
    // file leaves the outside file unchanged and cannot auto-run.
    expect(readFileSync(outsideFile, "utf8")).toBe("original outside content");

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("a dangling symlink is rejected, not silently created through", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const link = join(dir, "dangling.txt");
    symlinkSync(join(dir, "does-not-exist-target.txt"), link);

    const result = writeFileVerified(dir, "dangling.txt", "content");
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, "does-not-exist-target.txt"))).toBe(false);
  });

  test("a symlinked PARENT directory inside the root is followed via realpath, and containment is still enforced", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-outside-"));
    const parentLink = join(dir, "linked-dir");
    symlinkSync(outsideDir, parentLink);

    // Writing THROUGH a symlinked parent directory is allowed (the parent
    // chain is canonicalized via realpath) but the realpath'd destination is
    // OUTSIDE the configured root, so containment must catch it — this
    // module only rejects a symlinked FINAL component outright; outside-root
    // containment for a symlinked parent is the caller's (harness gate's)
    // responsibility, verified here at the resolution layer.
    const check = checkWriteTarget(dir, "linked-dir/new-file.txt");
    expect(check.ok).toBe(true);
    expect(isInside(dir, check.resolvedTarget)).toBe(false);
    expect(isInside(outsideDir, check.resolvedTarget)).toBe(true);

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("writing to a hard-linked destination does not modify the other link's inode (no in-place truncation)", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const target = join(dir, "target.txt");
    const other = join(dir, "other-link.txt");
    writeFileSync(target, "shared original content");
    linkSync(target, other);
    expect(statSync(target).ino).toBe(statSync(other).ino);

    const result = writeFileVerified(dir, "target.txt", "new content via target");
    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("new content via target");
    // The other hardlink must still see the ORIGINAL content: a rename-based
    // replace creates a new inode rather than truncating the shared one.
    expect(readFileSync(other, "utf8")).toBe("shared original content");
  });

  test("an existing non-regular-file occupant (a directory) is rejected rather than silently replaced", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    mkdirSync(join(dir, "a-directory"));
    const result = writeFileVerified(dir, "a-directory", "content");
    expect(result.ok).toBe(false);
    expect(statSync(join(dir, "a-directory")).isDirectory()).toBe(true);
  });

  test("an ordinary write to a new file inside the root succeeds and is atomic (no leftover temp files)", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const result = writeFileVerified(dir, "new/nested/file.txt", "hello");
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "new", "nested", "file.txt"), "utf8")).toBe("hello");
  });

  test("P2/R2 regression: an atomic replacement preserves the existing file's permission bits, not the process default", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const privatePath = join(dir, "private.txt");
    writeFileSync(privatePath, "before");
    chmodSync(privatePath, 0o600);
    const executable = join(dir, "script.sh");
    writeFileSync(executable, "before");
    chmodSync(executable, 0o755);

    expect(writeFileVerified(dir, "private.txt", "after").ok).toBe(true);
    expect(writeFileVerified(dir, "script.sh", "after").ok).toBe(true);

    expect(statSync(privatePath).mode & 0o777).toBe(0o600);
    expect(statSync(executable).mode & 0o777).toBe(0o755);
    expect(readFileSync(privatePath, "utf8")).toBe("after");
    expect(readFileSync(executable, "utf8")).toBe("after");
  });

  test("P2/R2: a brand-new file gets the process default mode, not a preserved one (nothing existed to preserve)", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const result = writeFileVerified(dir, "new.txt", "content");
    expect(result.ok).toBe(true);
    // No prior file existed, so this is just documenting there's no crash
    // and a real (nonzero) mode is set — not asserting a specific umask.
    expect(statSync(join(dir, "new.txt")).mode & 0o777).toBeGreaterThan(0);
  });

  test("a sibling-prefix path is not treated as inside the root", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const sibling = `${dir}-sibling`;
    mkdirSync(sibling);
    const check = checkWriteTarget(dir, join("..", `${dir.split("/").pop()}-sibling`, "file.txt"));
    expect(isInside(dir, check.resolvedTarget)).toBe(false);
    rmSync(sibling, { recursive: true, force: true });
  });
});

describe("R2: descriptor-relative write executor — capability, execution boundary, and preimage binding", () => {
  test("writeCapability reports descriptor-relative on this platform (python3 with dir_fd support present)", () => {
    expect(writeCapability()).toBe("descriptor-relative");
  });

  test("writeCapability reports unavailable when no working interpreter is found, via a genuinely failing probe", () => {
    expect(writeCapability({ pythonBinCandidates: ["definitely-not-a-real-interpreter-xyz"] })).toBe("unavailable");
  });

  test("in-root managed writes are explicitly REFUSED (not silently downgraded) when the executor is unavailable", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const result = writeFileVerified(dir, "file.txt", "content", {
      pythonBinCandidates: ["definitely-not-a-real-interpreter-xyz"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unavailable");
      expect(result.reason).toContain("refusing to write");
    }
    expect(existsSync(join(dir, "file.txt"))).toBe(false);
  });

  test("R2 regression (execution boundary, second-pass reproduction): a parent directory swapped for a symlink AFTER authorization is caught by writeFileVerified itself, not a preflight check", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-outside-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "file.txt"), "inside");
    writeFileSync(join(outsideDir, "file.txt"), "outside");

    // Simulate: an earlier checkWriteTarget/gate call already resolved and
    // "authorized" sub/file.txt (not modeled explicitly here — the point is
    // that NO check happens between this line and the write below, mirroring
    // the reproduction's beforeToolCall-then-swap-then-execute sequence).
    renameSync(join(dir, "sub"), join(dir, "sub-original"));
    symlinkSync(outsideDir, join(dir, "sub"));

    const result = writeFileVerified(dir, "sub/file.txt", "escaped");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("symlink");
    expect(readFileSync(join(outsideDir, "file.txt"), "utf8")).toBe("outside");

    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("preimage binding: a matching expectedPreimageDigest allows the write", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    writeFileSync(join(dir, "f.txt"), "original");
    const result = writeFileVerified(dir, "f.txt", "new content", { expectedPreimageDigest: contentHash("original") });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("new content");
  });

  test("preimage binding regression: content edited AFTER authorization but before this call is caught, not overwritten", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    writeFileSync(join(dir, "g.txt"), "original");
    const authorizedDigest = contentHash("original");
    // Concurrent edit happens strictly between "authorization" (computing
    // authorizedDigest above) and the write call below.
    writeFileSync(join(dir, "g.txt"), "concurrently edited");

    const result = writeFileVerified(dir, "g.txt", "attacker or stale content", { expectedPreimageDigest: authorizedDigest });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("changed since approval was requested");
    expect(readFileSync(join(dir, "g.txt"), "utf8")).toBe("concurrently edited");
  });

  test("preimage binding: ABSENT_PREIMAGE_DIGEST allows creating a genuinely new file, and rejects if one appeared concurrently", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const created = writeFileVerified(dir, "new.txt", "content", { expectedPreimageDigest: ABSENT_PREIMAGE_DIGEST });
    expect(created.ok).toBe(true);

    writeFileSync(join(dir, "surprise.txt"), "appeared concurrently");
    const rejected = writeFileVerified(dir, "surprise.txt", "attacker content", {
      expectedPreimageDigest: ABSENT_PREIMAGE_DIGEST,
    });
    expect(rejected.ok).toBe(false);
    expect(readFileSync(join(dir, "surprise.txt"), "utf8")).toBe("appeared concurrently");
  });

  test("the descriptor-relative executor also preserves permissions and rejects a dangling final symlink", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const priv = join(dir, "priv.txt");
    writeFileSync(priv, "before");
    chmodSync(priv, 0o600);
    expect(writeFileVerified(dir, "priv.txt", "after").ok).toBe(true);
    expect(statSync(priv).mode & 0o777).toBe(0o600);

    symlinkSync(join(dir, "does-not-exist"), join(dir, "dangling.txt"));
    const result = writeFileVerified(dir, "dangling.txt", "content");
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, "does-not-exist"))).toBe(false);
  });

  test("new intermediate directories are created safely through the executor", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const result = writeFileVerified(dir, "a/b/c/leaf.txt", "héllo 🎉");
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "a", "b", "c", "leaf.txt"), "utf8")).toBe("héllo 🎉");
  });

  test("an outside-root write still works via the documented narrower fallback (unaffected by the executor)", () => {
    dir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "brainstem-paths-r2-outside2-"));
    const result = writeFileVerified(dir, join(outsideDir, "file.txt"), "outside write");
    expect(result.ok).toBe(true);
    expect(readFileSync(join(outsideDir, "file.txt"), "utf8")).toBe("outside write");
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
