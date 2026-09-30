import { boundForReview, type GateInput } from "@brainstem/reflexes";

const CHANGE_SUMMARY_CAP = 2_000;

export type ToolInput = Record<string, unknown>;

// A hook decision on these could answer, or skip, a prompt the user must see.
export const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function diff(edits: unknown[]): string | undefined {
  const parts = edits.map((edit) => ({ from: str((edit as ToolInput)?.old_string), to: str((edit as ToolInput)?.new_string) }));
  if (parts.length === 0 || parts.some((part) => part.from === undefined || part.to === undefined)) return undefined;
  return boundForReview(parts.map((part) => `-${part.from}\n+${part.to}`).join("\n"), CHANGE_SUMMARY_CAP).text;
}

function changeSummary(tool: string, input: ToolInput): string | undefined {
  if (tool === "Edit") return diff([input]);
  if (tool === "MultiEdit") return Array.isArray(input.edits) ? diff(input.edits) : undefined;
  if (tool === "Write") {
    const content = str(input.content);
    if (content === undefined) return undefined;
    return boundForReview(`new file contents:\n${content}`, CHANGE_SUMMARY_CAP).text;
  }
  return undefined;
}

export function toGateInput(tool: string, input: ToolInput, task: string): GateInput {
  const base = { arguments: input, task };

  if (tool === "Bash" || tool === "BashOutput") return { ...base, tool: "bash", command: str(input.command) };

  if (WRITE_TOOLS.has(tool)) {
    const summary = changeSummary(tool, input);
    return {
      ...base,
      tool: "write",
      path: str(input.file_path) ?? str(input.notebook_path),
      changeSummary: summary,
      // A write the host cannot describe must not receive an automatic approval.
      evidenceIncomplete: summary === undefined,
    };
  }

  if (tool === "Read") return { ...base, tool: "read", path: str(input.file_path) };
  if (tool === "Grep") return { ...base, tool: "grep", path: str(input.path) };
  if (tool === "Glob") return { ...base, tool: "glob", path: str(input.path) };

  return { ...base, tool: tool.toLowerCase() };
}
