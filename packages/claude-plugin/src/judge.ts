import { pathToFileURL } from "node:url";
import { genericJudge, jevJudge, type SystemOne } from "@brainstem/reflexes";

export interface JudgeSelection {
  kind: "jev" | "generic" | "unavailable";
  modulePath?: string;
  /** Gate's automatic approval needs a policy-accepted confidence source. */
  autoApprovalAvailable: boolean;
  note: string;
}

type Complete = Parameters<typeof genericJudge>[0]["complete"];

export function selectJudge(env: NodeJS.ProcessEnv): JudgeSelection {
  if (env.TYPESAFE_API_KEY) {
    return { kind: "jev", autoApprovalAvailable: true, note: "Judging with Jev; provider-reported confidence enables automatic approval." };
  }
  if (env.BRAINSTEM_JUDGE_MODULE) {
    // genericJudge returns confidence: null with confidenceSource "unavailable",
    // which policy never accepts as an approval source.
    return {
      kind: "generic",
      modulePath: env.BRAINSTEM_JUDGE_MODULE,
      autoApprovalAvailable: false,
      note: `Judging with ${env.BRAINSTEM_JUDGE_MODULE}, which reports no confidence, so Gate will never auto-approve.`,
    };
  }
  return {
    kind: "unavailable",
    autoApprovalAvailable: false,
    note: "No judge configured. Set TYPESAFE_API_KEY for Jev, or BRAINSTEM_JUDGE_MODULE for a generic judge. Only the static floor is active.",
  };
}

export function unavailableJudge(note: string): SystemOne {
  return {
    name: "unavailable",
    ask: () => Promise.reject(new Error(note)),
  };
}

export async function buildJudge(selection: JudgeSelection): Promise<SystemOne> {
  if (selection.kind === "jev") return jevJudge();
  if (selection.kind === "unavailable") return unavailableJudge(selection.note);
  const loaded = (await import(pathToFileURL(selection.modulePath!).href)) as { complete?: Complete };
  if (typeof loaded.complete !== "function") throw new Error(`${selection.modulePath} must export complete(prompt, options)`);
  return genericJudge({ complete: loaded.complete, model: selection.modulePath });
}
