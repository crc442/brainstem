import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface HookOutput {
  systemMessage?: string;
  continue?: boolean;
  stopReason?: string;
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

export async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Malformed input gets no opinion from this hook; the harness still applies its rules.
    return {};
  }
}

export function writeHookOutput(output: HookOutput): void {
  if (Object.keys(output).length === 0) return;
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

export const sessionIdOf = (payload: Record<string, unknown>): string | undefined =>
  typeof payload.session_id === "string" && payload.session_id ? payload.session_id : undefined;

// Entries are bundled, so shared code may live in a chunk whose import.meta.url is not
// the entry's. Resolve from the plugin root instead: CLAUDE_PLUGIN_ROOT in hooks, and
// the running entry's own location (dist/<dir>/<entry>.mjs) otherwise.
export function distPath(relative: string): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(realpathSync(process.argv[1] ?? ".")), "..", "..");
  return join(root, "dist", relative);
}

// `import.meta.main` is missing before Node 24.2. A hook whose main never runs prints
// nothing, which the harness reads as no opinion: Gate would be silently off.
export function runIfEntry(moduleUrl: string, main: () => Promise<void>): void {
  if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(moduleUrl))) return;
  main().catch((error: unknown) => {
    process.stderr.write(`brainstem: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
