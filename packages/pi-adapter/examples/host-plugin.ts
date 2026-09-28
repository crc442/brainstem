import type { Agent } from "@earendil-works/pi-agent-core";
import { hashAction } from "@brainstem/core";
import { createReflexes, type SystemOne, type JudgmentEvent } from "@brainstem/reflexes";
import { attachReflexes, type AttachReflexesOptions } from "../src";

type Invocation = { toolCallId: string; sessionId: string; revision: number };
type Action = { tool: string; arguments: unknown };

/** One ledger per installed plugin. Only the host's explicit permission flow records receipts. */
export function createHostAuthorizations() {
  const receipts = new Map<string, Invocation & { actionHash: string }>();
  const resolveActionApproval: NonNullable<AttachReflexesOptions["resolveActionApproval"]> = async (review, signal) => {
    const receipt = receipts.get(review.toolCallId);
    receipts.delete(review.toolCallId); // Consume before checking; mismatches cannot be retried.
    if (
      signal.aborted ||
      !receipt ||
      receipt.sessionId !== review.sessionId ||
      receipt.revision !== review.revision ||
      !("tool" in review.subject)
    )
      return "unknown";
    const actionHash = hashAction({ tool: review.subject.tool, arguments: review.subject.arguments });
    return receipt.actionHash === actionHash ? "approved" : "unknown";
  };
  return {
    // Hash the snapshot the host actually approved, including full write contents.
    recordApproved(invocation: Invocation, action: Action) {
      receipts.set(invocation.toolCallId, { ...invocation, actionHash: hashAction(action) });
    },
    forget(toolCallId: string) {
      receipts.delete(toolCallId);
    },
    clear() {
      receipts.clear();
    },
    resolveActionApproval,
  };
}

/** The host supplies execution, permissions, capability loading and optional recovery. */
export function installBrainstem(
  agent: Agent,
  host: Pick<
    AttachReflexesOptions,
    | "cwd"
    | "capabilities"
    | "loadCapabilities"
    | "actionEvidence"
    | "approve"
    | "resolveActionApproval"
    | "outputSource"
    | "miniModel"
    | "recentActivity"
  > & {
    judge: SystemOne;
    onJudgment?: (event: JudgmentEvent) => void;
  },
) {
  const reflexes = createReflexes({
    judge: host.judge,
    root: host.cwd,
    maxJudgmentCalls: 100,
    onJudgment: host.onJudgment,
  });
  return attachReflexes(agent, reflexes, {
    ...host,
    modes: {
      select: host.capabilities ? "active" : "off",
      focus: "shadow", // Measure first; activate when the host's recovery path is ready.
      messageGate: "active",
      gate: "active",
      sanitize: "active",
      verify: "active",
      pulse: "active",
      steer: host.miniModel ? "active" : "off",
    },
    gateBehavior: "enforce",
  });
}

// Connect the host's existing authorization flow BEFORE installing Brainstem:
// const authorizations = createHostAuthorizations();
// agent.beforeToolCall = async (context, signal) => {
//   const toolCallId = context.toolCall.id;
//   authorizations.forget(toolCallId); // Clear any receipt if an ID is reused.
//   const scope = plugin.session.scope(signal);
//   const action = { tool: context.toolCall.name, arguments: structuredClone(context.args ?? {}) };
//   // authorize is the host's permission rule/UI, not a second Brainstem prompt.
//   if (!await authorize(action, scope.signal)) return { block: true, reason: "host denied" };
//   if (!scope.current()) return { block: true, reason: "stale host authorization" };
//   authorizations.recordApproved({ toolCallId, sessionId: plugin.session.sessionId, revision: scope.revision }, action);
// };
// const plugin = installBrainstem(agent, { ...host, resolveActionApproval: authorizations.resolveActionApproval });
// await plugin.prompt("Fix the failing login test", {
//   taskId: "login-fix", constraints: ["Do not publish changes"], signal,
// });
// In the host's existing afterToolCall hook, forget(context.toolCall.id) to clean
// up receipts that Gate didn't consume. On task teardown/disposal, clear the ledger.
// authorizations.clear();
// plugin.dispose(); // Detaches Brainstem; the host owns stopping its agent.
// Keep file-precondition checks in host execution. If Gate raises a new concern
// the receipt doesn't cover, the host's resolver must return "unknown" instead.
