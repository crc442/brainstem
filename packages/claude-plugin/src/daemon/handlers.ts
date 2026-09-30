import { staticVerdict } from "@brainstem/core";
import { REVIEW_CHAR_CAP, type PluginSession, type Reflexes } from "@brainstem/reflexes";
import type { PluginConfig } from "../config";
import { INTERACTIVE_TOOLS, toGateInput } from "../tools";
import type { Request, Response, ReviewActionResponse } from "../protocol";
import { buildWrapperCommand } from "../output/command";
import { detectFamily, filterOutput } from "../output/families";

export interface DaemonState {
  reflexes: Reflexes;
  session: PluginSession;
  config: PluginConfig;
  root: string;
  socket: string;
  environmentComplete: boolean;
  environmentTotalChars: number;
  /** The bundled brainstem-output entry the wrapper runs (Task 14). */
  filterPath: string;
  task: string;
  /** PostToolBatch count and the count at the last Pulse checkpoint (Task 17). */
  toolTurns: number;
  checkpointedAt: number;
  recent: string[];
  /** Tool-use ids and wrapped command strings awaiting their post-call event (Task 17). */
  wrapped: Set<string>;
  /** Tool-use ids with a recorded outcome, so a batch can name calls that never reported one (Task 17). */
  observed: Set<string>;
  onShutdown: () => void;
}

const skip = (state: DaemonState, reasons: string[] = []): ReviewActionResponse => ({
  kind: "reviewAction",
  action: "skip",
  reasons,
  mode: state.config.modes.gate,
});

export async function handle(request: Request, state: DaemonState): Promise<Response> {
  switch (request.kind) {
    case "ping":
      return { kind: "ping" };
    case "reviewAction": {
      const { modes, classifyAllShell } = state.config;
      // A hook decision on an interactive tool, or in plan mode, could answer or skip
      // a prompt the user must see.
      if (modes.gate === "off") return skip(state);
      if (request.permissionMode === "plan" || INTERACTIVE_TOOLS.has(request.tool)) return skip(state);

      if (!state.environmentComplete) {
        const reason = `policy evidence exceeds the ${REVIEW_CHAR_CAP}-character review limit (${state.environmentTotalChars} characters); shorten the policy before using active Gate`;
        if (modes.gate === "active") {
          return { kind: "reviewAction", action: "deny", reasons: [reason], mode: modes.gate };
        }
        return skip(state, [reason]);
      }

      const gateInput = toGateInput(request.tool, request.input, request.task || state.task);
      const reviewed = await state.session.reviewAction(gateInput);
      if (modes.gate === "shadow") return skip(state);

      const decision = reviewed.decision?.action ?? "ask";
      const floor = staticVerdict(gateInput.tool, { command: gateInput.command, path: gateInput.path }, state.root);
      // A judged ask defers: the harness prompts unless the user's own rules or
      // permission mode already authorize the call. That is the Pi adapter's
      // composition, where host authorization lifts an ask but never a deny.
      // A floor ask, or a shell ask under classifyAllShell, must prompt over those rules.
      const mustPrompt = floor === "ask" || (classifyAllShell && gateInput.tool === "bash");
      const response: ReviewActionResponse = {
        kind: "reviewAction",
        action: decision === "ask" && !mustPrompt ? "skip" : decision,
        reasons: reviewed.decision?.reasons ?? [],
        mode: modes.gate,
      };
      const command = request.input.command;
      const outputReviewActive = modes.sanitize === "active" || modes.verify === "active";
      if (
        response.action === "auto" &&
        modes.gate === "active" &&
        outputReviewActive &&
        request.tool === "Bash" &&
        typeof command === "string" &&
        request.toolUseId
      ) {
        const wrapped = buildWrapperCommand({
          command,
          executable: process.execPath,
          entry: state.filterPath,
          socket: state.socket,
          toolUseId: request.toolUseId,
        });
        if (wrapped) response.wrap = { command: wrapped };
      }
      return response;
    }
    case "prepareMessage": {
      state.task = request.message;
      const prepared = await state.session.prepareMessage({
        message: request.message,
        task: request.message,
        constraints: [],
        taskId: request.taskId,
      });
      const decision = state.config.modes.messageGate === "active" ? prepared.decision?.action : undefined;
      return {
        kind: "prepareMessage",
        action: decision ?? "skip",
        reasons: prepared.decision?.reasons ?? [],
        recommendedIds: prepared.recommendation?.ids,
      };
    }
    case "observe": {
      // Hook observations arrive after their output entered context and are advisory
      // only. The wrapper path is the only path that can withhold source text.
      if (request.source !== "wrapper") return { kind: "observe" };
      const scope = state.session.scope();
      const reviewed = await state.reflexes.processOutput({
        capture: {
          kind: "captured",
          sourceId: request.toolUseId ?? "unknown-call",
          stream: "stdout+stderr",
          text: request.text,
          completeness: request.complete ? "complete" : "limited",
        },
        task: state.session.task || state.task,
        action: request.command ?? request.action,
        status: request.status,
        sanitize: state.config.modes.sanitize,
        verify: state.config.modes.verify,
        signal: scope.signal,
        context: { taskId: scope.taskId, revision: scope.revision },
        fallback: (text) => {
          const family = detectFamily(request.command ?? request.action);
          const selected = filterOutput(family, text);
          return { text: selected, truncated: selected !== text };
        },
      });
      return {
        kind: "observe",
        text: reviewed.text,
        sanitize: reviewed.sanitize ? { action: reviewed.sanitize.action, reasons: reviewed.sanitize.reasons } : undefined,
        verify: reviewed.verify ? { action: reviewed.verify.action, reasons: reviewed.verify.reasons } : undefined,
      };
    }
    case "batch":
      // Pulse's tool-turn cadence lands in Task 17.
      return { kind: "batch" };
    case "checkpoint":
      return { kind: "checkpoint" };
    case "shutdown":
      state.onShutdown();
      return { kind: "shutdown" };
  }
}
