import { createHash } from "node:crypto";
import type { ReflexModes } from "@brainstem/core";

export const FLOWS = ["select", "focus", "messageGate", "gate", "sanitize", "verify", "pulse", "steer"] as const;
export const OFF: ReflexModes = Object.fromEntries(FLOWS.map((flow) => [flow, "off"]));
export const ARMS = [
  { id: "baseline", plugin: false, modes: { ...OFF } },
  { id: "deterministic", plugin: true, modes: { ...OFF } },
  ...FLOWS.map((flow) => ({ id: flow, plugin: true, modes: { ...OFF, [flow]: "active" as const } })),
  { id: "full", plugin: true, modes: Object.fromEntries(FLOWS.map((flow) => [flow, "active"])) as ReflexModes },
];
export type Arm = typeof ARMS[number];
export interface Protocol {
  schema: 1;
  id: string;
  phase: "development" | "held-out";
  seed: number;
  repeats: number;
  arms: string[];
  models: { primary: string | null; mini: string | null; judge: string | null };
  pricesUsdPerMillion: { primary: number | null; mini: number | null; judge: number | null };
  limits: { mainCalls: number; judgeCalls: number; requestBytes: number; outputTokens: number; elapsedMs: number; perRunUsd: number; studyUsd: number };
  cache: { local: "empty-per-run"; provider: "observed" };
  approvalDelayMs: number;
  decisionRules: { completionMargin: number; maximumFalseBlockIncrease: number; targetCostReduction: number; targetLatencyReduction: number };
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function validateProtocol(value: unknown): Protocol {
  const p = value as Protocol;
  if (!p || p.schema !== 1 || typeof p.id !== "string" || !p.id || !["development", "held-out"].includes(p.phase)) throw new Error("invalid protocol identity");
  if (!Number.isInteger(p.seed) || !Number.isInteger(p.repeats) || p.repeats < 1) throw new Error("invalid seed/repeats");
  if (!Array.isArray(p.arms) || !p.arms.length || new Set(p.arms).size !== p.arms.length || p.arms.some((id) => !ARMS.some((a) => a.id === id))) throw new Error("unknown or duplicate arms");
  for (const field of ["mainCalls", "judgeCalls", "requestBytes", "outputTokens", "elapsedMs"] as const) {
    if (!Number.isSafeInteger(p.limits?.[field]) || p.limits[field] <= 0) throw new Error(`invalid limit ${field}`);
  }
  for (const field of ["perRunUsd", "studyUsd"] as const) if (!Number.isFinite(p.limits?.[field]) || p.limits[field] <= 0) throw new Error(`invalid limit ${field}`);
  if (!p.models || !p.pricesUsdPerMillion) throw new Error("models/prices required");
  for (const key of ["primary", "mini", "judge"] as const) {
    if (p.models[key] !== null && (typeof p.models[key] !== "string" || !p.models[key]!.trim())) throw new Error(`invalid model ${key}`);
    if (p.pricesUsdPerMillion[key] !== null && (!Number.isFinite(p.pricesUsdPerMillion[key]) || p.pricesUsdPerMillion[key]! <= 0)) throw new Error(`invalid price ${key}`);
  }
  if (p.cache?.local !== "empty-per-run" || p.cache.provider !== "observed") throw new Error("unsupported cache protocol");
  if (!Number.isFinite(p.approvalDelayMs) || p.approvalDelayMs < 0) throw new Error("invalid approval delay");
  for (const key of ["completionMargin", "maximumFalseBlockIncrease", "targetCostReduction", "targetLatencyReduction"] as const) {
    const n = p.decisionRules?.[key];
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`invalid decision rule ${key}`);
  }
  if (Object.keys(p.decisionRules ?? {}).length !== 4) throw new Error("decision rules required");
  return p;
}
export interface Job { id: string; block: string; taskId: string; snapshotHash: string; arm: string; repetition: number }
export function manifest(protocol: Protocol, tasks: { id: string; snapshotHash: string; split: string }[]): Job[] {
  validateProtocol(protocol);
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new Error("duplicate task IDs");
  const selected = tasks.filter((t) => t.split === protocol.phase);
  if (!selected.length) throw new Error(`no ${protocol.phase} tasks; do not relabel development data as held-out`);
  let random = protocol.seed >>> 0 || 1;
  const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; };
  const arms = [...protocol.arms];
  for (let i = arms.length - 1; i > 0; i--) { const j = next() % (i + 1); [arms[i], arms[j]] = [arms[j]!, arms[i]!]; }
  const jobs: Job[] = [];
  let index = 0;
  for (const task of selected) for (let repetition = 0; repetition < protocol.repeats; repetition++) {
    const block = digest([task.id, task.snapshotHash, protocol.models, repetition]);
    // Counterbalanced order, with a seeded starting permutation.
    for (let a = 0; a < arms.length; a++) {
      const arm = arms[(a + index) % arms.length]!;
      jobs.push({ id: digest([digest(protocol), block, arm]), block, taskId: task.id, snapshotHash: task.snapshotHash, arm, repetition });
    }
    index++;
  }
  return jobs;
}
export function liveReadiness(protocol: Protocol, jobs: Job[]) {
  const blockers: string[] = [];
  for (const key of ["primary", "mini", "judge"] as const) {
    if (!protocol.models[key]) blockers.push(`${key} model not selected`);
    if (!protocol.pricesUsdPerMillion[key]) blockers.push(`${key} all-inclusive price bound not supplied`);
  }
  // Planning estimate only. Provider tokenization, hidden/reasoning tokens, cache
  // charges and transport retries need verified bounds before any paid runner.
  const tokens = protocol.limits.requestBytes + protocol.limits.outputTokens;
  const primary = Math.max(protocol.pricesUsdPerMillion.primary ?? 0, protocol.pricesUsdPerMillion.mini ?? 0);
  const requestBound = blockers.length ? null : tokens / 1e6 * (primary * protocol.limits.mainCalls + protocol.pricesUsdPerMillion.judge! * protocol.limits.judgeCalls);
  if (requestBound !== null && requestBound > protocol.limits.perRunUsd) blockers.push("request bounds exceed per-run spend ceiling");
  const studyBound = requestBound === null ? null : requestBound * jobs.length;
  if (studyBound !== null && studyBound > protocol.limits.studyUsd) blockers.push("job matrix exceeds study ceiling");
  blockers.push("live execution is not implemented; provider billing bounds and a frozen paid-run protocol still need review");
  return { blockers, estimatedPerRunUsd: requestBound, estimatedStudyUsd: studyBound, configuredCeilingUsd: protocol.limits.studyUsd };
}
