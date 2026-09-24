export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: [string, ...string[]];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };

export type ConfidenceSource = "provider-reported" | "self-reported" | "calibrated" | "unavailable" | "legacy";

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  confidenceSource?: ConfidenceSource;
  calibrationProfile?: string;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  confidenceSource?: ConfidenceSource;
  calibrationProfile?: string;
};

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface AskResult {
  model: string;
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null };
  answers: Record<string, Answer>;
}

export interface AskOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
}

export type JudgmentOutcome =
  | { status: "completed"; result: AskResult }
  | { status: "unavailable"; reason: string }
  | { status: "cancelled"; reason: string };

export interface SystemOne {
  readonly name: string;
  readonly capabilities?: { confidence: ConfidenceSource; usage: boolean; cancellation: "cooperative" | "local" | "unknown" };
  ask(state: unknown, questions: Record<string, Question>, options?: AskOptions): Promise<AskResult>;
}

export function noul(instructions: string, criteria?: { true: string; false: string }): NoulQuestion {
  const question: NoulQuestion = { type: "noul", instructions };
  if (criteria) question.criteria = criteria;
  return question;
}

export function choice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: string, criteria: [string, ...string[]]): ScoreQuestion {
  return { type: "score", instructions, criteria };
}

export interface AskCall {
  state: unknown;
  questions: Record<string, Question>;
}

export type ReflexMode = "off" | "shadow" | "active";
export type ReflexName = "select" | "focus" | "messageGate" | "gate" | "sanitize" | "verify" | "pulse" | "steer";
export type ReflexModes = Partial<Record<ReflexName, ReflexMode>>;
