import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../protocol.json";
import { digest, validateProtocol } from "../protocol";
import { freeze, ROOT } from "../runner";
import { LIVE, SYSTEM, CODING_TASKS, maximumRunCost } from "./protocol";
import type { CallRecord } from "./transport";
import type { runLiveTask } from "./driver";

type Outcome = Awaited<ReturnType<typeof runLiveTask>>;
function frozenStudy() {
  const source = freeze(validateProtocol(config));
  const jobs = CODING_TASKS.flatMap((task, i) =>
    LIVE.arms.map((_, a) => ({
      taskId: task.id,
      arm: LIVE.arms[(a + i + (LIVE.seed % LIVE.arms.length)) % LIVE.arms.length]!,
      snapshotHash: digest(task),
    })),
  );
  const maximumStudyUsd = jobs.length * maximumRunCost() + LIVE.priorStudyCostUpperUsd;
  if (maximumRunCost() > LIVE.limits.perRunUsd || maximumStudyUsd > LIVE.limits.studyUsd)
    throw new Error("frozen matrix exceeds spending ceiling");
  const data = {
    mode: "live-development",
    protocol: LIVE,
    prompt: SYSTEM,
    tasks: CODING_TASKS,
    source: source.source,
    environment: source.environment,
    maximumStudyUsd,
    jobs,
  };
  return { ...data, hash: digest(data) };
}
function latestCalls(path: string): CallRecord[] {
  if (!existsSync(path)) return [];
  const byId = new Map<string, CallRecord>();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try {
      const call = JSON.parse(line);
      // Earlier pilot ledgers used 0 to mean Jev had no separate cache rate.
      // Normalize that accounting convention to unknown cache behavior.
      if (call.kind === "judge") call.cachedTokens = null;
      byId.set(call.id, call);
    } catch {
      throw new Error("corrupt call ledger; do not infer zero cost");
    }
  }
  return [...byId.values()];
}
function makeReport(directory: string) {
  const study = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as ReturnType<typeof frozenStudy>;
  if (digest({ ...study, hash: undefined }) !== study.hash) throw new Error("manifest hash mismatch");
  const invalidation = existsSync(join(directory, "invalidation.json"))
    ? JSON.parse(readFileSync(join(directory, "invalidation.json"), "utf8"))
    : null;
  const rows = study.jobs.map((job) => {
    const id = `${job.taskId}--${job.arm}`;
    const path = join(directory, `${id}.result.json`);
    const result = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as {
          status: string;
          durationMs: number;
          outcome?: Outcome;
          error?: string;
          manifestHash: string;
        })
      : undefined;
    if (result && result.manifestHash !== study.hash) throw new Error("result belongs to a different manifest");
    const calls = latestCalls(join(directory, `${id}.calls.jsonl`));
    return {
      ...job,
      status: result?.outcome?.status ?? result?.status ?? (existsSync(join(directory, `${id}.attempt.json`)) ? "interrupted" : "missing"),
      completed: result?.outcome?.completed ?? false,
      result,
      calls,
      costKnownUsd: calls.reduce((n, c) => n + (c.measuredCostUsd ?? 0), 0),
      costUnknownCalls: calls.filter((c) => c.measuredCostUsd === undefined || c.measuredCostUsd === null).length,
      costUpperUsd: calls.reduce((n, c) => n + (c.uncachedCostUpperUsd ?? c.reservedUsd), 0),
    };
  });
  const summary = study.protocol.arms.map((arm) => {
    const group = rows.filter((r) => r.arm === arm);
    const durations = group.flatMap((r) => (r.result ? [r.result.durationMs] : [])).sort((a, b) => a - b);
    const count = (fn: (r: (typeof rows)[number]) => number) => group.reduce((n, r) => n + fn(r), 0);
    const completed = count((r) => Number(r.completed));
    const unknownCalls = count((r) => r.costUnknownCalls);
    const recorded = group.filter((r) => r.result).length;
    const costUpperUsd = count((r) => r.costUpperUsd);
    return {
      arm,
      scheduled: group.length,
      recorded,
      completed,
      statuses: Object.fromEntries(
        [...new Set(group.map((r) => r.status))].map((status) => [status, group.filter((r) => r.status === status).length]),
      ),
      forbiddenProposals: count((r) => r.result?.outcome?.forbiddenProposals ?? 0),
      forbiddenEffects: count((r) => r.result?.outcome?.forbiddenEffects ?? 0),
      approvals: count((r) => r.result?.outcome?.approvals.length ?? 0),
      recoveryCalls: count((r) => r.result?.outcome?.recoveryCalls ?? 0),
      mainCalls: count((r) => r.calls.filter((c) => c.kind === "main").length),
      judgeCalls: count((r) => r.calls.filter((c) => c.kind === "judge").length),
      localCacheHits: count((r) => r.result?.outcome?.judgments.filter((j) => j.cacheHit).length ?? 0),
      unavailableJudgments: count((r) => r.result?.outcome?.judgments.filter((j) => j.status !== "completed").length ?? 0),
      providerCacheReadTokens: count((r) => r.calls.reduce((n, c) => n + (c.cachedTokens ?? 0), 0)),
      unknownProviderCacheCalls: count((r) => r.calls.filter((c) => c.cachedTokens == null).length),
      knownCostUsd: count((r) => r.costKnownUsd),
      unknownCostCalls: unknownCalls,
      totalCostUsd: unknownCalls || recorded !== group.length ? null : count((r) => r.costKnownUsd),
      costUpperUsd,
      costPerCompletedUpperUsd: completed && recorded === group.length ? costUpperUsd / completed : null,
      latency: {
        count: durations.length,
        p50Ms: durations[Math.ceil(durations.length * 0.5) - 1] ?? null,
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1] ?? null,
      },
    };
  });
  return {
    manifestHash: study.hash,
    source: study.source,
    maximumStudyUsd: study.maximumStudyUsd,
    invalidation,
    summary,
    rows,
    conclusion: invalidation
      ? `INVALID STUDY: ${invalidation.reason}`
      : "Development pilot on four configuration tasks. Too small and narrow for efficacy, safety or tail-latency claims. Individual reflex ablations, representative code edits, independently adjudicated labels and held-out validation remain.",
  };
}

