import {
  compileCatalog, workingSetFromIds, computeActive, activeIds, fromIds, hashAction, newId, boundForReview,
  type CapabilityDescriptor, type AskOptions, type GateInput, type GateDecision, type MessageGateInput,
  type SteerInput, type SteerDecision, type PulseDecision,
} from "@brainstem/core";
import type { Reflexes, PulseInput } from "./index";

export type ReflexMode = "off" | "shadow" | "active";
export type PluginFlow = "select" | "focus" | "messageGate" | "gate" | "sanitize" | "verify" | "pulse" | "steer";
export type PluginModes = Partial<Record<PluginFlow, ReflexMode>>;
export interface PluginEvent {
  sessionId: string;
  revision: number;
  flow: PluginFlow;
  mode: ReflexMode;
  phase: "judged" | "applied";
  outcome: string;
  durationMs?: number;
  subjectId?: string;
}
export interface CapabilityContext {
  catalog: CapabilityDescriptor[];
  available: string[];
  baseline: string[];
  explicit?: string[];
  current?: string[];
}
export interface CapabilityRecommendation {
  catalogHash: string;
  ids: string[];
  missingExplicit: string[];
  status: "ok" | "partial" | "unavailable";
  reasons: Record<string, unknown>;
}
export interface GateReview {
  subjectId: string;
  revision: number;
  subject: Readonly<GateInput | MessageGateInput>;
  decision: GateDecision;
}
export interface PluginSessionOptions {
  modes?: PluginModes;
  /** Active gates may advise without blocking when explicitly configured. */
  gateBehavior?: "enforce" | "advisory";
  approve?: (review: GateReview, signal: AbortSignal) => Promise<boolean>;
  onEvent?: (event: PluginEvent) => void;
  signal?: AbortSignal;
}

