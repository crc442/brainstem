import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

describe("plugin manifest", () => {
  test("declares a name, version, and description", () => {
    const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("brainstem");
    expect(typeof manifest.version).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  // publint rejects a bin whose target is missing, so each binary is declared only
  // once its entry exists; brainstem-output joins in Task 12.
  test("package exposes the daemon binary", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("@brainstem/claude-plugin");
    expect(Object.keys(pkg.bin)).toEqual(expect.arrayContaining(["brainstemd"]));
  });
});
