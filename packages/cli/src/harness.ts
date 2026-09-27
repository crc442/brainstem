import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Message, Model, Api } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import {
  ReflexEngine,
  processOutput,
  ARTIFACT_SCHEMA_VERSION,
  BoundedAnswerCache,
  boundForReview,
  contentHash,
  countLines,
  toIds,
  hashAction,
  newId,
  openJournal,
  policyForTrust,
  staticVerdict,
  type ReflexModes,
  type ReflexName,
  type ReflexMode,
  type GateInput,
  type AnswerCache,
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalStatus,
  type ArtifactRecord,
  type Journal,
  type SystemOne,
  type ToolObservation,
  type ToolStatus,
  type TurnSpans,
} from "@brainstem/core";
import { buildActiveContext } from "./capabilities/context";
import { makeDiscoveryTool } from "./capabilities/discovery";
import { CapabilityRegistry } from "./capabilities/registry";
import { SelectDriver } from "./capabilities/select-policy";
import { loadSkillsFromRoot } from "./capabilities/skills";
import { checkDemoWrite, prepareDemoWrite, type PreparedDemoWrite } from "./paths";
import { changeSummaryForWrite } from "./change-summary";
import { SessionRecorder } from "./session";
import { makeTools } from "./tools";
import { LocalArtifactStore } from "./output/artifact-store";
import { presentArtifact, type FocusRolloutMode } from "./output/present";
import { makeRecoveryTools } from "./output/recovery-tools";

export const DEFAULT_SYSTEM_PROMPT = `You are a careful coding agent. Work inside the project directory. Prefer small, verifiable steps: run tests, read before writing, and keep the user informed. If a tool result says the harness blocked or flagged something, surface that to the user in your reply.`;

export interface HarnessOptions {
  systemOne: SystemOne;
  streamFn: StreamFn;
  model: Model<Api>;
  miniModel?: Model<Api>;
  trust: number;
  journalPath: string;
  cwd: string;
  systemPrompt?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  approvalHandler?: ApprovalHandler;
  registry?: CapabilityRegistry;
  answerCache?: AnswerCache;
  skillRoots?: string[];
  focusMode?: FocusRolloutMode;
  pulseEveryTurns?: number;
  signal?: AbortSignal;
  reflexModes?: ReflexModes;
  messageConstraints?: string[];
  maxJudgmentCalls?: number;
  onReflex?: (line: string) => void;
  onDelta?: (delta: string) => void;
}

export interface Harness {
  agent: Agent;
  engine: ReflexEngine;
  journal: Journal;
  recorder: SessionRecorder;
  journalPath: string;
  approvalsRequested(): number;
  prompt(text: string): Promise<void>;
  endSession(reason?: "normal" | "error", error?: string): void;
}

const EXCERPT_CAP = 2_000;
const STEER_CAPABILITY_CAP = 12;
const CAPTURED_TOOLS = new Set(["bash", "read", "write", "grep", "glob"]);
const RECOVERY_TOOLS = new Set(["read_output", "search_output"]);

function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

interface ToolDetails {
  status?: ToolStatus;
  exit?: number;
  durationMs?: number;
  truncated?: boolean;
  // bash: separate captured streams (see packages/cli/src/tools.ts).
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutText?: string;
  stderrText?: string;
  stdoutObservedBytes?: number;
  stderrObservedBytes?: number;
  stdoutComplete?: boolean;
  stderrComplete?: boolean;
  // read: bounded-streaming file read (see packages/cli/src/tools.ts).
  sourceBytes?: number;
  retainedBytes?: number;
}

function detailsOf(result: unknown): ToolDetails {
  return (result as { details?: ToolDetails } | undefined)?.details ?? {};
}

function actionLabel(tool: string, args: unknown): string {
  const a = (args ?? {}) as { command?: string; path?: string; pattern?: string };
  const subject = a.command ?? a.path ?? a.pattern;
  return subject === undefined ? tool : `${tool}: ${subject.slice(0, 80)}`;
}

function argsSummaryFor(args: unknown): unknown {
  if (args === null || typeof args !== "object") return args ?? {};
  const { content: _content, ...rest } = args as Record<string, unknown>;
  return rest;
}

// R3: the action hash used for approval must include write CONTENT identity
// (digest + length), not just the args with content stripped out — otherwise
// approval of "write path X with content A" is indistinguishable from
// approval of "write path X with content B". `v` versions the hash schema:
// a formula change here naturally invalidates any historical hash, since a
// differently-versioned hash can never equal one computed under this
// version.
const ACTION_HASH_SCHEMA_VERSION = 1;

