// packages/claude-plugin/test/environment.test.ts
import { describe, expect, test } from "vitest";
import { composeEnvironment } from "../src/environment";
import { resolveConfig } from "../src/config";

describe("composeEnvironment", () => {
  test("labels each category so the judge can tell them apart", () => {
    const text = composeEnvironment(resolveConfig({ allow: ["A1"], soft_deny: ["S1"], hard_deny: ["H1"], environment: ["E1"] }));
    expect(text).toContain("ENVIRONMENT:\n- E1");
    expect(text).toContain("ALLOW (treat as routine):\n- A1");
    expect(text).toContain("SOFT BLOCK (block unless the user's intent clears it):\n- S1");
    expect(text).toContain("HARD BLOCK (never cleared by user intent):\n- H1");
  });

  test("orders hard block last so it reads as the final constraint", () => {
    const text = composeEnvironment(resolveConfig({}));
    expect(text.indexOf("HARD BLOCK")).toBeGreaterThan(text.indexOf("SOFT BLOCK"));
    expect(text.indexOf("SOFT BLOCK")).toBeGreaterThan(text.indexOf("ALLOW"));
  });

  test("omits an empty category rather than emitting a dangling header", () => {
    const text = composeEnvironment(resolveConfig({ allow: [], soft_deny: [], hard_deny: [], environment: ["E1"] }));
    expect(text).toContain("ENVIRONMENT:");
    expect(text).not.toContain("ALLOW");
  });

  test("is bounded so a large rule set cannot crowd out the action", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `rule ${i} ${"x".repeat(200)}`);
    const text = composeEnvironment(resolveConfig({ allow: huge }));
    expect(text.length).toBeLessThanOrEqual(8_000);
  });
});