/** A host-owned wait remains cancellable locally; it cannot imply a remote approval was revoked. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("plugin operation cancelled");
  let abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(new Error("plugin operation cancelled"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

export function createPluginSession(reflexes: Reflexes, options: PluginSessionOptions = {}) {
  const sessionId = newId("plugin");
  let revision = 0;
  let taskId: string | undefined;
  let task = "unspecified";
  let disposed = false;
  let controller = new AbortController();
  const modes: Record<PluginFlow, ReflexMode> = {
    select: "off", focus: "off", messageGate: "off", gate: "active", sanitize: "active", verify: "active", pulse: "off", steer: "off", ...options.modes,
  };
  const event = (flow: PluginFlow, phase: PluginEvent["phase"], outcome: string, durationMs?: number, subjectId?: string, atRevision = revision) =>
    options.onEvent?.({ sessionId, revision: atRevision, flow, mode: modes[flow], phase, outcome, durationMs, subjectId });
  const scope = (signal?: AbortSignal) => {
    if (disposed) throw new Error("plugin session disposed");
    const signals = [controller.signal, options.signal, signal].filter((s): s is AbortSignal => !!s);
    const combined = AbortSignal.any(signals);
    const atRevision = revision;
    return { signal: combined, revision: atRevision, current: () => !disposed && revision === atRevision && !combined.aborted };
  };
  async function judge<T>(flow: PluginFlow, run: (opts: AskOptions) => Promise<T>, signal?: AbortSignal) {
    const s = scope(signal);
    if (!s.current()) throw new Error("plugin operation cancelled");
    const start = performance.now();
    const result = await run({ signal: s.signal });
    if (!s.current()) throw new Error("stale plugin result");
    event(flow, "judged", "completed", performance.now() - start, undefined, s.revision);
    return result;
  }
  async function gate(flow: "gate" | "messageGate", input: GateInput | MessageGateInput, signal?: AbortSignal) {
    const s = scope(signal);
    const snapshot = structuredClone(input);
    const subjectId = hashAction(snapshot);
    if (modes[flow] === "off") return { allowed: s.current(), decision: undefined, subjectId };
    const decision = await judge(flow, (opts) => flow === "gate" ? reflexes.gate(snapshot as GateInput, opts) : reflexes.messageGate(snapshot as MessageGateInput, opts), s.signal);
    let allowed = true;
    if (modes[flow] === "active" && options.gateBehavior !== "advisory") {
      allowed = decision.action === "auto";
      if (decision.action === "ask" && options.approve) {
        // Callback receives a separate copy; its mutations cannot change the reviewed subject.
        allowed = await abortable(Promise.resolve(options.approve({ subjectId, revision: s.revision, subject: structuredClone(snapshot), decision: structuredClone(decision) }, s.signal)), s.signal);
      }
    }
    if (!s.current() || hashAction(input) !== subjectId) allowed = false;
    event(flow, "applied", modes[flow] === "shadow" ? "shadow" : options.gateBehavior === "advisory" ? "advisory" : allowed ? "allow" : "block", undefined, subjectId, s.revision);
    return { allowed, decision, subjectId };
  }
  return {
    sessionId, modes,
    get revision() { return revision; },
    get task() { return task; },
    scope,
    async prepareMessage(input: MessageGateInput & { taskId: string; capabilities?: CapabilityContext }, signal?: AbortSignal) {
      if (disposed) throw new Error("plugin session disposed");
      controller.abort(); controller = new AbortController(); revision++;
      if (taskId !== input.taskId) { reflexes.resetTask(); taskId = input.taskId; }
      task = input.task;
      const s = scope(signal);
      const messageSubject = { message: input.message, task: input.task, constraints: [...input.constraints], evidence: structuredClone(input.evidence) };
      const originalHash = hashAction(input);
      const reviewed = await gate("messageGate", messageSubject, s.signal);
      let recommendation: CapabilityRecommendation | undefined;
      if (reviewed.allowed && input.capabilities && modes.select !== "off") {
        const capabilities = structuredClone(input.capabilities);
        const catalog = compileCatalog(capabilities.catalog);
        const known = new Set(catalog.entries.map((c) => c.id));
        const unknownExplicit = (capabilities.explicit ?? []).filter((id) => !known.has(id));
        const working = workingSetFromIds(catalog, {
          available: capabilities.available.filter((id) => known.has(id)),
          baseline: [...new Set([...capabilities.baseline, ...catalog.entries.filter((d) => d.alwaysAvailable).map((d) => d.id)])].filter((id) => known.has(id)),
          explicit: (capabilities.explicit ?? []).filter((id) => known.has(id)),
        });
        const decision = await judge("select", (opts) => reflexes.select({
          task: `${input.task}\nIncoming user message: ${input.message}`, recent: [], catalog, ...working,
          current: fromIds((capabilities.current ?? []).filter((id) => known.has(id)), catalog.entries, catalog.catalogHash),
        }, opts), s.signal);
        const active = computeActive(catalog, { ...working, evaluated: decision.evaluated, recommended: decision.recommended });
        recommendation = { catalogHash: catalog.catalogHash, ids: activeIds(catalog, active), missingExplicit: [...unknownExplicit, ...active.unmetExplicit], status: decision.status, reasons: decision.reasons };
        if (modes.select !== "active") recommendation = undefined;
      }
      if (!s.current() || hashAction(input) !== originalHash) throw new Error("message changed during preparation");
      return { ...reviewed, recommendation, revision: s.revision, isCurrent: s.current };
    },
    reviewAction: (input: GateInput, signal?: AbortSignal) => gate("gate", input, signal),
    async checkpoint(input: PulseInput, signal?: AbortSignal): Promise<PulseDecision | undefined> {
      if (modes.pulse === "off") return undefined;
      const decision = await judge("pulse", (opts) => reflexes.pulse({ ...input, events: input.events.slice(-20).map((v) => boundForReview(v, 1000).text) }, opts), signal);
      return modes.pulse === "active" ? decision : undefined;
    },
    async route(input: SteerInput, signal?: AbortSignal): Promise<SteerDecision | undefined> {
      if (modes.steer === "off") return undefined;
      const decision = await judge("steer", (opts) => reflexes.steer({ ...input, events: input.events.slice(-20).map((v) => boundForReview(v, 1000).text) }, opts), signal);
      return modes.steer === "active" ? decision : undefined;
    },
    applied: (flow: PluginFlow, outcome: string) => event(flow, "applied", outcome),
    dispose() { if (!disposed) { disposed = true; controller.abort(); } },
  };
}
export type PluginSession = ReturnType<typeof createPluginSession>;
