import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PermissionRules {
  deny: string[];
  ask: string[];
}

const COMPOUND = /[;&|\n`]|\$\(/;

export function settingsFiles(home: string, projectDir: string): string[] {
  return [
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : "/etc/claude-code/managed-settings.json",
    join(home, ".claude", "settings.json"),
    join(projectDir, ".claude", "settings.json"),
    join(projectDir, ".claude", "settings.local.json"),
  ];
}

export function loadPermissionRules(files: string[]): PermissionRules {
  const rules: PermissionRules = { deny: [], ask: [] };
  for (const file of files) {
    if (!existsSync(file)) continue;
    let settings: { permissions?: Record<string, unknown> };
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // The harness reports its own malformed settings. Skipping one here only costs judgments.
      continue;
    }
    for (const key of ["deny", "ask"] as const) {
      const list = settings.permissions?.[key];
      if (Array.isArray(list)) rules[key].push(...list.filter((rule): rule is string => typeof rule === "string"));
    }
  }
  return rules;
}

export function matchesRule(tool: string, input: Record<string, unknown>, rule: string): boolean {
  const open = rule.indexOf("(");
  if (open === -1) return rule === tool;
  if (tool !== "Bash" || rule.slice(0, open) !== "Bash" || !rule.endsWith(")")) return false;

  const command = typeof input.command === "string" ? input.command.trim() : undefined;
  if (command === undefined || COMPOUND.test(command)) return false;

  const pattern = rule.slice(open + 1, -1);
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (!pattern.includes("*")) return pattern === command;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`, "s").test(command);
}

export function shouldJudge(tool: string, input: Record<string, unknown>, rules: PermissionRules): boolean {
  return ![...rules.deny, ...rules.ask].some((rule) => matchesRule(tool, input, rule));
}
