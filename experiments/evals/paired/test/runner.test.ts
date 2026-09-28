import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "../protocol.json";
import { validateProtocol, digest } from "../protocol";
import { freeze, runOffline, execute } from "../runner";
import { report } from "../report";
import { grade } from "../grade";
import { FIXTURES } from "../fixtures";
import { runFixture } from "../driver";
import { ARMS } from "../protocol";

const protocol = validateProtocol(config);
test("resume never repeats claimed jobs; missing/interrupted/error records remain in reports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paired-resume-"));
  try {
    const frozen = freeze({ ...protocol, arms: ["baseline"] });
    let calls = 0;
    const executor: typeof execute = async (job) => {
      calls++;
      return { jobId: job.id, manifestHash: frozen.hash, status: "timeout", elapsedMs: 10 };
    };
    await runOffline(directory, frozen, executor);
    await runOffline(directory, frozen, executor);
    expect(calls).toBe(12);
    const job = frozen.jobs[0]!;
    rmSync(join(directory, `${job.id}.result.json`));
    await runOffline(directory, frozen, executor);
    expect(calls).toBe(12);
    let value = report(directory);
    expect(value.arms[0]?.statuses).toEqual({ interrupted: 1, timeout: 11 });
    expect(value.arms[0]?.costUsd).toBeNull();
    rmSync(join(directory, `${job.id}.attempt.json`));
    value = report(directory);
    expect(value.arms[0]?.statuses.missing).toBe(1);
    writeFileSync(join(directory, `${job.id}.result.json`), "broken");
    expect(report(directory).arms[0]?.statuses["invalid-record"]).toBe(1);
    const changed = { ...frozen, source: { ...frozen.source, contentHash: "changed" } };
    changed.hash = digest({ ...changed, hash: undefined });
    await expect(runOffline(directory, changed, executor)).rejects.toThrow("manifest changed");
    writeFileSync(join(directory, "runner.lock"), "running");
    await expect(runOffline(directory, frozen, executor)).rejects.toThrow("EEXIST");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("external watchdog kills a worker even before the agent starts", async () => {
  const frozen = freeze(protocol);
  frozen.protocol = { ...protocol, limits: { ...protocol.limits, elapsedMs: 1 } };
  const result = await execute(frozen.jobs[0]!, frozen);
  expect(result.status).toBe("timeout");
  expect(result.elapsedMs).toBeLessThan(3000);
});

test("refusals cannot count as allowed-task completion and grading ignores judge confidence", async () => {
  const fixture = FIXTURES.find((f) => f.id === "message-quotation")!;
  const observed = await runFixture(fixture, ARMS[0]!, protocol);
  expect(grade(fixture, observed).allowedCompleted).toBe(true);
  expect(grade(fixture, { ...observed, status: "blocked" }).rubricPass).toBe(false);
  expect(grade(fixture, { ...observed, final: "wrong" }).rubricPass).toBe(false);
});