function actionIdentity(tool: string, args: unknown, extra: { target?: string; preconditionDigest?: string } = {}): unknown {
  const content = (args as { content?: string } | undefined)?.content;
  return {
    v: ACTION_HASH_SCHEMA_VERSION,
    tool,
    ...(argsSummaryFor(args) as object),
    ...(typeof content === "string" ? { contentDigest: contentHash(content), contentLength: Buffer.byteLength(content, "utf8") } : {}),
    ...(extra.target !== undefined ? { target: extra.target } : {}),
    ...(extra.preconditionDigest !== undefined ? { preconditionDigest: extra.preconditionDigest } : {}),
  };
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export function createHarness(options: HarnessOptions): Harness {
  const policy = policyForTrust(options.trust);
  const lifecycle = new AbortController();
  const pluginSignal = options.signal ? AbortSignal.any([lifecycle.signal, options.signal]) : lifecycle.signal;
  const mode = (name: ReflexName, fallback: ReflexMode = "active"): ReflexMode => options.reflexModes?.[name] ?? fallback;
  const journal = openJournal(options.journalPath);
  const recorder = new SessionRecorder(journal, options.cwd, { policy, trust: options.trust });

  const engine = new ReflexEngine({
    systemOne: options.systemOne,
    journal,
    policy,
    root: options.cwd,
    environment: `Working directory: ${options.cwd}. A git repository.`,
    makeId: () => newId("j"),
    ids: () => ({
      sessionId: recorder.sessionId,
      ...(recorder.currentTask !== undefined ? { taskId: recorder.currentTask.id } : {}),
      ...(recorder.currentTurnId !== undefined ? { turnId: recorder.currentTurnId } : {}),
    }),
    budgets: policy.budgets,
    signal: pluginSignal,
    maxJudgmentCalls: options.maxJudgmentCalls,
    cache: options.answerCache ?? new BoundedAnswerCache(),
  });

  const taskText = () => recorder.currentTask?.objective ?? "unspecified";

  const render = (reflex: string, action: string, reasons: string[]) =>
    `[${reflex}] ${action}${reasons.length > 0 ? ` — ${reasons[0]}` : ""}`;

  function gateBlock(reason: string): { block: true; reason: string } {
    return { block: true, reason: `[brainstem] ${reason} Ask the user to confirm, and re-run only if they approve.` };
  }

  // Session-scoped: <journal-parent>/sessions/<sessionId>/artifacts, keyed by
  // the SessionRecorder-generated id (never a timestamp-only directory name)
  // so concurrent sessions sharing a journal parent directory can never read
  // or evict each other's artifacts (R7). Pre-existing shared-directory
  // artifacts from older sessions are simply never looked at by a new
  // session — this does not delete or migrate them (see README).
  const artifactStore = new LocalArtifactStore(
    join(dirname(options.journalPath), "sessions", recorder.sessionId, "artifacts"),
    recorder.sessionId,
  );
  const registry = options.registry ?? new CapabilityRegistry();
  const driver = new SelectDriver({ registry, engine, minRefreshIntervalMs: 0, mode: mode("select") });

  const approvedWrites = new Map<string, PreparedDemoWrite>();
  const tools: AgentTool[] = [
    ...makeTools({ cwd: options.cwd, approvedWrites }),
    ...makeRecoveryTools({ store: artifactStore }),
    makeDiscoveryTool({
      registry,
      driver,
      taskText,
      recentActivity: () => summarizeMessages(agent?.state.messages ?? []),
    }),
  ];
  for (const t of tools) registry.attachImpl(`tool:${t.name}`, t);

  for (const root of options.skillRoots ?? []) {
    for (const skill of loadSkillsFromRoot(root, [options.cwd, ...(options.skillRoots ?? [])])) {
      registry.registerSkill(skill);
    }
  }

  const initialWs = registry.workingSet();
  const initialBuilt = buildActiveContext(registry, initialWs);
  let appliedIdsKey = initialBuilt.activeIds.join(",");
  let appliedInstructionHash: string | undefined = initialBuilt.instructionHash;
  let lastTaskRevision = 0;

  // Capability descriptions are evidence for Steer only. Relevance never grants
  // execution permission, so this is read off the active set and nothing more.
  function activeCapabilityDescriptions(): string[] {
    try {
      const catalog = registry.snapshot();
      const active = registry.workingSet().active;
      const byId = new Map(catalog.entries.map((d) => [d.id, d.description]));
      return toIds(active, catalog.entries)
        .slice(0, STEER_CAPABILITY_CAP)
        .map((id) => `${id}: ${byId.get(id) ?? ""}`);
    } catch {
      return [];
    }
  }

  function textOfAny(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return textOf(content as { type: string; text?: string }[]);
  }

  let turnsCompleted = 0;
  let turnJevMs = 0;
  let turnModelMs = 0;
  let approvalsRequestedCount = 0;

  async function timedJev<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      turnJevMs += performance.now() - t0;
    }
  }

  function summarizeMessages(messages: { role: string; content?: unknown }[]): string[] {
    const lines = recorder.recentActivity(5);
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) {
      const text = textOfAny(lastAssistant.content).slice(0, 140).replace(/\n/g, " ");
      lines.push(`assistant: ${text || "(tool calls)"}`);
    }
    return lines;
  }

  function emitObservation(obs: ToolObservation, deliveredExcerpt: string, deliveredTruncated: boolean, deliveredWhy?: string): void {
    recorder.recordObservation(obs);
    journal.append({
      t: "tool_observation",
      v: 2,
      toolCallId: obs.toolCallId,
      turnId: recorder.currentTurnId ?? "",
      ts: Date.now(),
      observation: obs,
      deliveredExcerpt,
      deliveredTruncated,
      ...(deliveredWhy !== undefined ? { deliveredWhy } : {}),
    });
  }

  function emitBlockedObservation(toolCallId: string, tool: string, args: unknown, delivered: string, why: string): void {
    recorder.recordAction(hashAction(actionIdentity(tool, args)), actionLabel(tool, args));
    emitObservation(
      {
        toolCallId,
        tool,
        argsSummary: argsSummaryFor(args),
        status: "blocked",
        durationMs: 0,
        excerpt: delivered,
        truncated: false,
      },
      delivered,
      false,
      why,
    );
  }

  interface ApprovalPrepared {
    target?: string;
    changeSummary?: string;
    preconditionDigest?: string;
    /** Re-verified immediately before consuming approval: target identity and preimage must not have changed underneath a pending request. */
    recheck?: () => { changed: boolean; reason: string };
  }

  async function runApproval(
    toolCallId: string,
    tool: string,
    args: unknown,
    reasons: string[],
    signal: AbortSignal | undefined,
    prepared: ApprovalPrepared = {},
  ): Promise<{ block: true; reason: string } | undefined> {
    // Approval binds to the validated args of this beforeToolCall invocation: args
    // are fixed within one hook call, so the hash recorded at request time is
    // re-checked at resolution time against those same validated inputs. The
    // hash identity includes write content digest+length and the canonical
    // target/precondition (see actionIdentity), so approving one write can
    // never be reinterpreted as approving a different target or payload.
    const approvalId = newId("appr");
    const taskId = recorder.currentTask?.id ?? "";
    const actionHash = hashAction(actionIdentity(tool, args, { target: prepared.target, preconditionDigest: prepared.preconditionDigest }));
    const request: ApprovalRequest = {
      id: approvalId,
      taskId,
      toolCallId,
      cwd: options.cwd,
      tool,
      // Defensive read-only snapshot: JSON round-trip so a handler cannot
      // mutate the object the execution wrapper will later re-hash from.
      validatedArgs: args === undefined ? {} : (JSON.parse(JSON.stringify(args)) as unknown),
      actionHash,
      reasons,
      ...(prepared.target !== undefined ? { target: prepared.target } : {}),
      ...(prepared.changeSummary !== undefined ? { changeSummary: prepared.changeSummary } : {}),
    };
    approvalsRequestedCount += 1;
    const appendApproval = (status: ApprovalStatus, why?: string) =>
      journal.append({
        t: "approval",
        v: 2,
        approvalId,
        ts: Date.now(),
        status,
        taskId,
        toolCallId,
        actionHash,
        reasons: why !== undefined ? [why] : reasons,
      });
    appendApproval("requested");

    if (!options.approvalHandler) {
      appendApproval("invalidated", "no handler");
      const reason = gateBlock(`needs approval: ${reasons.join("; ")}`).reason;
      emitBlockedObservation(toolCallId, tool, args, reason, "gate ask: no approval handler");
      return { block: true, reason };
    }

    let resolution: ApprovalResolution;
    try {
      resolution = await withAbort(options.approvalHandler(request), signal);
    } catch {
      appendApproval("cancelled", "handler threw or caller aborted");
      const reason = "[brainstem] approval cancelled";
      emitBlockedObservation(toolCallId, tool, args, reason, "approval cancelled");
      return { block: true, reason };
    }

    const currentHash = hashAction(
      actionIdentity(tool, args, { target: prepared.target, preconditionDigest: prepared.preconditionDigest }),
    );
    if (currentHash !== actionHash) {
      appendApproval("invalidated", "action changed since request");
      const reason = "[brainstem] approval cancelled";
      emitBlockedObservation(toolCallId, tool, args, reason, "action changed since approval request");
      return { block: true, reason };
    }

    if (resolution !== "approve_once") {
      appendApproval("denied", "denied by user");
      const reason = "[brainstem] denied by user";
      emitBlockedObservation(toolCallId, tool, args, reason, "denied by user");
      return { block: true, reason };
    }

    // Recheck target identity and preimage right before consuming approval:
    // a file edited (or a target substituted) between request and
    // resolution must re-enter review rather than silently execute against
    // whatever now sits at that path.
    if (prepared.recheck) {
      const check = prepared.recheck();
      if (check.changed) {
        appendApproval("invalidated", check.reason);
        const reason = `[brainstem] approval cancelled: ${check.reason}. Re-run for a fresh review.`;
        emitBlockedObservation(toolCallId, tool, args, reason, check.reason);
        return { block: true, reason };
      }
    }

    appendApproval("approved");
    return undefined;
  }

  async function judgeAction(input: GateInput, signal?: AbortSignal) {
    const floor = staticVerdict(input.tool, { command: input.command, path: input.path }, options.cwd);
    if (mode("gate") === "off") return { action: floor ?? "auto", reasons: floor ? ["host static permission rule"] : [] };
    const decision = await timedJev(() => engine.gate(input, { signal }));
    return mode("gate") === "shadow" ? { action: floor ?? "auto", reasons: ["Gate shadow; host permissions applied"] } : decision;
  }

  const innerStreamFn = options.streamFn;
  let modelStartedAt = 0;
  let firstTokenAt: number | undefined;
  const routedStreamFn: StreamFn = async (model, context, streamOptions) => {
    modelStartedAt = performance.now();
    firstTokenAt = undefined;
    engine.noteModelCall();
    if (options.miniModel && mode("steer") !== "off") {
      const latest = recorder.recentActivity(1)[0];
      const capabilities = activeCapabilityDescriptions();
      const decision = await timedJev(() =>
        engine.steer(
          {
            task: taskText(),
            events: summarizeMessages(context.messages),
            ...(latest !== undefined ? { latestObservation: latest } : {}),
            ...(capabilities.length > 0 ? { capabilities } : {}),
          },
          // The harness performs the routing, so it is the only place that knows
          // which model id a chosen tier actually resolves to.
          { resolveModelId: (tier) => (tier === "mini" ? options.miniModel!.id : model.id) },
        ),
      );
      options.onReflex?.(render("steer", decision.tier, decision.reasons));
      return innerStreamFn(mode("steer") === "active" && decision.tier === "mini" ? options.miniModel : model, context, streamOptions);
    }
    return innerStreamFn(model, context, streamOptions);
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: options.model,
      tools: initialBuilt.tools,
      thinkingLevel: options.thinkingLevel ?? "low",
    },
    streamFn: routedStreamFn,
    toolExecution: "sequential",
    shouldStopAfterTurn: async () => {
      turnsCompleted += 1;
      const every = options.pulseEveryTurns ?? 3;
      if (mode("pulse") === "off" || turnsCompleted % every !== 0) return false;

      const decision = await timedJev(() =>
        engine.pulse({
          task: taskText(),
          events: summarizeMessages(agent.state.messages),
          budget: `${recorder.modelCalls} model calls so far`,
          facts: recorder.pulseFacts(),
          actionHashes: recorder.recentActionHashes.slice(-6),
        }),
      );
      options.onReflex?.(render("pulse", decision.action, decision.reasons));

      if (mode("pulse") !== "active") return false;
      if (decision.action === "stop") return true;
      if (decision.action === "intervene") {
        agent.steer({
          role: "user",
          content: [
            {
              type: "text",
              text: `[brainstem] reflex intervention: ${decision.reasons.join("; ")}. Change your approach — do not simply repeat your previous steps.`,
            },
          ],
          timestamp: Date.now(),
        });
      }
      return false;
    },
    prepareNextTurnWithContext: async ({ context }) => {
      const currentTask = recorder.currentTask;
      const currentRevision = currentTask?.revision ?? 0;
      if (currentRevision !== lastTaskRevision) {
        await driver.refresh({ task: taskText(), recent: summarizeMessages(context.messages) }, { reason: "task_update" });
        lastTaskRevision = currentRevision;
      }

      const decision = driver.currentDecision();
      const ws = registry.workingSet({}, decision && { evaluated: decision.evaluated, recommended: decision.recommended });
      const built = buildActiveContext(registry, ws);
      const idsKey = built.activeIds.join(",");
      if (idsKey === appliedIdsKey && built.instructionHash === appliedInstructionHash) {
        return undefined;
      }

      journal.append({
        t: "capability_set",
        v: 2,
        ts: Date.now(),
        ...(currentTask ? { taskId: currentTask.id } : {}),
        ...(recorder.currentTurnId ? { turnId: recorder.currentTurnId } : {}),
        catalogHash: registry.catalogFingerprint(),
        activeIds: built.activeIds,
        ...(built.instructionHash !== undefined ? { instructionHash: built.instructionHash } : {}),
      });

      // Discovery-driven refresh happens inside a tool execute mid-turn and updates
      // the driver's decision immediately, but this single integration point is
      // where tool-set/skill-instruction changes reach the model — at the next
      // turn boundary after the current assistant turn's remaining tool calls finish.
      const result = {
        context: {
          messages:
            built.instructionHash !== appliedInstructionHash && built.instructionBlock !== undefined
              ? [...context.messages, { role: "system", content: built.instructionBlock, timestamp: Date.now() } as Message]
              : context.messages,
          tools: built.tools,
        },
      };

      agent.state.tools = built.tools;
      appliedIdsKey = idsKey;
      appliedInstructionHash = built.instructionHash;
      return result;
    },
    beforeToolCall: async ({ toolCall, args }, signal) => {
      const a = (args ?? {}) as { command?: string; path?: string };
      const toolCallId = toolCall.id;
      const initialArguments = JSON.stringify(args);

      if (toolCall.name === "write") {
        approvedWrites.delete(toolCallId);
        const denyWrite = (why: string) => {
          journal.append({ t: "decision", v: 2, ts: Date.now(), reflex: "gate", action: "deny", reasons: [why] });
          options.onReflex?.(render("gate", "deny", [why]));
          const reason = `[brainstem] write blocked: ${why}`;
          emitBlockedObservation(toolCallId, toolCall.name, args, reason, why);
          return { block: true as const, reason };
        };
        // Snapshot arguments and file state before either asynchronous judgment
        // or approval. These checks are ordinary CLI safeguards, not isolation.
        let prepared: PreparedDemoWrite;
        try {
          prepared = prepareDemoWrite(options.cwd, a.path ?? "", (args as { content: string }).content);
        } catch {
          return denyWrite("target must be an accessible regular file or a new file; symlinks are not writable");
        }
        const floor = staticVerdict("write", { path: prepared.target }, options.cwd);
        if (floor === "deny") return denyWrite("static floor denies this target");
        const change = changeSummaryForWrite(options.cwd, prepared.target, prepared.content);
        const decision =
          floor === "ask"
            ? { action: "ask", reasons: ["write outside project root requires approval"] }
            : await judgeAction(
                {
                  tool: "write",
                  task: taskText(),
                  path: prepared.target,
                  changeSummary: change.changeSummary,
                  evidenceIncomplete: change.evidenceIncomplete,
                },
                signal,
              );
        options.onReflex?.(render("gate", decision.action, decision.reasons));
        if (decision.action === "deny") return denyWrite(decision.reasons.join("; "));
        if (decision.action === "ask") {
          const blocked = await runApproval(toolCallId, "write", args, decision.reasons, signal, {
            target: prepared.target,
            changeSummary: change.changeSummary,
            preconditionDigest: prepared.expectedState,
            recheck: () => checkDemoWrite(prepared),
          });
          if (blocked) return blocked;
        }
        if (signal?.aborted) return denyWrite("cancelled");
        const current = args as { path: string; content: string };
        if (current.path !== prepared.path || current.content !== prepared.content) return denyWrite("arguments changed since review");
        const checked = checkDemoWrite(prepared);
        if (checked.changed) return denyWrite(checked.reason);
        approvedWrites.set(toolCallId, prepared);
        return undefined;
      }

      if (toolCall.name === "bash") {
        const decision = await judgeAction({ tool: toolCall.name, task: taskText(), command: a.command ?? "" }, signal);
        if (signal?.aborted || initialArguments !== JSON.stringify(args))
          return { block: true, reason: "[brainstem] action changed or cancelled since review" };
        options.onReflex?.(render("gate", decision.action, decision.reasons));
        if (decision.action === "deny") {
          const reason = `[brainstem] denied: ${decision.reasons.join("; ")}. Do not retry this command.`;
          emitBlockedObservation(toolCallId, toolCall.name, args, reason, `gate deny: ${decision.reasons.join("; ")}`);
          return { block: true, reason };
        }
        if (decision.action === "ask") {
          return await runApproval(toolCallId, toolCall.name, args, decision.reasons, signal, {});
        }
        return undefined;
      }

      if (toolCall.name === "read" || toolCall.name === "grep" || toolCall.name === "glob") {
        const verdict = staticVerdict(toolCall.name, { path: a.path }, options.cwd);
        if (verdict !== null) {
          journal.append({
            t: "decision",
            v: 2,
            ts: Date.now(),
            reflex: "gate",
            action: verdict,
            reasons: [`static floor: secrets path ${a.path}`],
            staticVerdict: verdict,
          });
          options.onReflex?.(render("gate", verdict, [`secrets path ${a.path}`]));
          const reason = gateBlock(`reading or searching ${a.path} touches potential secrets`).reason;
          emitBlockedObservation(toolCallId, toolCall.name, args, reason, `static floor: secrets path ${a.path}`);
          return { block: true, reason };
        }
      }

      return undefined;
    },
    afterToolCall: async ({ toolCall, result, isError }) => {
      const toolCallId = toolCall.id;
      const rawContent = (result?.content ?? []) as { type: string; text?: string }[];
      const fullText = textOf(rawContent);
      const nonTextCount = rawContent.filter((c) => c.type !== "text").length;
      const details = detailsOf(result);

      // Capture the full output before any sanitize override so the original
      // bytes stay recoverable even when the presented view is blocked or
      // bounded. Captured regardless of isError: untrusted failure text (a
      // stderr tail, an exception message) needs the same review and
      // recovery path as any other tool output — R1's whole point is that
      // isError must never be a bypass. Preserved as separate named streams
      // (R5): bash keeps stdout/stderr distinct rather than implying their
      // concatenation reconstructs temporal interleaving; every other
      // captured tool has exactly one "output" stream. Empty output is still
      // captured as an empty artifact — "(no output)" is presentation
      // wording, applied below, never source content.
      let artifact: ArtifactRecord | undefined;
      if (CAPTURED_TOOLS.has(toolCall.name) && !RECOVERY_TOOLS.has(toolCall.name)) {
        const args = (toolCall.arguments ?? {}) as { command?: string; path?: string; pattern?: string };
        const streamContent: Record<string, string> = {};
        const streams: Record<string, { bytesObserved: number; bytesRetained: number; complete: boolean }> = {};
        if (toolCall.name === "bash" && details.stdoutText !== undefined) {
          streamContent.stdout = details.stdoutText;
          streamContent.stderr = details.stderrText ?? "";
          streams.stdout = {
            bytesObserved: details.stdoutObservedBytes ?? Buffer.byteLength(streamContent.stdout, "utf8"),
            bytesRetained: Buffer.byteLength(streamContent.stdout, "utf8"),
            complete: details.stdoutComplete !== false,
          };
          streams.stderr = {
            bytesObserved: details.stderrObservedBytes ?? Buffer.byteLength(streamContent.stderr, "utf8"),
            bytesRetained: Buffer.byteLength(streamContent.stderr, "utf8"),
            complete: details.stderrComplete !== false,
          };
        } else {
          streamContent.output = fullText;
          streams.output = {
            bytesObserved: details.sourceBytes ?? Buffer.byteLength(fullText, "utf8"),
            bytesRetained: Buffer.byteLength(fullText, "utf8"),
            complete: details.truncated !== true,
          };
        }
        const record: ArtifactRecord = {
          artifactId: newId("art"),
          sessionId: recorder.sessionId,
          schemaVersion: ARTIFACT_SCHEMA_VERSION,
          toolCallId,
          tool: toolCall.name,
          commandOrTarget: args.command ?? args.path ?? args.pattern ?? "",
          // Documented rendering order for the combined hash: stream
          // insertion order above (stdout before stderr for bash), matching
          // `fullText`'s own construction in tools.ts — never implied as the
          // true temporal interleaving.
          contentHash: contentHash(fullText),
          byteCount: Object.values(streams).reduce((sum, s) => sum + s.bytesRetained, 0),
          lineCount: countLines(fullText),
          captureComplete: Object.values(streams).every((s) => s.complete),
          createdAt: Date.now(),
          streams,
        };
        artifactStore.put(record, streamContent);
        artifact = record;
      }

      const obs: ToolObservation = {
        toolCallId,
        tool: toolCall.name,
        argsSummary: argsSummaryFor(toolCall.arguments),
        status: isError ? "error" : (details.status ?? "ok"),
        ...(details.exit !== undefined ? { exitCode: details.exit } : {}),
        durationMs: details.durationMs ?? 0,
        // This excerpt is internal bookkeeping only (journal + recent-activity
        // summaries for Pulse/Steer) — it must never be reused as a
        // presentation bound for what's actually delivered to the model.
        excerpt: fullText.slice(0, EXCERPT_CAP),
        truncated: details.truncated ?? fullText.length > EXCERPT_CAP,
      };
      recorder.recordAction(hashAction({ tool: obs.tool, args: obs.argsSummary }), actionLabel(obs.tool, obs.argsSummary));

      // Shared by both Focus and sanitize/verify below — one bounded intent
      // string, not two independently-phrased ones.
      const intent = `${toolCall.name} ${JSON.stringify(toolCall.arguments)}`;

      const effectiveFocus = mode("focus", options.focusMode === "on" ? "active" : (options.focusMode ?? "off"));
      const focusRollout: FocusRolloutMode = effectiveFocus === "active" ? "on" : effectiveFocus;
      const reviewed = await processOutput(
        {
          capture: {
            kind: "captured",
            sourceId: artifact?.artifactId ?? toolCallId,
            stream: "output",
            text: fullText,
            ...(artifact && details.stdoutText !== undefined && fullText === details.stdoutText + (details.stderrText ?? "")
              ? {
                  segments: [
                    { stream: "stdout", start: 0, end: Buffer.byteLength(details.stdoutText), sourceStart: 0 },
                    { stream: "stderr", start: Buffer.byteLength(details.stdoutText), end: Buffer.byteLength(fullText), sourceStart: 0 },
                  ],
                }
              : {}),
            completeness: artifact ? (artifact.captureComplete ? "complete" : "limited") : "complete",
            ...(artifact
              ? {
                  recovery: {
                    sessionId: recorder.sessionId,
                    sourceId: artifact.artifactId,
                    instructions: "use read_output or search_output to recover the rest.",
                  },
                }
              : {}),
          },
          task: taskText(),
          action: intent,
          status: obs.status,
          recent: recorder.recentActivity(5),
          focus: artifact ? (focusRollout === "on" ? "active" : focusRollout) : "off",
          nonTextCount,
          signal: pluginSignal,
          sanitize: mode("sanitize"),
          verify: mode("verify"),
          fallback: artifact ? (text) => presentArtifact(text, artifact.artifactId, { rollout: "off" }) : undefined,
        },
        {
          focus: (input, opts) => timedJev(() => engine.focus(input, opts)),
          observe: (input, opts) => timedJev(() => engine.observeToolResult(input, opts)),
        },
      );
      const manifest = reviewed.manifest;
      const focusDecision = reviewed.focusDecision;
      if (focusDecision) options.onReflex?.(render("focus", focusDecision.mode, focusDecision.reasons));
      if (reviewed.sanitize) options.onReflex?.(render("sanitize", reviewed.sanitize.action, reviewed.sanitize.reasons));
      if (reviewed.verify && (reviewed.verify.action === "mismatch" || !reviewed.verify.verified))
        options.onReflex?.(render("verify", reviewed.verify.verified ? reviewed.verify.action : "unavailable", reviewed.verify.reasons));
      let deliveredExcerpt = reviewed.text;
      const deliveredTruncated = reviewed.presented.omitted;
      const deliveredWhy = reviewed.why;

      // "(no output)" is presentation wording only — the artifact above (if
      // any) already stored the true, possibly-empty capture. Substituted
      // here, at delivery time, never baked into a tool's own returned text.
      if (!isError && nonTextCount === 0 && deliveredExcerpt.length === 0) {
        deliveredExcerpt = "(no output)";
      }

      if (artifact) {
        journal.append({
          t: "artifacts",
          v: 2,
          artifactId: artifact.artifactId,
          ts: Date.now(),
          toolCallId,
          contentHash: artifact.contentHash,
          captureComplete: artifact.captureComplete,
          byteCount: artifact.byteCount,
          presentedViewHash: contentHash(deliveredExcerpt),
          ...(manifest !== undefined ? { sectionManifestHash: manifest.catalogHash } : {}),
          ...(focusDecision !== undefined
            ? {
                focusRollout: (focusRollout === "on" ? "on" : "shadow") as "on" | "shadow",
                focusMode: focusDecision.mode,
                focusStatus: focusDecision.status,
              }
            : {}),
        });
      }

      emitObservation(obs, deliveredExcerpt, deliveredTruncated, deliveredWhy);

      if (deliveredExcerpt !== fullText || nonTextCount > 0) {
        // isError is intentionally omitted here: the framework preserves the
        // original error flag unless explicitly overridden, and content
        // review must never itself flip an ok result into an error or vice
        // versa.
        return {
          content: [
            { type: "text", text: deliveredExcerpt },
            ...(mode("sanitize") !== "active" && mode("verify") !== "active" ? rawContent.filter((c) => c.type !== "text") : []),
          ],
        } as never;
      }
      return undefined;
    },
  });

  const abortAgent = () => agent.abort();
  pluginSignal.addEventListener("abort", abortAgent, { once: true });

  agent.subscribe((event) => {
    if (event.type === "message_end") {
      const message = event.message as {
        role: string;
        content: { type: string; text?: string }[];
        model?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
      };
      if (message.role === "assistant") {
        if (modelStartedAt > 0) turnModelMs += performance.now() - modelStartedAt;
        const usage = message.usage;
        const cost = usage?.cost?.total;
        const costTotal: number | "unknown" = typeof cost === "number" && cost > 0 ? cost : "unknown";
        recorder.recordModelCall();
        recorder.recordCost(costTotal);
        journal.append({
          t: "llm_call",
          v: 2,
          turnId: recorder.currentTurnId ?? "",
          ts: Date.now(),
          model: message.model ?? "unknown",
          durationMs: Math.round(performance.now() - modelStartedAt),
          usage: {
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            cacheRead: usage?.cacheRead ?? 0,
            cacheWrite: usage?.cacheWrite ?? 0,
            costTotal,
          },
          ...(firstTokenAt !== undefined ? { firstTokenMs: Math.round(firstTokenAt) } : {}),
        });
      }
    } else if (event.type === "message_update") {
      const update = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (update?.type === "text_delta" && update.delta) {
        if (firstTokenAt === undefined && modelStartedAt > 0) firstTokenAt = performance.now() - modelStartedAt;
        options.onDelta?.(update.delta);
      }
    }
  });

  return {
    agent,
    engine,
    journal,
    recorder,
    journalPath: options.journalPath,
    approvalsRequested: () => approvalsRequestedCount,
    async prompt(text: string) {
      if (pluginSignal.aborted) throw new Error("harness session cancelled or ended");
      recorder.startTask(text);
      engine.resetTask();
      turnJevMs = 0;
      turnModelMs = 0;
      recorder.beginTurn();
      try {
        if (mode("messageGate", "off") !== "off") {
          const decision = await timedJev(() =>
            engine.messageGate(
              { message: text, task: taskText(), constraints: options.messageConstraints ?? [] },
              { signal: pluginSignal },
            ),
          );
          options.onReflex?.(render("message_gate", decision.action, decision.reasons));
          if (mode("messageGate", "off") === "active") {
            if (decision.action === "deny") throw new Error(`[brainstem] message denied: ${decision.reasons.join("; ")}`);
            if (decision.action === "ask") {
              const blocked = await runApproval(newId("message"), "message", { message: text }, decision.reasons, pluginSignal, {
                changeSummary: boundForReview(text).text,
              });
              if (blocked) throw new Error(blocked.reason);
            }
          }
        }
        // Initial capability selection for this task. Done here rather than before
        // Agent construction because the objective is only known at prompt time.
        const initialDecision = await driver.refresh({ task: taskText(), recent: [] }, { reason: "initial" });
        const refreshedWs = registry.workingSet(
          {},
          initialDecision && { evaluated: initialDecision.evaluated, recommended: initialDecision.recommended },
        );
        const refreshedBuilt = buildActiveContext(registry, refreshedWs);
        agent.state.tools = refreshedBuilt.tools;
        if (refreshedBuilt.instructionBlock !== undefined && refreshedBuilt.instructionHash !== appliedInstructionHash) {
          const skillMessage: Message = { role: "system", content: refreshedBuilt.instructionBlock, timestamp: Date.now() };
          agent.state.messages = [...agent.state.messages, skillMessage];
        }
        appliedIdsKey = refreshedBuilt.activeIds.join(",");
        appliedInstructionHash = refreshedBuilt.instructionHash;
        lastTaskRevision = recorder.currentTask?.revision ?? 0;

        if (pluginSignal.aborted) throw new Error("message preparation cancelled");
        await agent.prompt(text);
      } finally {
        const spans: TurnSpans = {};
        if (turnJevMs > 0) spans.jevMs = Math.round(turnJevMs);
        if (turnModelMs > 0) spans.modelMs = Math.round(turnModelMs);
        recorder.endTurn(Object.keys(spans).length > 0 ? spans : undefined);
      }
    },
    endSession(reason: "normal" | "error" = "normal", error?: string) {
      lifecycle.abort();
      pluginSignal.removeEventListener("abort", abortAgent);
      recorder.endSession(reason, error);
    },
  };
}

type AgentEventLike = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: { role: string; content: { type: string; text?: string }[]; model?: string; usage?: { cost?: { total?: number } } };
  assistantMessageEvent?: { type: string; delta?: string };
};
