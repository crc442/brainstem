import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginModes, ReflexMode } from "@brainstem/reflexes";

const DEFAULTS_MARKER = "$defaults";

export interface RawConfig {
  allow?: string[];
  soft_deny?: string[];
  hard_deny?: string[];
  environment?: string[];
  trust?: number;
  classifyAllShell?: boolean;
  modes?: Partial<PluginModes>;
  journalPath?: string;
  projects?: Record<string, RawConfig>;
}

export interface PluginConfig {
  allow: string[];
  soft_deny: string[];
  hard_deny: string[];
  environment: string[];
  trust: number;
  classifyAllShell: boolean;
  modes: Required<PluginModes>;
  journalPath?: string;
}

export const DEFAULT_RULES = {
  allow: [
    "Reading, searching, and listing files anywhere inside the project.",
    "Running the project's own test suite, type checker, linter, and formatter.",
    "Local git inspection: status, diff, log, show, branch listing.",
  ],
  soft_deny: [
    "Deleting or overwriting files the project does not track in git.",
    "Rewriting published git history, force-pushing, or discarding uncommitted work.",
    "Publishing packages, deploying, or mutating shared infrastructure.",
  ],
  hard_deny: [
    "Reading, printing, or transmitting credentials, API keys, SSH keys, or .env contents.",
    "Sending project data to a network destination not named in the environment section.",
    "Disabling, editing, or bypassing this project's own safety checks, hooks, or audit logs.",
  ],
  environment: ["A git repository in the current working directory."],
} as const;

const DEFAULT_MODES: Required<PluginModes> = {
  gate: "active",
  sanitize: "active",
  verify: "active",
  messageGate: "off",
  select: "off",
  pulse: "off",
  focus: "off",
  steer: "shadow",
};

const MODES: ReflexMode[] = ["off", "shadow", "active"];

export function mergeRules(user: string[] | undefined, builtins: readonly string[]): string[] {
  if (user === undefined) return [...builtins];
  const out: string[] = [];
  let splicedDefaults = false;
  for (const rule of user) {
    if (rule !== DEFAULTS_MARKER) {
      out.push(rule);
      continue;
    }
    if (splicedDefaults) continue;
    splicedDefaults = true;
    out.push(...builtins);
  }
  return out;
}

export function resolveConfig(raw: RawConfig): PluginConfig {
  const trust = raw.trust ?? 0.3;
  if (!(trust >= 0 && trust <= 1)) throw new Error(`trust must be between 0 and 1, got ${trust}`);

  const modes = { ...DEFAULT_MODES, ...raw.modes };
  for (const [flow, mode] of Object.entries(modes)) {
    if (!MODES.includes(mode as ReflexMode)) throw new Error(`invalid mode "${mode}" for ${flow}`);
  }

  return {
    allow: mergeRules(raw.allow, DEFAULT_RULES.allow),
    soft_deny: mergeRules(raw.soft_deny, DEFAULT_RULES.soft_deny),
    hard_deny: mergeRules(raw.hard_deny, DEFAULT_RULES.hard_deny),
    environment: mergeRules(raw.environment, DEFAULT_RULES.environment),
    trust,
    classifyAllShell: raw.classifyAllShell ?? false,
    modes,
    journalPath: raw.journalPath,
  };
}

export interface ConfigSources {
  home: string;
  projectDir: string;
}

const PROJECT_KEYS = ["soft_deny", "hard_deny"] as const;

function readConfigFile(path: string): RawConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch (error) {
    throw new Error(`invalid brainstem config at ${path}: ${(error as Error).message}`);
  }
}

export function loadRawConfig({ home, projectDir }: ConfigSources): { raw: RawConfig; ignored: string[] } {
  const userFile = join(home, ".claude", "brainstem.json");
  const projectFile = join(projectDir, ".claude", "brainstem.json");
  const { projects, ...userBase } = readConfigFile(userFile);
  const user: RawConfig = { ...userBase, ...projects?.[projectDir] };
  const project = readConfigFile(projectFile);

  const ignored = Object.keys(project)
    .filter((key) => !(PROJECT_KEYS as readonly string[]).includes(key))
    .map((key) => `${projectFile}: ${key}`);
  const raw: RawConfig = { ...user };
  for (const key of PROJECT_KEYS) {
    if (project[key]) raw[key] = [...(user[key] ?? [DEFAULTS_MARKER]), ...project[key]];
  }
  return { raw, ignored };
}
