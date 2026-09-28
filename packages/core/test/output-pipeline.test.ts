import { expect, test } from "vitest";
import { processOutput, createBitmap, setBit, type CapturedOutput, type OutputPipelineDeps } from "../src";
const capture = (text: string): CapturedOutput => ({
  kind: "captured",
  sourceId: "log",
  stream: "stdout",
  text,
  completeness: "complete",
  recovery: { sessionId: "s", sourceId: "log", instructions: "use read_output" },
});
const deps: OutputPipelineDeps = {
  async focus(input) {
    const selected = createBitmap(input.manifest.catalogHash, input.manifest.entries.length);
    setBit(selected, input.manifest.entries.length - 1);
    return {
      sectionManifestHash: input.manifest.catalogHash,
      selected,
      evaluated: selected,
      mode: "select",
      reasons: [],
      scores: {},
      sectionReasons: {},
      status: "ok",
      batches: 1,
    };
  },
  async observe() {
    return { sanitize: { action: "pass", reasons: [] }, verify: { action: "ok", verified: true, reasons: [] } };
  },
};

test("selected Unicode evidence carries source ranges and the exact presented view is reviewed", async () => {
  const source = capture(`${"noise ".repeat(200)}\n\nFAIL: café 😀`);
  let seen = "";
  const result = await processOutput(
    { capture: source, task: "failure", action: "test", status: "error", focus: "active" },
    {
      ...deps,
      observe: async (i) => {
        seen = i.content;
        return deps.observe(i);
      },
    },
  );
  expect(seen).toBe("FAIL: café 😀");
  expect(result.presented.text).toBe(seen);
  const range = result.presented.ranges[0]!;
  expect(Buffer.from(source.text).subarray(range.start, range.end).toString()).toBe(seen);
  expect(result.text).toContain("use read_output");
  expect(result.presented.omitted).toBe(true);
});

test("long line bounds review; incomplete capture and unsupported parts stay explicit", async () => {
  let seen = "";
  const result = await processOutput(
    {
      capture: { ...capture("x".repeat(10_000)), completeness: "limited", recovery: undefined },
      task: "t",
      action: "read",
      status: "ok",
      nonTextCount: 1,
    },
    {
      ...deps,
      observe: async (i) => {
        seen = i.content;
        expect(i.truncated).toBe(true);
        return deps.observe(i);
      },
    },
  );
  expect(seen.length).toBe(8000);
  expect(result.text).toContain("no recovery");
  expect(result.text).toContain("source capture limited");
  expect(result.text).toContain("non-text");
});

test("shadow decisions do not select, block, or annotate a complete benign-sized source", async () => {
  const result = await processOutput(
    { capture: capture("hello"), task: "t", action: "read", status: "ok", focus: "shadow", sanitize: "shadow", verify: "shadow" },
    {
      ...deps,
      observe: async () => ({
        sanitize: { action: "block", reasons: ["bad"] },
        verify: { action: "mismatch", reasons: ["bad"], verified: true },
      }),
    },
  );
  expect(result.text).toBe("hello");
});

test("selected combined output maps back to the named stderr stream", async () => {
  const stdout = "noise\n\n";
  const stderr = "FAIL 😀";
  const source = {
    ...capture(stdout + stderr),
    segments: [
      { stream: "stdout", start: 0, end: Buffer.byteLength(stdout), sourceStart: 0 },
      { stream: "stderr", start: Buffer.byteLength(stdout), end: Buffer.byteLength(stdout + stderr), sourceStart: 0 },
    ],
  };
  const result = await processOutput({ capture: source, task: "error", action: "test", status: "error", focus: "active" }, deps);
  expect(result.presented.ranges).toEqual([
    { sourceId: "log", stream: "stderr", unit: "utf8-byte", start: 0, end: Buffer.byteLength(stderr) },
  ]);
  expect(Object.isFrozen(result.presented)).toBe(true);
});
