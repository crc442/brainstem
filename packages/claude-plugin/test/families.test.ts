import { describe, expect, test } from "vitest";
import { detectFamily, isSimpleCommand, filterOutput, presentOutput } from "../src/output/families";

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
    expect(detectFamily("npm test:other")).toBeNull();
    expect(detectFamily("npm run typecheck:watch")).toBeNull();
    expect(detectFamily("jest-extra")).toBeNull();
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
    expect(isSimpleCommand("npx vitest run -t 'case; echo safe' # nope")).toBe(false);
    expect(isSimpleCommand("npx vitest run -t 'case; echo safe'")).toBe(true);
    expect(isSimpleCommand('npx vitest run -t "a $HOME"')).toBe(false);
    expect(isSimpleCommand('npm test -- "a\\"b"; echo EXTRA #"')).toBe(false);
    expect(isSimpleCommand('npm test -- "a\\"b"; cd /tmp')).toBe(false);
    expect(isSimpleCommand('npm test -- "a\\\\b"')).toBe(true);
    expect(isSimpleCommand('npm test -- "a\\$b"')).toBe(true);
    expect(isSimpleCommand('npm test -- "a\\`b"')).toBe(true);
    expect(isSimpleCommand("npm test -- 'quoted ; \" # data'\\ extra")).toBe(true);
    expect(isSimpleCommand("npm test -- foo\\;bar")).toBe(true);
    expect(isSimpleCommand("npm test -- foo\\\nbar")).toBe(false);
    expect(isSimpleCommand('npm test -- "multi\nline"')).toBe(false);
  });
});

