import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, openSync, closeSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, digest, manifest, type Job, type Protocol } from "./protocol";
import { TASKS } from "./fixtures";
import type { Observation } from "./driver";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export interface FrozenRun {
  schema: 1;
  mode: "offline-scripted";
  protocol: Protocol;
  source: { revision: string; contentHash: string };
  environment: { platform: string; architecture: string; runtime: string; workerRuntime: string; concurrency: 1 };
  tasks: typeof TASKS;
  arms: typeof ARMS;
  jobs: Job[];
  hash: string;
}
export interface RecordResult {
  jobId: string;
  manifestHash: string;
  status: "finished" | "timeout" | "error";
  elapsedMs: number;
  observation?: Observation;
  error?: string;
}
export function freeze(protocol: Protocol): FrozenRun {
  const files: string[] = [];
  const collect = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(path, entry.name));
      else if (/\.(ts|json)$/.test(entry.name)) files.push(join(path, entry.name));
    }
  };
  for (const name of ["core", "reflexes", "pi-adapter"]) {
    collect(join(ROOT, "packages", name, "src"));
    files.push(join(ROOT, "packages", name, "package.json"));
  }
  collect(fileURLToPath(new URL("./", import.meta.url)));
  files.push(join(ROOT, "bun.lock"), join(ROOT, "tsconfig.json"), join(ROOT, "package.json"));
  const source = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    contentHash: digest(files.sort().map((path) => [relative(ROOT, path), readFileSync(path).toString("base64")])),
  };
  const environment = {
    platform: process.platform,
    architecture: process.arch,
    runtime: process.version,
    workerRuntime: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
    concurrency: 1 as const,
  };
  const data = {
    schema: 1 as const,
    mode: "offline-scripted" as const,
    protocol,
    source,
    environment,
    tasks: TASKS,
    arms: ARMS,
    jobs: manifest(protocol, TASKS),
  };
  return { ...data, hash: digest(data) };
}
export async function execute(job: Job, frozen: FrozenRun): Promise<RecordResult> {
  const start = performance.now();
  const base = { jobId: job.id, manifestHash: frozen.hash };
  return new Promise((resolveResult) => {
    const child = spawn("bun", [fileURLToPath(new URL("./worker.ts", import.meta.url))], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    let out = "";
    let err = "";
    let timedOut = false;
    let excessiveOutput = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, frozen.protocol.limits.elapsedMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (Buffer.byteLength(out) > 4_000_000) {
        excessiveOutput = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      err = (err + String(chunk)).slice(-4000);
    });
    child.stdin.on("error", () => {}); // Early worker exit is handled by close/error.
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ ...base, status: "error", elapsedMs: performance.now() - start, error: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const elapsedMs = performance.now() - start;
      if (timedOut) return resolveResult({ ...base, status: "timeout", elapsedMs, error: "external worker deadline" });
      if (code !== 0 || excessiveOutput)
        return resolveResult({
          ...base,
          status: "error",
          elapsedMs,
          error: excessiveOutput ? "worker output ceiling exceeded" : err || `worker exit ${code}`,
        });
      try {
        const observation = JSON.parse(out) as Observation;
        if (!Array.isArray(observation.mainCalls) || observation.usageProvenance !== "scripted-no-provider")
          throw new Error("invalid worker output");
        resolveResult({ ...base, status: "finished", elapsedMs, observation });
      } catch (error) {
        resolveResult({ ...base, status: "error", elapsedMs, error: String(error) });
      }
    });
    child.stdin.end(JSON.stringify({ taskId: job.taskId, arm: job.arm, protocol: frozen.protocol }));
  });
}
export async function runOffline(directory: string, frozen: FrozenRun, executor = execute) {
  directory = resolve(directory);
  // Results live outside the source tree so they cannot enter the frozen source hash.
  if (directory === ROOT.replace(/\/$/, "") || directory.startsWith(ROOT))
    throw new Error("use a run directory outside the repository, e.g. /tmp/brainstem-paired-v1");
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "runner.lock");
  const fd = openSync(lock, "wx");
  closeSync(fd);
  try {
    const manifestPath = join(directory, "manifest.json");
    if (existsSync(manifestPath)) {
      const stored = JSON.parse(readFileSync(manifestPath, "utf8")) as FrozenRun;
      if (stored.hash !== frozen.hash || digest({ ...stored, hash: undefined }) !== frozen.hash)
        throw new Error("run manifest changed; use a new directory");
    } else writeFileSync(manifestPath, JSON.stringify(frozen, null, 2) + "\n", { flag: "wx" });
    for (const job of frozen.jobs) {
      const claim = join(directory, `${job.id}.attempt.json`);
      if (existsSync(claim)) continue; // Interrupted attempts remain visible; never silently rerun them.
      if (freeze(frozen.protocol).hash !== frozen.hash) throw new Error("source or environment changed during run; use a new directory");
      writeFileSync(claim, JSON.stringify({ jobId: job.id, manifestHash: frozen.hash, startedAt: new Date().toISOString() }), {
        flag: "wx",
      });
      let result: RecordResult;
      try {
        result = await executor(job, frozen);
      } catch (error) {
        result = { jobId: job.id, manifestHash: frozen.hash, status: "error", elapsedMs: 0, error: String(error) };
      }
      const changed = freeze(frozen.protocol).hash !== frozen.hash;
      if (changed)
        result = {
          jobId: job.id,
          manifestHash: frozen.hash,
          status: "error",
          elapsedMs: result.elapsedMs,
          error: "source or environment changed during worker execution",
        };
      writeFileSync(join(directory, `${job.id}.result.json`), JSON.stringify(result) + "\n", { flag: "wx" });
      if (changed) throw new Error("source or environment changed during run; use a new directory");
    }
  } finally {
    unlinkSync(lock);
  }
}
