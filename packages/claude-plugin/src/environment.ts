// packages/claude-plugin/src/environment.ts
import { boundForReview, REVIEW_CHAR_CAP } from "@brainstem/reflexes";
import type { PluginConfig } from "./config";

const SECTIONS: { key: keyof Pick<PluginConfig, "environment" | "allow" | "soft_deny" | "hard_deny">; header: string }[] = [
  { key: "environment", header: "ENVIRONMENT:" },
  { key: "allow", header: "ALLOW (treat as routine):" },
  { key: "soft_deny", header: "SOFT BLOCK (block unless the user's intent clears it):" },
  { key: "hard_deny", header: "HARD BLOCK (never cleared by user intent):" },
];

export function composeEnvironment(config: PluginConfig): string {
  const blocks = SECTIONS.filter(({ key }) => config[key].length > 0).map(
    ({ key, header }) => `${header}\n${config[key].map((rule) => `- ${rule}`).join("\n")}`,
  );
  return boundForReview(blocks.join("\n\n"), REVIEW_CHAR_CAP).text;
}