const [command, requestedDirectory] = process.argv.slice(2);
if (command === "dry-run") {
  console.log(JSON.stringify(frozenStudy(), null, 2));
} else if ((command === "run" || command === "report") && requestedDirectory) {
  const directory = resolve(requestedDirectory);
  if (directory === ROOT.replace(/\/$/, "") || directory.startsWith(ROOT)) throw new Error("use a directory outside the repository");
  if (command === "run") {
    if (!process.env.ZAI_API_KEY || !process.env.TYPESAFE_API_KEY) throw new Error("both provider credentials required");
    const study = frozenStudy();
    mkdirSync(directory, { recursive: true });
    const lock = join(directory, "runner.lock");
    closeSync(openSync(lock, "wx"));
    try {
      const path = join(directory, "manifest.json");
      if (existsSync(path)) {
        const previous = JSON.parse(readFileSync(path, "utf8"));
        if (previous.hash !== study.hash || digest({ ...previous, hash: undefined }) !== study.hash)
          throw new Error("manifest changed; don't reuse this run directory");
      } else writeFileSync(path, JSON.stringify(study, null, 2), { flag: "wx" });
      for (const job of study.jobs) {
        const id = `${job.taskId}--${job.arm}`;
        const claim = join(directory, `${id}.attempt.json`);
        if (existsSync(claim)) continue;
        if (frozenStudy().hash !== study.hash) throw new Error("source changed; stop the study");
        writeFileSync(
          claim,
          JSON.stringify({ ...job, manifestHash: study.hash, reservedUsd: maximumRunCost(), startedAt: new Date().toISOString() }),
          { flag: "wx" },
        );
        const started = performance.now();
        const result = await new Promise<{ status: string; outcome?: Outcome; error?: string }>((resolveResult) => {
          const child = spawn("bun", [fileURLToPath(new URL("./worker.ts", import.meta.url))], {
            cwd: ROOT,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH,
              TMPDIR: process.env.TMPDIR,
              ZAI_API_KEY: process.env.ZAI_API_KEY,
              TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
            },
          });
          let output = "";
          let stderr = "";
          let timeout = false;
          let overflow = false;
          const timer = setTimeout(() => {
            timeout = true;
            child.kill("SIGKILL");
          }, LIVE.limits.elapsedMs);
          child.stdout.on("data", (chunk) => {
            output += String(chunk);
            if (Buffer.byteLength(output) > 4_000_000) {
              overflow = true;
              child.kill("SIGKILL");
            }
          });
          child.stderr.on("data", (chunk) => {
            stderr = (stderr + String(chunk)).slice(-1000);
          });
          child.stdin.on("error", () => {});
          child.on("error", (error) => {
            clearTimeout(timer);
            resolveResult({ status: "error", error: String(error) });
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (timeout || overflow || code !== 0)
              return resolveResult({
                status: timeout ? "timeout" : "error",
                error: overflow ? "worker output bound" : stderr || `exit ${code}`,
              });
            try {
              resolveResult({ status: "finished", outcome: JSON.parse(output) });
            } catch (e) {
              resolveResult({ status: "error", error: String(e) });
            }
          });
          child.stdin.end(JSON.stringify({ ...job, journalPath: join(directory, `${id}.calls.jsonl`) }));
        });
        const changed = frozenStudy().hash !== study.hash;
        const persisted = {
          ...(changed ? { status: "error", error: "source changed during execution" } : result),
          manifestHash: study.hash,
          durationMs: performance.now() - started,
        };
        writeFileSync(join(directory, `${id}.result.json`), JSON.stringify(persisted), { flag: "wx" });
        console.log(
          JSON.stringify({
            id,
            status: result.outcome?.status ?? result.status,
            completed: result.outcome?.completed ?? false,
            calls: latestCalls(join(directory, `${id}.calls.jsonl`)).length,
          }),
        );
        if (changed) throw new Error("source changed; run stopped");
        // Registered infrastructure rule: stop the entire matrix after a provider
        // error, retaining every attempted and unattempted job. Never rerun losers.
        if (latestCalls(join(directory, `${id}.calls.jsonl`)).some((c) => c.status !== "completed")) {
          console.log("Stopping matrix after provider error/unknown billing; remaining jobs stay missing.");
          break;
        }
      }
    } finally {
      unlinkSync(lock);
    }
  }
  const report = makeReport(directory);
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        manifestHash: report.manifestHash,
        maximumStudyUsd: report.maximumStudyUsd,
        summary: report.summary,
        conclusion: report.conclusion,
      },
      null,
      2,
    ),
  );
} else throw new Error("usage: live/cli.ts dry-run | run <outside-repo-directory> | report <directory>");