describe("filterOutput", () => {
  test("keeps multiline failure evidence and drops distant passing noise", () => {
    const raw = [
      ...Array.from({ length: 12 }, (_, index) => `PASS src/passing-${index}.test.ts`),
      "FAIL src/c.test.ts",
      "  src/c.test.ts:14:3",
      "  AssertionError: expected 1 to be 2",
      "    Expected: 2",
      "    Received: 1",
      "      at runCase (src/c.test.ts:14:3)",
      "      at Object.<anonymous> (src/c.test.ts:20:1)",
      "",
      "Tests: 1 failed, 2 passed",
    ].join("\n");
    const filtered = filterOutput("testrunner", raw);
    expect(filtered).toContain("FAIL src/c.test.ts");
    expect(filtered).toContain("AssertionError");
    expect(filtered).toContain("Expected: 2");
    expect(filtered).toContain("at runCase");
    expect(filtered).toContain("Tests: 1 failed");
    expect(filtered).not.toContain("PASS src/passing-0.test.ts");
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

  test("keeps tsc continuation lines and locations", () => {
    const raw = "src/a.ts(3,1): error TS2322: Type 'x'\nsome banner\nsrc/b.ts(9,2): error TS1005: ';' expected";
    const filtered = filterOutput("tsc", raw);
    expect(filtered).toContain("TS2322");
    expect(filtered).toContain("TS1005");
    expect(filtered).toContain("some banner");
  });

  test("prioritizes multiline tsc diagnostics after a long progress row", () => {
    const raw = [
      "progress ".repeat(1500),
      "src/problem.ts(14,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  12 | const expected: number = value;",
      "     |       ^^^^^^^^^^^^^^^^^^^^^^^^^",
      "  13 |",
      "  14 | const actual = expected;",
      "     |               ~~~~~~~~",
      "some diagnostic continuation",
    ].join("\n");
    const filtered = filterOutput("tsc", raw);
    expect(filtered).not.toContain("progress ".repeat(20));
    expect(filtered).toContain("src/problem.ts(14,3): error TS2322");
    expect(filtered).toContain("expected: number");
    expect(filtered).toContain("const actual = expected");
    expect(filtered).toContain("some diagnostic continuation");
  });

  test("selects multiline test failure context after a long progress row", () => {
    const raw = [
      "progress ".repeat(1500),
      "FAIL src/example.test.ts",
      "  AssertionError: expected 1 to be 2",
      "    Expected: 2",
      "    Received: 1",
      "      at src/example.test.ts:27:9",
      "        continuation detail",
    ].join("\n");
    const filtered = filterOutput("testrunner", raw);
    expect(filtered).not.toContain("progress ".repeat(20));
    expect(filtered).toContain("FAIL src/example.test.ts");
    expect(filtered).toContain("Expected: 2");
    expect(filtered).toContain("continuation detail");
  });

  test("preserves long expected and actual JSON continuations", () => {
    const expected = JSON.stringify({ expected_value: "E".repeat(2200) });
    const actual = JSON.stringify({ actual_value: "A".repeat(2200) });
    const source = `--- stdout ---\nFAIL math.test.ts\nExpected:\n${expected}\nReceived:\n${actual}\n  at math.test.ts:12:3\n\n--- stderr ---\n`;
    const view = presentOutput("testrunner", source, 8000);
    expect(source.length).toBeLessThan(8000);
    expect(view).toEqual({ text: source, truncated: false });
    expect(filterOutput("testrunner", source)).toContain(expected);
    expect(filterOutput("testrunner", source)).toContain(actual);
  });

  test("preserves long TypeScript diagnostic continuations", () => {
    const expected = `Expected value: ${"E".repeat(2200)}`;
    const source = `--- stdout ---\nsrc/math.ts(12,3): error TS2322: Type mismatch\n${expected}\n  12 | const answer: number = value;\n     |       ^^^^^^^^^^^^^^^^^^^^^^^\n\n--- stderr ---\n`;
    const filtered = filterOutput("tsc", source);
    expect(filtered).toContain(expected);
    const view = presentOutput("tsc", source, 8000);
    expect(view).toEqual({ text: source, truncated: false });
  });

  test("reports real filtering and clipping above the presentation budget", () => {
    const diagnostic = `FAIL math.test.ts\nExpected:\n${"E".repeat(10_000)}\nReceived:\n${"A".repeat(10_000)}`;
    const source = `--- stdout ---\n${diagnostic}\n\n--- stderr ---\n`;
    const view = presentOutput("testrunner", source, 8000);
    expect(view.truncated).toBe(true);
    expect(view.text.length).toBeLessThanOrEqual(8000);
    expect(view.text).toContain("FAIL math.test.ts");
    expect(view.text).toContain("showing");
    expect(view.text).not.toBe(source);
  });

  test("preserves pytest expected/actual blocks and stack frames", () => {
    const raw = [
      "============================= FAILURES =============================",
      "________________________ test_math ________________________",
      "tests/test_math.py:14: AssertionError",
      "    assert actual == expected",
      "E   AssertionError: assert 1 == 2",
      "E    +  where 1 = actual",
      "E    +  and   2 = expected",
      "tests/test_math.py:14: AssertionError",
      "=========================== short test summary ===========================",
      "FAILED tests/test_math.py::test_math - AssertionError",
    ].join("\n");
    const filtered = filterOutput("testrunner", raw);
    for (const evidence of ["test_math", "tests/test_math.py:14", "assert actual == expected", "1 == 2", "short test summary"]) {
      expect(filtered).toContain(evidence);
    }
  });

  test("preserves realistic Vitest and Jest failure blocks", () => {
    const vitest = [
      "❯ src/math.test.ts (1 test | 1 failed)",
      "⎯ Failed Tests 1 ⎯",
      "AssertionError: expected 1 to be 2",
      "Expected: 2",
      "Received: 1",
      " ❯ src/math.test.ts:14:3",
      "      12| const actual = 1",
      "      13| expect(actual).toBe(2)",
      "      14|",
    ].join("\n");
    const jest = [
      "FAIL src/math.test.ts",
      "  ● math › returns expected value",
      "    expect(received).toBe(expected)",
      "    Expected: 2",
      "    Received: 1",
      "      at Object.toBe (src/math.test.ts:14:20)",
    ].join("\n");
    const cases: [string, string][] = [
      [vitest, "src/math.test.ts:14:3"],
      [jest, "Object.toBe"],
    ];
    for (const [raw, expected] of cases) {
      const filtered = filterOutput("testrunner", raw);
      expect(filtered).toContain(expected);
      expect(filtered).toContain("Expected: 2");
      expect(filtered).toContain("Received: 1");
    }
  });

  test("keeps stderr evidence when selecting a testrunner failure view", () => {
    const raw = [
      "--- stdout ---",
      "PASS src/healthy.test.ts",
      "FAIL src/failing.test.ts",
      "AssertionError: expected 1 to be 2",
      "--- stderr ---",
      "warning emitted by the test runtime",
      "details needed to interpret the failure",
    ].join("\n");
    const filtered = filterOutput("testrunner", raw);
    expect(filtered).not.toContain("PASS src/healthy.test.ts");
    expect(filtered).toContain("warning emitted by the test runtime");
    expect(filtered).toContain("details needed to interpret the failure");
  });

  test("reserves the bounded failure view for stderr after noisy stdout", () => {
    const progress = "progress ".repeat(1200);
    const diagnostic = [
      "FAIL src/example.test.ts",
      "  AssertionError: expected 1 to be 2",
      "    Expected: 2",
      "    Received: 1",
      "      at src/example.test.ts:27:9",
      "        continuation detail needed to locate the assertion",
    ].join("\n");
    const source = `--- stdout ---\n${progress}\n--- stderr ---\n${diagnostic}`;
    const view = presentOutput("testrunner", source, 8000);
    expect(view.truncated).toBe(true);
    expect(view.text.length).toBeLessThanOrEqual(8000);
    expect(view.text).toContain("showing");
    expect(view.text).toContain("FAIL src/example.test.ts");
    expect(view.text).toContain("Expected: 2");
    expect(view.text).toContain("Received: 1");
    expect(view.text).toContain("continuation detail");
    expect(view.text.indexOf("FAIL src/example.test.ts")).toBeGreaterThan(view.text.indexOf("--- stderr ---"));
  });

  test("passes output through unchanged for an unknown family", () => {
    expect(filterOutput(null, "anything")).toBe("anything");
  });
});

describe("presentOutput completeness", () => {
  test.each([
    ["stdout only", "--- stdout ---\nTests: 1 passed\n"],
    ["stderr only", "--- stderr ---\nwarning: harmless\n"],
    ["both streams", "--- stdout ---\nTests: 1 passed\n\n--- stderr ---\n"],
    ["empty", ""],
  ])("retains complete %s without reporting omissions", (_name, source) => {
    expect(presentOutput("testrunner", source, 8000)).toEqual({ text: source, truncated: false });
  });
});
