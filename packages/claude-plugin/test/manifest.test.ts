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

  test("package exposes the daemon and output-filter binaries", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("@brainstem/claude-plugin");
    expect(Object.keys(pkg.bin)).toEqual(expect.arrayContaining(["brainstemd", "brainstem-output"]));
  });
});
