import {
  ReflexEngine,
  processOutput,
  type OutputPipelineInput,
  type ReviewedOutput,
  BoundedAnswerCache,
  type AskOptions,
  type SelectInput,
  type SelectDecision,
  type SteerInput,
  type SteerOptions,
  type SteerDecision,
  type MessageGateInput,
  type PulseDecision,
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
  type JournalEvent,
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

export type {
  SystemOne,
  GateInput,
  GateDecision,
  ObserveToolResultInput,
  SanitizeDecision,
  VerifyDecision,
  FocusMode,
  AskResult,
  BoundedText,
};
export { boundForReview, REVIEW_CHAR_CAP };
export { jevJudge } from "./judges/jev";
export { genericJudge } from "./judges/generic";

export interface ReflexDecisionEvent {
  reflex: "gate" | "sanitize" | "verify" | "focus" | "select" | "pulse" | "steer" | "message_gate";
  action: string;
  reasons: string[];
  judgmentId?: string;
  sessionId?: string;
}

export interface JudgmentEvent {
  sessionId: string;
  judgmentId: string;
  taskId?: string;
  revision?: number;
  reflex: string;
  status: "completed" | "unavailable" | "cancelled";
  model?: string;
  durationMs?: number;
  usage: AskResult["usage"];
  cacheHit: boolean;
  cachedFromJudgmentId?: string;
  answerSchema: 2;
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
  /** Called after every decision; journalPath alone controls durable logging. */
  onDecision?: (event: ReflexDecisionEvent) => void;
  /** Metadata only: no prompt, tool text, or secrets. Cache hits have zero incremental usage. */
  onJudgment?: (event: JudgmentEvent) => void;
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
  readonly sessionId: string;
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
  const sessionId = newId("sess");
  const sink = options.journalPath ? openJournal(options.journalPath) : undefined;
  const journal: Journal = {
    append(event: JournalEvent) {
      sink?.append(event);
      if (event.t === "decision")
        options.onDecision?.({
          reflex: event.reflex as ReflexDecisionEvent["reflex"],
          action: event.action,
          reasons: event.reasons,
          judgmentId: event.judgmentId,
          sessionId,
        });
      if (event.t === "reflex") {
        options.onJudgment?.({
          sessionId: event.sessionId,
          judgmentId: event.judgmentId,
          reflex: event.reflex,
          status: event.status,
          taskId: event.taskId,
          revision: event.revision,
          model: event.result?.model,
          durationMs: event.cacheHit ? 0 : event.result?.latencyMs,
          usage: event.cacheHit ? { inputTokens: 0, outputTokens: 0 } : (event.result?.usage ?? { inputTokens: null, outputTokens: null }),
          cacheHit: event.cacheHit === true,
          cachedFromJudgmentId: event.cachedFromJudgmentId,
          answerSchema: 2,
        });
      }
    },
  };
  const policy: Policy = { ...policyForTrust(0.3), ...options.policy };
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

  return {
    sessionId,
    resetTask: () => engine.resetTask(),
    async processOutput(input) {
      const result = await processOutput(input, { focus: (i, o) => engine.focus(i, o), observe: (i, o) => engine.observeToolResult(i, o) });
      return result;
    },
    async select(input, opts) {
      const decision = await engine.select(input, opts);
      return decision;
    },
    async messageGate(input, opts) {
      const decision = await engine.messageGate(input, opts);
      return decision;
    },
    async pulse(input, opts) {
      const decision = await engine.pulse(input, opts);
      return decision;
    },
    async steer(input, opts) {
      const decision = await engine.steer(input, opts);
      return decision;
    },
    async gate(input, opts) {
      const decision = await engine.gate(input, opts);
      return decision;
    },

    async observe(input, opts) {
      const { sanitize, verify } = await engine.observeToolResult(input, opts);
      return { sanitize, verify };
    },

    async focus(input, opts) {
      const { content, artifactId, budgetChars, ...rest } = input;
      const manifest = splitIntoSections(artifactId ?? "reflexes:focus", content);
      const decision = await engine.focus({ ...rest, manifest, budgetChars: budgetChars ?? DEFAULT_FOCUS_BUDGET_CHARS }, opts);

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
export { createPluginSession, waitForHost } from "./session";
export type {
  PluginSession,
  PluginSessionOptions,
  PluginModes,
  PluginFlow,
  PluginEvent,
  ReflexMode,
  CapabilityContext,
  CapabilityRecommendation,
  GateReview,
  ExistingActionApproval,
  ActionApprovalResolver,
} from "./session";

export type { CapturedOutput, PresentedOutput, ReviewedOutput, OutputPipelineInput } from "@brainstem/core";
