import type { Agent, AgentTool, AgentMessage, BeforeToolCallContext, AfterToolCallContext } from "@earendil-works/pi-agent-core";
import {
  createPluginSession,
  waitForHost,
  boundForReview,
  type Reflexes,
  type PluginSessionOptions,
  type CapabilityContext,
  type CapabilityRecommendation,
  type CapturedOutput,
  type MessageGateInput,
  type GateReview,
  type ExistingActionApproval,
} from "@brainstem/reflexes";

const DEFAULT_CAPTURED_TOOLS = new Set(["bash", "read", "write", "grep", "glob", "read_output", "search_output"]);
export interface AttachReflexesOptions extends PluginSessionOptions {
  cwd: string;
  capturedTools?: Set<string>;
  /** Reuse host authorization for this exact invocation when Gate asks.
   * Return unknown to use approve(); denied never opens a second prompt.
   * Host denials and Gate denials remain authoritative.
   */
  resolveActionApproval?: (review: GateReview & { toolCallId: string }, signal: AbortSignal) => Promise<ExistingActionApproval>;
  taskText?: () => string;
  recentActivity?: () => string[];
  /** Compatibility option. Prefer modes.focus; selection without recovery remains opt-in. */
  focusMode?: "off" | "on";
  onReflex?: (line: string) => void;
  /** The host supplies descriptions and loads approved schemas/skill instructions. */
  capabilities?: () => CapabilityContext;
  /** Load data first; the adapter applies it only while the message revision is current. */
  loadCapabilities?: (
    recommendation: CapabilityRecommendation,
    signal: AbortSignal,
  ) => Promise<{ tools: AgentTool[]; skillInstructions?: string }>;
  actionEvidence?: (
    context: BeforeToolCallContext,
    signal: AbortSignal,
  ) => Promise<{ changeSummary?: string; evidenceIncomplete?: boolean }>;
  /** Metadata must describe the effective content after existing host hook transformations. */
  outputSource?: (context: AfterToolCallContext, text: string, signal: AbortSignal) => CapturedOutput | Promise<CapturedOutput>;
  /** Host-approved alternative only. Its compatibility, credentials and budgets belong to the host. */
  miniModel?: Agent["state"]["model"];
  pulseEveryTurns?: number;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/**
 * Composes tool, progress and routing hooks. Incoming user messages require the
 * returned handle.prompt()/prepareMessage(); direct agent.prompt/steer/followUp
 * calls are not intercepted. The host owns execution and permissions.
 */
export function attachReflexes(agent: Agent, reflexes: Reflexes, options: AttachReflexesOptions) {
  if (options.modes?.select && options.modes.select !== "off" && !options.capabilities)
    throw new Error("Select requires a host capability catalog");
  if (options.pulseEveryTurns !== undefined && (!Number.isInteger(options.pulseEveryTurns) || options.pulseEveryTurns < 1))
    throw new Error("pulseEveryTurns must be a positive integer");
  const session: ReturnType<typeof createPluginSession> = createPluginSession(reflexes, {
    ...options,
    modes: {
      focus: options.focusMode === "on" ? "active" : "off",
      ...options.modes,
    },
  });
  const capturedTools = options.capturedTools ?? DEFAULT_CAPTURED_TOOLS;
  const taskText = () => options.taskText?.() ?? session.task;
  let disposed = false;
  let turns = 0;
  let appliedCatalog: string | undefined;
  let skillMessage: AgentMessage | undefined;
  const report = (name: string, action: string, reasons: string[] = []) =>
    options.onReflex?.(`[${name}] ${action}${reasons[0] ? ` — ${reasons[0]}` : ""}`);

  const originalBefore = agent.beforeToolCall;
  const before: NonNullable<Agent["beforeToolCall"]> = async (context, signal) => {
    if (disposed || !capturedTools.has(context.toolCall.name)) return originalBefore?.(context, signal);
    const scope = session.scope(signal);
    if (!scope.current()) return { block: true, reason: "[brainstem] action cancelled" };
    const identityOf = () => JSON.stringify({ toolCall: context.toolCall, args: context.args });
    const identity = identityOf();
    const toolCallId = context.toolCall.id;
    const snapshot = structuredClone(context.args ?? {}) as { command?: string; path?: string };
    // Snapshot before the host's asynchronous approval too. Otherwise changed
    // arguments could be mistaken for the action the host already approved.
    const originalResult = originalBefore ? await waitForHost(() => originalBefore(context, scope.signal), scope.signal) : undefined;
    if (originalResult?.block) return originalResult;
    if (!scope.current() || identity !== identityOf())
      return { block: true, reason: "[brainstem] action changed or cancelled during host review" };
    let evidence: { changeSummary?: string; evidenceIncomplete?: boolean } = {};
    if (session.modes.gate !== "off" && options.actionEvidence) {
      // Give the callback an independent argument snapshot.
      evidence = await waitForHost(
        () => options.actionEvidence!({ ...context, args: structuredClone(snapshot) }, scope.signal),
        scope.signal,
      );
    }
    const summary = evidence.changeSummary === undefined ? undefined : boundForReview(evidence.changeSummary, 8000);
    const reviewed = await session.reviewAction(
      {
        tool: context.toolCall.name,
        task: taskText(),
        command: context.toolCall.name === "bash" ? snapshot.command : undefined,
        path: snapshot.path,
        arguments: snapshot,
        changeSummary: summary?.text,
        evidenceIncomplete:
          evidence.evidenceIncomplete || summary?.truncated || (context.toolCall.name === "write" && evidence.changeSummary === undefined),
      },
      scope.signal,
      options.resolveActionApproval
        ? async (review, approvalSignal) => {
            if (!scope.current() || identity !== identityOf()) return "denied";
            const resolution = await options.resolveActionApproval!({ ...review, toolCallId }, approvalSignal);
            return scope.current() && identity === identityOf() ? resolution : "denied";
          }
        : undefined,
    );
    if (reviewed.decision) report("gate", reviewed.decision.action, reviewed.decision.reasons);
    if (!scope.current() || identity !== identityOf())
      return { block: true, reason: "[brainstem] action changed or cancelled since review" };
    if (!reviewed.allowed)
      return {
        block: true,
        reason: `[brainstem] ${reviewed.approvalSource === "host" ? "host authorization denied" : reviewed.decision?.action === "deny" ? "denied" : "needs approval"}: ${reviewed.decision?.reasons.join("; ") ?? "unresolved"}`,
      };
    return originalResult;
  };
  agent.beforeToolCall = before;

  const originalAfter = agent.afterToolCall;
  const after: NonNullable<Agent["afterToolCall"]> = async (context, signal) => {
    const originalResult = await originalAfter?.(context, signal);
    if (disposed || !capturedTools.has(context.toolCall.name)) return originalResult;
    const scope = session.scope(signal);
    const content = originalResult?.content ?? context.result.content;
    const text = textOf(content);
    const nonTextCount = content.filter((c) => c.type !== "text").length;
    if (!text.trim() && nonTextCount === 0) return originalResult;
    const supplied = options.outputSource
      ? await waitForHost(() => Promise.resolve(options.outputSource!(context, text, scope.signal)), scope.signal)
      : undefined;
    if (supplied && supplied.text !== text) throw new Error("host output source does not describe the effective tool result");
    if (supplied?.recovery && supplied.recovery.sessionId !== session.sessionId) throw new Error("foreign output recovery reference");
    const details = context.result.details as { truncated?: boolean } | undefined;
    const capture: CapturedOutput = supplied ?? {
      kind: "captured",
      sourceId: context.toolCall.id,
      stream: "output",
      text,
      completeness: details?.truncated === true ? "limited" : "unknown",
    };
    const result = await reflexes.processOutput({
      capture,
      task: taskText(),
      action: `${context.toolCall.name} ${JSON.stringify(context.args)}`.slice(0, 300),
      status: (originalResult?.isError ?? context.isError) ? "error" : "ok",
      recent: options.recentActivity?.(),
      focus: session.modes.focus,
      sanitize: session.modes.sanitize,
      verify: session.modes.verify,
      nonTextCount,
      signal: scope.signal,
      context: { taskId: scope.taskId, revision: scope.revision },
    });
    if (!scope.current()) throw new Error("stale output result");
    if (result.focusDecision) {
      report("focus", result.focusDecision.mode, result.focusDecision.reasons);
      session.applied("focus", session.modes.focus);
    }
    if (result.sanitize) {
      report("sanitize", result.sanitize.action, result.sanitize.reasons);
      session.applied("sanitize", session.modes.sanitize === "active" ? result.sanitize.action : "shadow");
    }
    if (result.verify) {
      report("verify", result.verify.action, result.verify.reasons);
      session.applied("verify", session.modes.verify === "active" ? result.verify.action : "shadow");
    }
    const reviewedNonText = session.modes.sanitize === "active" || session.modes.verify === "active";
    if (result.text === text && (!nonTextCount || !reviewedNonText)) return originalResult;
    return {
      ...originalResult,
      content: [{ type: "text" as const, text: result.text }, ...(!reviewedNonText ? content.filter((c) => c.type !== "text") : [])],
    };
  };
  agent.afterToolCall = after;

  const originalStop = agent.shouldStopAfterTurn;
  const stop: NonNullable<Agent["shouldStopAfterTurn"]> = async (context, signal) => {
    if (await originalStop?.(context, signal)) return true;
    // A final answer has no tool progress to assess. Injecting a new user turn
    // here can restart an already completed task and consume another model call.
    if (context.toolResults.length === 0) return false;
    if (disposed || ++turns % (options.pulseEveryTurns ?? 3) !== 0) return false;
    const scope = session.scope(signal);
    const decision = await session.checkpoint(
      { task: taskText(), events: options.recentActivity?.() ?? context.toolResults.map((r) => textOf(r.content)), budget: "host-owned" },
      scope.signal,
    );
    if (!scope.current() || !decision) return false;
    report("pulse", decision.action, decision.reasons);
    if (decision.action === "intervene")
      agent.steer({
        role: "user",
        content: `[brainstem] reflex intervention: ${decision.reasons.join("; ")}. Reassess your approach.`,
        timestamp: Date.now(),
      });
    session.applied("pulse", decision.action);
    return decision.action === "stop";
  };
  agent.shouldStopAfterTurn = stop;

  const originalStream = agent.streamFunction;
  const stream: Agent["streamFunction"] = async (model, context, streamOptions) => {
    if (disposed || session.modes.steer === "off") return originalStream(model, context, streamOptions);
    const scope = session.scope(streamOptions?.signal);
    const decision = await session.route({ task: taskText(), events: options.recentActivity?.() ?? [] }, scope.signal);
    if (!scope.current()) throw new Error("routing cancelled");
    const chosen = decision?.tier === "mini" && options.miniModel ? options.miniModel : model;
    if (decision) report("steer", decision.tier, decision.reasons);
    session.applied("steer", chosen.id);
    return originalStream(chosen, context, streamOptions);
  };
  agent.streamFunction = stream;

  async function prepareMessage(input: MessageGateInput & { taskId?: string }, signal?: AbortSignal) {
    const capabilities = options.capabilities?.();
    const catalogIdentity = JSON.stringify(capabilities);
    const prepared = await session.prepareMessage({ ...input, taskId: input.taskId ?? "conversation", capabilities }, signal);
    if (!prepared.isCurrent()) throw new Error("message preparation stale");
    const scope = session.scope(signal);
    if (prepared.allowed && prepared.recommendation) {
      const key = JSON.stringify([prepared.recommendation.catalogHash, prepared.recommendation.ids]);
      if (key !== appliedCatalog) {
        const loaded = options.loadCapabilities
          ? await waitForHost(() => options.loadCapabilities!(prepared.recommendation!, scope.signal), scope.signal)
          : {
              tools: agent.state.tools,
              skillInstructions: `[brainstem] Suggested host-available capabilities: ${prepared.recommendation.ids.join(", ") || "no additions"}. Missing explicit capabilities: ${prepared.recommendation.missingExplicit.join(", ") || "none"}. Relevance does not grant permission to use them.`,
            };
        if (!scope.current()) throw new Error("capability application cancelled");
        if (JSON.stringify(options.capabilities?.()) !== catalogIdentity) throw new Error("capability catalog changed during loading");
        agent.state.tools = loaded.tools;
        const messages = agent.state.messages.filter((m) => m !== skillMessage);
        skillMessage = loaded.skillInstructions ? { role: "system", content: loaded.skillInstructions, timestamp: Date.now() } : undefined;
        agent.state.messages = skillMessage ? [...messages, skillMessage] : messages;
        appliedCatalog = key;
      }
      session.applied("select", `${options.loadCapabilities ? "loaded" : "suggested"}: ${prepared.recommendation.ids.join(",")}`);
    }
    return prepared;
  }
  return {
    session: session,
    capabilities: {
      messages: "explicit-wrapper",
      tools: "hooks",
      progress: "after-turn",
      routing: "before-model-call",
      recovery: !!options.outputSource,
    } as const,
    prepareMessage,
    async prompt(
      message: string,
      input: { task?: string; taskId?: string; constraints?: string[]; evidence?: MessageGateInput["evidence"]; signal?: AbortSignal } = {},
    ) {
      const prepared = await prepareMessage(
        { message, task: input.task ?? message, taskId: input.taskId, constraints: input.constraints ?? [], evidence: input.evidence },
        input.signal,
      );
      if (!prepared.allowed) throw new Error(`[brainstem] message ${prepared.decision?.action === "deny" ? "denied" : "needs approval"}`);
      if (!prepared.isCurrent()) throw new Error("message preparation stale");
      // Main-agent cancellation is an explicit host adapter responsibility.
      const onAbort = () => agent.abort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await agent.prompt(message);
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
    dispose() {
      disposed = true;
      session.dispose();
      if (agent.beforeToolCall === before) agent.beforeToolCall = originalBefore;
      if (agent.afterToolCall === after) agent.afterToolCall = originalAfter;
      if (agent.shouldStopAfterTurn === stop) agent.shouldStopAfterTurn = originalStop;
      if (agent.streamFunction === stream) agent.streamFunction = originalStream;
    },
  };
}
