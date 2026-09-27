import type { Agent } from "@earendil-works/pi-agent-core";
import { createReflexes, type SystemOne, type JudgmentEvent } from "@brainstem/reflexes";
import { attachReflexes, type AttachReflexesOptions } from "../src";

/** The host supplies execution, permissions, capability loading and optional recovery. */
export function installBrainstem(
  agent: Agent,
  host: Pick<
    AttachReflexesOptions,
    "cwd" | "capabilities" | "loadCapabilities" | "actionEvidence" | "approve" | "outputSource" | "miniModel" | "recentActivity"
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

// The caller sends incoming user messages through the returned handle:
// const plugin = installBrainstem(agent, host);
// await plugin.prompt("Fix the failing login test", {
//   taskId: "login-fix", constraints: ["Do not publish changes"], signal,
// });
// plugin.dispose(); // Detaches Brainstem; the host owns stopping its agent.
