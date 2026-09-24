import {
  ReflexEngine,
  processOutput, type OutputPipelineInput, type ReviewedOutput,
  BoundedAnswerCache,
  type AskOptions,
  type SelectInput, type SelectDecision,
  type SteerInput, type SteerOptions, type SteerDecision,
  type MessageGateInput, type PulseDecision,
  type AnswerCache,
  policyForTrust,
  openJournal,
  newId,
  splitIntoSections,
  getBit,
  boundForReview,
  REVIEW_CHAR_CAP,
  type SystemOne,
  type Policy,
  type Journal,
  type GateInput,
  type GateDecision,
  type ObserveToolResultInput,
  type SanitizeDecision,
  type VerifyDecision,
  type FocusInput,
  type FocusMode,
  type AskResult,
  type BoundedText,
} from "@brainstem/core";

export type { SystemOne, GateInput, GateDecision, ObserveToolResultInput, SanitizeDecision, VerifyDecision, FocusMode, AskResult, BoundedText };
export { boundForReview, REVIEW_CHAR_CAP };
export { jevJudge } from "./judges/jev";
export { genericJudge } from "./judges/generic";

export interface ReflexDecisionEvent {
  reflex: "gate" | "sanitize" | "verify" | "focus" | "select" | "pulse" | "steer" | "message_gate";
  action: string;
  reasons: string[];
  judgmentId?: string;
}

export interface ReflexesOptions {
  /** The only required option. Any SystemOne implementation works — see jevJudge / genericJudge. */
  judge: SystemOne;
  signal?: AbortSignal;
  maxJudgmentCalls?: number;
  cache?: AnswerCache;
  /** Default: process.cwd(). Used by Gate's static floor path checks. */
  root?: string;
  /**
   * Shallow-merged over policyForTrust(0.3)'s defaults — top-level keys only.
   * Overriding one field of a sub-object (e.g. policy.gate.autoConfidence)
   * requires passing the WHOLE `gate` sub-object; there is no deep merge.
   */
  policy?: Partial<Policy>;
  /** Called after every decision. No journal is created unless this or journalPath is supplied. */
  onDecision?: (event: ReflexDecisionEvent) => void;
  /** When supplied, decisions are ALSO durably appended via @brainstem/core's journal format. */
  journalPath?: string;
}

// Matches packages/cli/src/output/present.ts's FOCUS_PRESENT_BUDGET_CHARS —
// a consumer of this library shouldn't have to know a token/char budget
// exists any more than they should know SectionManifest exists.
const DEFAULT_FOCUS_BUDGET_CHARS = 4_000;

export interface FocusLibraryInput extends Omit<FocusInput, "manifest" | "budgetChars"> {
  content: string;
  artifactId?: string;
  budgetChars?: number;
}

export interface FocusResult {
  mode: FocusMode;
  text: string;
  sectionManifestHash: string;
}

export type ObserveOptions = AskOptions & { sanitize?: boolean; verify?: boolean };
export type PulseInput = Parameters<ReflexEngine["pulse"]>[0];

export interface Reflexes {
  processOutput(input: OutputPipelineInput): Promise<ReviewedOutput>;
  select(input: SelectInput, options?: AskOptions): Promise<SelectDecision>;
  messageGate(input: MessageGateInput, options?: AskOptions): Promise<GateDecision & { result?: AskResult }>;
  pulse(input: PulseInput, options?: AskOptions): Promise<PulseDecision>;
  steer(input: SteerInput, options?: SteerOptions): Promise<SteerDecision>;
  resetTask(): void;
  gate(input: GateInput, options?: AskOptions): Promise<GateDecision & { result?: AskResult }>;
  observe(input: ObserveToolResultInput, options?: ObserveOptions): Promise<{ sanitize: SanitizeDecision; verify: VerifyDecision }>;
  focus(input: FocusLibraryInput, options?: AskOptions): Promise<FocusResult>;
}

