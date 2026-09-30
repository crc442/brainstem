// packages/claude-plugin/test/environment.test.ts
import { describe, expect, test } from "vitest";
import { composeEnvironment } from "../src/environment";
import { resolveConfig } from "../src/config";

describe("composeEnvironment", () => {
  test("labels each category so the judge can tell them apart", () => {
    const { text, complete } = composeEnvironment(
      resolveConfig({ allow: ["A1"], soft_deny: ["S1"], hard_deny: ["H1"], environment: ["E1"] }),
    );
    expect(complete).toBe(true);
    expect(text).toContain("ENVIRONMENT:\n- E1");
    expect(text).toContain("ALLOW (treat as routine):\n- A1");
    expect(text).toContain("SOFT BLOCK (block unless the user's intent clears it):\n- S1");
    expect(text).toContain("HARD BLOCK (never cleared by user intent):\n- H1");
  });

  test("orders hard block last so it reads as the final constraint", () => {
    const { text } = composeEnvironment(resolveConfig({}));
    expect(text.indexOf("HARD BLOCK")).toBeGreaterThan(text.indexOf("SOFT BLOCK"));
    expect(text.indexOf("SOFT BLOCK")).toBeGreaterThan(text.indexOf("ALLOW"));
  });

  test("omits an empty category rather than emitting a dangling header", () => {
    const { text } = composeEnvironment(resolveConfig({ allow: [], soft_deny: [], hard_deny: [], environment: ["E1"] }));
    expect(text).toContain("ENVIRONMENT:");
    expect(text).not.toContain("ALLOW");
  });

  test("is bounded so a large rule set cannot crowd out the action", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `rule ${i} ${"x".repeat(200)}`);
    const result = composeEnvironment(resolveConfig({ allow: huge }));
    expect(result.text.length).toBeLessThanOrEqual(8_000);
    expect(result.complete).toBe(false);
    expect(result.totalChars).toBeGreaterThan(8_000);
  });

  test("marks evidence exactly at the limit complete and avoids splitting a surrogate pair", () => {
    const emptyOtherSections = { allow: [], soft_deny: [], hard_deny: [] };
    const exact = composeEnvironment(
      resolveConfig({ ...emptyOtherSections, environment: ["x".repeat(8_000 - "ENVIRONMENT:\n- ".length)] }),
    );
    // The rendered evidence includes the environment heading, so the rule length above makes it exact.
    expect(exact.text.length).toBe(8_000);
    expect(exact.complete).toBe(true);
    const over = composeEnvironment(
      resolveConfig({ ...emptyOtherSections, environment: ["x".repeat(8_000 - "ENVIRONMENT:\n- ".length - 1) + "😀"] }),
    );
    expect(over.complete).toBe(false);
    expect(over.text.length).toBeLessThanOrEqual(8_000);
    expect(over.text.charCodeAt(over.text.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });
});
