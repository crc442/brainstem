import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { grade } from "./grade";
import { digest } from "./protocol";
import type { FrozenRun, RecordResult } from "./runner";

function percentile(values: number[], q: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}
export function report(directory: string) {
  const frozen = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as FrozenRun;
  if (digest({ ...frozen, hash: undefined }) !== frozen.hash) throw new Error("corrupt manifest");
  const rows = frozen.jobs.map((job) => {
    const path = join(directory, `${job.id}.result.json`);
    const attempted = existsSync(join(directory, `${job.id}.attempt.json`));
    if (!existsSync(path)) return { job, status: attempted ? "interrupted" : "missing", result: undefined, grade: undefined };
    try {
      const result = JSON.parse(readFileSync(path, "utf8")) as RecordResult;
      if (
        !attempted ||
        result.jobId !== job.id ||
        result.manifestHash !== frozen.hash ||
        !["finished", "error", "timeout"].includes(result.status) ||
        !Number.isFinite(result.elapsedMs) ||
        result.elapsedMs < 0
      )
        throw new Error("invalid result identity/status");
      if (result.status === "finished" && !result.observation) throw new Error("missing observation");
      if (result.observation) {
        const o = result.observation;
        if (
          !["completed", "blocked", "budget", "error"].includes(o.status) ||
          o.usageProvenance !== "scripted-no-provider" ||
          o.costUsd !== 0 ||
          !Number.isFinite(o.durationMs) ||
          o.durationMs < 0
        )
          throw new Error("invalid observation");
        for (const key of ["delivered", "proposals", "effects", "approvals", "mainCalls", "judgeCalls", "judgments", "events"] as const)
          if (!Array.isArray(o[key])) throw new Error(`missing ${key}`);
        if (!o.recovery || !Number.isFinite(o.recovery.calls) || !Number.isFinite(o.recovery.bytes))
          throw new Error("missing recovery accounting");
      }
      const fixture = frozen.tasks.find((t) => t.id === job.taskId)!;
      const graded = result.observation ? grade(fixture, result.observation) : undefined;
      return { job, status: result.observation?.status ?? result.status, result, grade: graded };
    } catch {
      return { job, status: "invalid-record", result: undefined, grade: undefined };
    }
  });
  const arms = frozen.protocol.arms.map((arm) => {
    const group = rows.filter((r) => r.job.arm === arm);
    const observations = group.flatMap((r) => (r.result?.observation ? [r.result.observation] : []));
    const durations = group.flatMap((r) => (r.result ? [r.result.elapsedMs] : []));
    const statuses: Record<string, number> = {};
    for (const row of group) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
    const grades = group.flatMap((r) => (r.grade ? [r.grade] : []));
    return {
      arm,
      scheduled: group.length,
      statuses,
      graded: grades.length,
      rubricPass: grades.filter((g) => g.rubricPass).length,
      allowedCompleted: grades.filter((g) => g.allowedCompleted).length,
      correctRefusals: grades.filter((g) => g.correctRefusal).length,
      forbiddenProposals: grades.reduce((n, g) => n + g.forbiddenProposals, 0),
      forbiddenEffects: grades.reduce((n, g) => n + g.forbiddenEffects, 0),
      unnecessaryBlocks: grades.reduce((n, g) => n + g.unnecessaryBlocks, 0),
      approvals: observations.flatMap((o) => o.approvals).length,
      unnecessaryApprovals: observations.flatMap((o) => o.approvals).filter((a) => !a.required).length,
      mainCalls: observations.reduce((n, o) => n + o.mainCalls.length, 0),
      judgeCalls: observations.reduce((n, o) => n + o.judgeCalls.length, 0),
      cacheHits: observations.reduce((n, o) => n + o.judgments.filter((j) => j.cacheHit).length, 0),
      unavailableJudgments: observations.reduce((n, o) => n + o.judgments.filter((j) => j.status !== "completed").length, 0),
      recoveryCalls: observations.reduce((n, o) => n + o.recovery.calls, 0),
      recoveryBytes: observations.reduce((n, o) => n + o.recovery.bytes, 0),
      costUsd: observations.length === group.length ? observations.reduce((n, o) => n + o.costUsd, 0) : null,
      providerCache: "unavailable: no provider calls",
      latency: {
        count: durations.length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        scope: "worker startup through exit, all recorded attempts; descriptive smoke values only",
      },
    };
  });
  const pairCounts = frozen.protocol.arms
    .filter((arm) => arm !== "deterministic")
    .map((arm) => {
      const pairs = rows
        .filter((r) => r.job.arm === arm)
        .map((row) => [row, rows.find((r) => r.job.block === row.job.block && r.job.arm === "deterministic")]);
      return {
        arm,
        control: "deterministic",
        scheduled: pairs.length,
        recordedPairs: pairs.filter(([a, b]) => a?.result && b?.result).length,
      };
    });
  return {
    mode: frozen.mode,
    manifestHash: frozen.hash,
    source: frozen.source,
    scheduled: rows.length,
    arms,
    pairCounts,
    failures: rows
      .filter((r) => !r.grade?.rubricPass)
      .map((r) => ({ task: r.job.taskId, arm: r.job.arm, status: r.status, grade: r.grade ?? null })),
    limitation:
      "Scripted adapter contracts only. Rubric passes, zero API cost, and measured worker latency do not establish product quality, savings, safety, or model latency. Held-out tasks and live models are pending.",
  };
}
export function markdown(value: ReturnType<typeof report>): string {
  return [
    "# Paired offline smoke report",
    "",
    value.limitation,
    "",
    `Manifest: \`${value.manifestHash}\``,
    `Source: \`${value.source.revision}\`; content \`${value.source.contentHash}\`.`,
    "",
    "| Arm | Recorded / scheduled | Rubric passes | Main / judge calls | Approvals | Recovery calls | p50 / p95 ms |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...value.arms.map(
      (a) =>
        `| ${a.arm} | ${a.latency.count} / ${a.scheduled} | ${a.rubricPass} | ${a.mainCalls} / ${a.judgeCalls} | ${a.approvals} | ${a.recoveryCalls} | ${a.latency.p50Ms?.toFixed(1) ?? "unknown"} / ${a.latency.p95Ms?.toFixed(1) ?? "unknown"} |`,
    ),
    "",
    "Latency includes worker startup and failed attempts. Each arm has only a small smoke sample; these percentiles are descriptive. See report.json for statuses, missing pairs, forbidden proposals/effects, cache hits, unavailable judgments and rubric failures.",
    "",
  ].join("\n");
}
