import { describe, expect, test } from "vitest";
import { buildWrapperCommand, shellQuote } from "../src/output/command";

describe("output wrapper command", () => {
  test("shell-quotes every argument as data", () => {
    const values = ["/opt/node with spaces/node", "/plugin/O'Brien/输出.mjs", "/tmp/socket path.sock", "toolu_'$(touch nope)_雪"];
    const command = buildWrapperCommand({
      executable: values[0]!,
      entry: values[1]!,
      socket: values[2]!,
      toolUseId: values[3]!,
      command: "npm test -- -t 'quote; $(echo hostile)'",
    });
    expect(command).toBe(
      [values[0], values[1], "--socket", values[2], "--tool-use-id", values[3], "--command", "npm test -- -t 'quote; $(echo hostile)'"]
        .map((value) => shellQuote(value!))
        .join(" "),
    );
  });

  test.each(["npm test:other", "npm test && echo done", "npm test | tee out", "echo npm test", "npm test > out"])(
    "does not wrap %s",
    (command) => {
      expect(buildWrapperCommand({ executable: "node", entry: "filter.mjs", socket: "s", toolUseId: "id", command })).toBeUndefined();
    },
  );

  test("wraps a single known test or typecheck command", () => {
    expect(
      buildWrapperCommand({ executable: "node", entry: "filter.mjs", socket: "s", toolUseId: "id", command: "bun run typecheck" }),
    ).toContain("--command");
  });
});
