import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { socketPath } from "../src/socket";

const pluginDir = join(import.meta.dir, "..");
// Not os.tmpdir(): macOS's long TMPDIR pushes the nested socket path past the ~104-byte limit.
const root = mkdtempSync("/tmp/brainstem-verify-");
const plugin = join(root, "plugin");
const project = join(root, "project");
const sessionId = "verify-build-session";

if (!existsSync(join(pluginDir, "dist/hook/pre-tool-use.mjs"))) {
  console.error("packages/claude-plugin/dist is missing; run `bun run build` first.");
  process.exit(1);
}

// Copy what an install copies, so the run proves the build is self-contained.
for (const entry of [".claude-plugin", "hooks", "package.json", "dist"])
  cpSync(join(pluginDir, entry), join(plugin, entry), { recursive: true });
mkdirSync(project);

const { TYPESAFE_API_KEY: _ignoredApiKey, ...inheritedEnv } = process.env;
const env = {
  ...inheritedEnv,
  CLAUDE_PLUGIN_ROOT: plugin,
  CLAUDE_PROJECT_DIR: project,
  XDG_RUNTIME_DIR: join(root, "run"),
  BRAINSTEM_JUDGE_MODULE: join(import.meta.dir, "fixed-judge.mjs"),
};
const socket = socketPath(sessionId, env);

function runHook(entry: string, payload: Record<string, unknown>) {
  const run = spawnSync("node", [join(plugin, "dist/hook", `${entry}.mjs`)], {
    input: JSON.stringify({ session_id: sessionId, cwd: project, ...payload }),
    env,
    cwd: project,
    encoding: "utf8",
    timeout: 20_000,
  });
  const stdout = run.stdout.trim();
  return {
    entry,
    payload,
    status: run.status,
    stdout: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {},
    stderr: run.stderr.trim(),
  };
}

const preToolUse = (tool_name: string, tool_input: Record<string, unknown>) =>
  runHook("pre-tool-use", {
    hook_event_name: "PreToolUse",
    permission_mode: "default",
    tool_name,
    tool_input,
    tool_use_id: `toolu_${tool_name}`,
  });

const decisionOf = (run: ReturnType<typeof runHook>) =>
  (run.stdout.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;

const sessionStart = runHook("session-start", { hook_event_name: "SessionStart", source: "startup" });
const daemonStarted = existsSync(socket);
const bash = preToolUse("Bash", { command: "echo verify-build", description: "Echo a test string" });
const outsideWrite = preToolUse("Write", { file_path: "/etc/brainstem-verify", content: "x" });
const sessionEnd = runHook("session-end", { hook_event_name: "SessionEnd", reason: "other" });

const checks = {
  "SessionStart exits 0 without a startup warning": sessionStart.status === 0 && !sessionStart.stdout.systemMessage,
  "SessionStart spawns the daemon socket": daemonStarted,
  // A judge without confidence can never auto-approve, so a routine command defers to the host's rules.
  "PreToolUse Bash reaches the daemon and defers to the host": bash.status === 0 && Object.keys(bash.stdout).length === 0,
  "PreToolUse Write to /etc is denied by the static floor": outsideWrite.status === 0 && decisionOf(outsideWrite) === "deny",
  "SessionEnd removes the daemon socket": sessionEnd.status === 0 && !existsSync(socket),
};

const daemonLogPath = socket.replace(/\.sock$/, ".log");
const evidencePath = join(root, "evidence.json");
writeFileSync(
  evidencePath,
  `${JSON.stringify({ checks, runs: [sessionStart, bash, outsideWrite, sessionEnd], daemonLog: existsSync(daemonLogPath) ? readFileSync(daemonLogPath, "utf8") : null }, null, 2)}\n`,
);

for (const [name, passed] of Object.entries(checks)) console.log(`${passed ? "pass" : "FAIL"}  ${name}`);
console.log(`evidence: ${evidencePath}`);
if (Object.values(checks).includes(false)) process.exit(1);
