import { describe, expect, test } from "vitest";
import { INTERACTIVE_TOOLS, toGateInput } from "../src/tools";

describe("toGateInput", () => {
  test("maps Bash to the floor's lowercase tool name and carries the command", () => {
    const input = toGateInput("Bash", { command: "rm -rf /" }, "fix the test");
    expect(input.tool).toBe("bash");
    expect(input.command).toBe("rm -rf /");
    expect(input.path).toBeUndefined();
  });

  test("maps Edit to write and summarizes the change", () => {
    const input = toGateInput("Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }, "t");
    expect(input.tool).toBe("write");
    expect(input.path).toBe("/p/a.ts");
    expect(input.changeSummary).toContain("-a");
    expect(input.changeSummary).toContain("+b");
    expect(input.evidenceIncomplete).toBe(false);
  });

  test("maps Write to write and treats full content as complete evidence", () => {
    const input = toGateInput("Write", { file_path: "/p/a.ts", content: "hello" }, "t");
    expect(input.tool).toBe("write");
    expect(input.evidenceIncomplete).toBe(false);
  });

  test("maps MultiEdit to write so the floor checks its path", () => {
    const input = toGateInput(
      "MultiEdit",
      {
        file_path: "/etc/hosts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      },
      "t",
    );
    expect(input).toMatchObject({ tool: "write", path: "/etc/hosts", evidenceIncomplete: false });
    expect(input.changeSummary).toContain("+d");
  });

  test("flags a MultiEdit with a malformed edit as incomplete", () => {
    expect(toGateInput("MultiEdit", { file_path: "/p/a.ts", edits: [{ old_string: "a" }] }, "t").evidenceIncomplete).toBe(true);
  });

  test("flags a write with no change evidence as incomplete", () => {
    const input = toGateInput("Write", { file_path: "/p/a.ts" }, "t");
    expect(input.evidenceIncomplete).toBe(true);
  });

  test("maps Read, Grep, and Glob to their floor names", () => {
    expect(toGateInput("Read", { file_path: "/p/.env" }, "t")).toMatchObject({ tool: "read", path: "/p/.env" });
    expect(toGateInput("Grep", { pattern: "x", path: "/p" }, "t")).toMatchObject({ tool: "grep", path: "/p" });
    expect(toGateInput("Glob", { pattern: "*", path: "/p" }, "t")).toMatchObject({ tool: "glob", path: "/p" });
  });

  test("passes unknown and MCP tools through lowercased with no path or command", () => {
    const input = toGateInput("mcp__atlassian__createJiraIssue", { summary: "x" }, "t");
    expect(input.tool).toBe("mcp__atlassian__createjiraissue");
    expect(input.command).toBeUndefined();
    expect(input.path).toBeUndefined();
    expect(input.arguments).toEqual({ summary: "x" });
  });

  test("names the interactive tools Gate must stay out of", () => {
    expect(INTERACTIVE_TOOLS.has("AskUserQuestion")).toBe(true);
    expect(INTERACTIVE_TOOLS.has("ExitPlanMode")).toBe(true);
    expect(INTERACTIVE_TOOLS.has("Bash")).toBe(false);
  });
});