export function createReflexes(options: ReflexesOptions): Reflexes {
  const journal: Journal = options.journalPath ? openJournal(options.journalPath) : { append() {} };
  const policy: Policy = { ...policyForTrust(0.3), ...options.policy };
  const sessionId = newId("sess");

  const engine = new ReflexEngine({
    systemOne: options.judge,
    signal: options.signal,
    maxJudgmentCalls: options.maxJudgmentCalls,
    cache: options.cache ?? new BoundedAnswerCache(),
    journal,
    policy,
    root: options.root ?? process.cwd(),
    makeId: () => newId("j"),
    ids: () => ({ sessionId }),
  });

  const emit = (event: ReflexDecisionEvent): void => options.onDecision?.(event);

  return {
    resetTask: () => engine.resetTask(),
    async processOutput(input) {
      const result = await processOutput(input, { focus: (i, o) => engine.focus(i, o), observe: (i, o) => engine.observeToolResult(i, o) });
      if (result.focusDecision) emit({ reflex: "focus", action: result.focusDecision.mode, reasons: result.focusDecision.reasons });
      if (result.sanitize) emit({ reflex: "sanitize", action: result.sanitize.action, reasons: result.sanitize.reasons });
      if (result.verify) emit({ reflex: "verify", action: result.verify.action, reasons: result.verify.reasons });
      return result;
    },
    async select(input, opts) {
      const decision = await engine.select(input, opts);
      emit({ reflex: "select", action: decision.status, reasons: [] });
      return decision;
    },
    async messageGate(input, opts) {
      const decision = await engine.messageGate(input, opts);
      emit({ reflex: "message_gate", action: decision.action, reasons: decision.reasons });
      return decision;
    },
    async pulse(input, opts) {
      const decision = await engine.pulse(input, opts);
      emit({ reflex: "pulse", action: decision.action, reasons: decision.reasons });
      return decision;
    },
    async steer(input, opts) {
      const decision = await engine.steer(input, opts);
      emit({ reflex: "steer", action: decision.tier, reasons: decision.reasons });
      return decision;
    },
    async gate(input, opts) {
      const decision = await engine.gate(input, opts);
      emit({ reflex: "gate", action: decision.action, reasons: decision.reasons });
      return decision;
    },

    async observe(input, opts) {
      const { sanitize, verify } = await engine.observeToolResult(input, opts);
      if (opts?.sanitize !== false) emit({ reflex: "sanitize", action: sanitize.action, reasons: sanitize.reasons });
      if (opts?.verify !== false) emit({ reflex: "verify", action: verify.action, reasons: verify.reasons });
      return { sanitize, verify };
    },

    async focus(input, opts) {
      const { content, artifactId, budgetChars, ...rest } = input;
      const manifest = splitIntoSections(artifactId ?? "reflexes:focus", content);
      const decision = await engine.focus({ ...rest, manifest, budgetChars: budgetChars ?? DEFAULT_FOCUS_BUDGET_CHARS }, opts);
      emit({ reflex: "focus", action: decision.mode, reasons: decision.reasons });

      if (decision.mode !== "select") {
        // "full" and "compute_or_retrieve" both mean: this library has no
        // separate raw-capture-vs-presented-view concept, so the caller
        // already has `content` — return it unmodified rather than
        // reimplementing packages/cli's naive-truncation fallback, which
        // exists only because that harness separately stores the original.
        return { mode: decision.mode, text: content, sectionManifestHash: decision.sectionManifestHash };
      }

      const selectedText = manifest.entries
        .filter((_, i) => getBit(decision.selected, i))
        .map((s) => s.text)
        .join("\n\n");
      return { mode: decision.mode, text: selectedText || content, sectionManifestHash: decision.sectionManifestHash };
    },
  };
}

export type { AskOptions, SelectInput, SelectDecision, SteerInput, SteerOptions, SteerDecision, MessageGateInput, PulseDecision };
export { createPluginSession } from "./session";
export type { PluginSession, PluginSessionOptions, PluginModes, PluginFlow, PluginEvent, ReflexMode, CapabilityContext, CapabilityRecommendation, GateReview } from "./session";

export type { CapturedOutput, PresentedOutput, ReviewedOutput, OutputPipelineInput } from "@brainstem/core";
