import { describe, expect, test } from "vitest";
import { renderPreToolUse } from "../src/hook/pre-tool-use";

describe("renderPreToolUse", () => {
  test("auto becomes allow", () => {
    const out = renderPreToolUse({ kind: "reviewAction", action: "auto", reasons: ["on task"], mode: "active" });
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "allow" });
    expect(out.hookSpecificOutput!.permissionDecisionReason).toContain("on task");
  });

  test("ask becomes ask", () => {
    const out = renderPreToolUse({ kind: "reviewAction", action: "ask", reasons: ["static floor: risky pattern"], mode: "active" });
    expect(out.hookSpecificOutput!.permissionDecision).toBe("ask");
  });

  test("deny becomes deny", () => {
    const out = renderPreToolUse({ kind: "reviewAction", action: "deny", reasons: ["static floor"], mode: "active" });
    expect(out.hookSpecificOutput!.permissionDecision).toBe("deny");
  });

  test("skip emits no decision, whether from shadow mode or a deferred ask", () => {
    for (const mode of ["shadow", "active"] as const) {
      expect(renderPreToolUse({ kind: "reviewAction", action: "skip", reasons: ["disposition ask_user"], mode })).toEqual({});
    }
  });

  test("an unavailable daemon emits no decision and says so", () => {
    const out = renderPreToolUse(undefined);
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.systemMessage).toContain("brainstem is unavailable");
  });

  test("a daemon error emits no decision and names the error", () => {
    const out = renderPreToolUse({ kind: "error", message: "stale plugin result" });
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.systemMessage).toContain("stale plugin result");
  });

  test("a wrap is only ever emitted together with an explicit allow, and says it is there", () => {
    const out = renderPreToolUse(
      { kind: "reviewAction", action: "auto", reasons: [], mode: "active", wrap: { command: "wrapped" } },
      { command: "npm test", timeout: 600_000, description: "run tests" },
    );
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "allow" });
    // updatedInput replaces the whole input, so every other field must survive.
    expect(out.hookSpecificOutput!.updatedInput).toEqual({ command: "wrapped", timeout: 600_000, description: "run tests" });
    expect(out.hookSpecificOutput!.permissionDecisionReason).toContain("output review");
  });

  test("preserves every Bash input field while replacing command", () => {
    const input = { command: "npm test", timeout: 420_000, description: "run suite", run_in_background: true };
    const out = renderPreToolUse(
      { kind: "reviewAction", action: "auto", reasons: [], mode: "active", wrap: { command: "node 'filter.mjs'" } },
      input,
    );
    expect(out.hookSpecificOutput?.updatedInput).toEqual({ ...input, command: "node 'filter.mjs'" });
  });

  test("a wrap accompanying ask is dropped, because a rewrite would be re-matched and denied", () => {
    const out = renderPreToolUse({ kind: "reviewAction", action: "ask", reasons: [], mode: "active", wrap: { command: "wrapped" } });
    expect(out.hookSpecificOutput!.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput!.updatedInput).toBeUndefined();
  });
});
