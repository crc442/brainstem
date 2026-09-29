import { staticVerdict } from "@brainstem/core";
import type { PluginSession, Reflexes } from "@brainstem/reflexes";
import type { PluginConfig } from "../config";
import { INTERACTIVE_TOOLS, toGateInput } from "../tools";
import type { Request, Response, ReviewActionResponse } from "../protocol";

export interface DaemonState {
  reflexes: Reflexes;
  session: PluginSession;
  config: PluginConfig;
  root: string;
  socket: string;
  /** Claude Code settings files whose deny/ask rules the prefilter reads (Task 8a). */
  settingsFiles: string[];
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
      if (modes.gate === "off" || request.permissionMode === "plan" || INTERACTIVE_TOOLS.has(request.tool)) return skip(state);

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
      return {
        kind: "reviewAction",
        action: decision === "ask" && !mustPrompt ? "skip" : decision,
        reasons: reviewed.decision?.reasons ?? [],
        mode: modes.gate,
      };
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
    case "observe":
      // Output review lands in Task 13, per-call outcomes in Task 17.
      return { kind: "observe" };
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
