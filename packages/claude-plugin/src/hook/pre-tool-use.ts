import { readStdin, runIfEntry, sessionIdOf, writeHookOutput, type HookOutput } from "./io";
import { requestSession } from "./launch";
import type { Response } from "../protocol";

const DECISION = { auto: "allow", ask: "ask", deny: "deny" } as const;

export function renderPreToolUse(response: Response | undefined, toolInput: Record<string, unknown> = {}): HookOutput {
  if (response === undefined || response.kind === "error") {
    const detail = response?.kind === "error" ? ` (${response.message})` : "";
    return { systemMessage: `brainstem is unavailable${detail}; Claude Code's own permission rules apply.` };
  }
  if (response.kind !== "reviewAction" || response.action === "skip") return {};

  const permissionDecision = DECISION[response.action];
  // A rewrite is re-matched against permission rules, so it can only ride along
  // with an explicit allow. Verified against Claude Code 2.1.236.
  const wrap = response.wrap && permissionDecision === "allow" ? response.wrap : undefined;
  const reasons = response.reasons.length > 0 ? `brainstem: ${response.reasons.join("; ")}` : "brainstem judgment";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      // The displayed command differs from the one that runs, so say so where the user looks.
      permissionDecisionReason: wrap ? `${reasons} (command wrapped for brainstem output review)` : reasons,
      ...(wrap ? { updatedInput: { ...toolInput, command: wrap.command } } : {}),
    },
  };
}

export async function main(): Promise<void> {
  const payload = await readStdin();
  const sessionId = sessionIdOf(payload);
  // Without a session id there is no socket to address, so the hook has no opinion.
  if (!sessionId) return;
  const input = (payload.tool_input as Record<string, unknown>) ?? {};
  const response = await requestSession(sessionId, {
    kind: "reviewAction",
    tool: String(payload.tool_name ?? ""),
    input,
    task: "",
    permissionMode: typeof payload.permission_mode === "string" ? payload.permission_mode : undefined,
    toolUseId: typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined,
  });
  writeHookOutput(renderPreToolUse(response, input));
}

runIfEntry(import.meta.url, main);
