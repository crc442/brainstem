import { describe, expect, test } from "vitest";
import { detectFamily, isSimpleCommand, filterOutput } from "../src/output/families";

describe("detectFamily", () => {
  test("recognizes test runners", () => {
    expect(detectFamily("npm test")).toBe("testrunner");
    expect(detectFamily("bun run test")).toBe("testrunner");
    expect(detectFamily("npx vitest run")).toBe("testrunner");
    expect(detectFamily("pytest -q")).toBe("testrunner");
  });

  test("recognizes the type checker", () => {
    expect(detectFamily("bun run typecheck")).toBe("tsc");
    expect(detectFamily("npx tsc --noEmit")).toBe("tsc");
  });

  test("only matches at the start of the command", () => {
    expect(detectFamily("cat notes-about-vitest.md")).toBeNull();
    expect(detectFamily("echo npm test")).toBeNull();
  });

  test("returns null for anything unrecognized", () => {
    expect(detectFamily("ls -la")).toBeNull();
    expect(detectFamily("curl https://example.com")).toBeNull();
  });
});

describe("isSimpleCommand", () => {
  test("rejects anything that could change shell state or break the wrapper", () => {
    for (const cmd of [
      "cd src && npm test",
      "npm test; cd ..",
      "FOO=1; npm test",
      "npm test\ncd src",
      "npm test # all of them",
      "npm test > out.txt",
      "npm test < input",
      "npm test &",
      "npm test | tee log",
      "npm test -- $FILE",
      "npm test `pwd`",
      "npm test $(pwd)",
      "npm test \\",
    ]) {
      expect(isSimpleCommand(cmd), cmd).toBe(false);
    }
  });

  test("accepts an ordinary command with quoted arguments", () => {
    expect(isSimpleCommand("npm test -- --run")).toBe(true);
    expect(isSimpleCommand('npx vitest run -t "adds numbers"')).toBe(true);
  });
});

describe("filterOutput", () => {
  test("keeps failing test lines and drops passing noise", () => {
    const raw = [
      "PASS src/a.test.ts",
      "PASS src/b.test.ts",
      "FAIL src/c.test.ts",
      "  AssertionError: expected 1 to be 2",
      "Tests: 1 failed, 2 passed",
    ].join("\n");
    const filtered = filterOutput("testrunner", raw);
    expect(filtered).toContain("FAIL src/c.test.ts");
    expect(filtered).toContain("AssertionError");
    expect(filtered).toContain("Tests: 1 failed");
    expect(filtered).not.toContain("PASS src/a.test.ts");
  });

  test("keeps a bare Error: line", () => {
    const filtered = filterOutput("testrunner", "PASS src/a.test.ts\nError: connect ECONNREFUSED\nTests: 1 failed");
    expect(filtered).toContain("Error: connect ECONNREFUSED");
    expect(filtered).not.toContain("PASS src/a.test.ts");
  });

  test("keeps every line when nothing failed, so a green run still reads as green", () => {
    const raw = "PASS src/a.test.ts\nTests: 3 passed";
    expect(filterOutput("testrunner", raw)).toBe(raw);
  });

  test("keeps only diagnostic lines for tsc", () => {
    const raw = "src/a.ts(3,1): error TS2322: Type 'x'\nsome banner\nsrc/b.ts(9,2): error TS1005: ';' expected";
    const filtered = filterOutput("tsc", raw);
    expect(filtered).toContain("TS2322");
    expect(filtered).toContain("TS1005");
    expect(filtered).not.toContain("some banner");
  });

  test("passes output through unchanged for an unknown family", () => {
    expect(filterOutput(null, "anything")).toBe("anything");
  });
});
