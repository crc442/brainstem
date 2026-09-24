import { boundForReview, REVIEW_CHAR_CAP } from "./presentation";
import { contentHash } from "./artifacts";
import { splitIntoSections, type SectionManifest } from "./output-sections";
import { getBit } from "./bitmap";
import type { FocusDecision, FocusInput } from "./output-focus";
import type { ObserveToolResultInput, SanitizeDecision, VerifyDecision } from "./engine";
import type { AskOptions } from "./types";
import type { ToolStatus } from "./evidence";

export type OutputMode = "off" | "shadow" | "active";
export interface SourceRange { sourceId: string; stream: string; unit: "utf8-byte"; start: number; end: number }
export interface CapturedOutput {
  kind: "captured";
  sourceId: string;
  stream: string;
  text: string;
  completeness: "complete" | "limited" | "unknown";
  recovery?: { sessionId: string; sourceId: string; instructions: string };
}
export interface PresentedOutput {
  kind: "presented";
  text: string;
  hash: string;
  source: CapturedOutput;
  ranges: SourceRange[];
  rangeCoverage: "known" | "unknown";
  omitted: boolean;
  candidateCoverage: "complete" | "limited";
}
export interface ReviewedOutput {
  kind: "reviewed";
  presented: PresentedOutput;
  text: string;
  sanitize?: SanitizeDecision;
  verify?: VerifyDecision;
  review: { sanitize: OutputMode; verify: OutputMode };
  focusDecision?: FocusDecision;
  manifest?: SectionManifest;
  why?: string;
}
export interface OutputPipelineDeps {
  focus(input: FocusInput, options?: AskOptions): Promise<FocusDecision>;
  observe(input: ObserveToolResultInput, options?: AskOptions & { sanitize?: boolean; verify?: boolean }): Promise<{ sanitize: SanitizeDecision; verify: VerifyDecision }>;
}
export interface OutputPipelineInput {
  capture: CapturedOutput;
  task: string;
  action: string;
  status: ToolStatus;
  recent?: string[];
  focus?: OutputMode;
  sanitize?: OutputMode;
  verify?: OutputMode;
  nonTextCount?: number;
  signal?: AbortSignal;
  /** Host-authored bounded presentation, e.g. the reference CLI's pagination receipt. */
  fallback?: (text: string) => { text: string; truncated: boolean };
  candidateCap?: number;
}

/** Shared evidence boundary; source text is never expanded after review. */
export async function processOutput(input: OutputPipelineInput, deps: OutputPipelineDeps): Promise<ReviewedOutput> {
  const capture = structuredClone(input.capture);
  const focusMode = input.focus ?? "off";
  const sanitizeMode = input.sanitize ?? "active";
  const verifyMode = input.verify ?? "active";
  const alive = () => { if (input.signal?.aborted) throw new Error("output review cancelled"); };
  alive();
  const candidate = boundForReview(capture.text, input.candidateCap ?? 100_000);
  let manifest: SectionManifest | undefined;
  let decision: FocusDecision | undefined;
  if (focusMode !== "off" && candidate.text.trim()) {
    manifest = splitIntoSections(capture.sourceId, candidate.text);
    decision = await deps.focus({ task: input.task, command: input.action, intent: input.action, outcome: input.status, recentFindings: input.recent ?? [], manifest, budgetChars: 4000 }, { signal: input.signal });
    alive();
  }
  const selected = focusMode === "active" && decision?.mode === "select" && manifest
    ? manifest.entries.filter((_, i) => getBit(decision!.selected, i)) : undefined;
  let ranges: SourceRange[] = [];
  let candidateText: string;
  let omitted: boolean;
  let rangeCoverage: "known" | "unknown" = "known";
  if (selected?.length) {
    candidateText = selected.map((s) => s.text).join("\n\n");
    omitted = candidate.truncated || selected.length < manifest!.entries.length;
    ranges = selected.map((s) => ({ sourceId: capture.sourceId, stream: capture.stream, unit: "utf8-byte", start: s.startByte, end: s.endByte }));
  } else if (input.fallback) {
    const fallback = input.fallback(capture.text);
    candidateText = fallback.text; omitted = fallback.truncated;
    // Custom host presentation may contain labels and noncontiguous excerpts.
    rangeCoverage = "unknown";
  } else {
    candidateText = capture.text; omitted = false;
    ranges = [{ sourceId: capture.sourceId, stream: capture.stream, unit: "utf8-byte", start: 0, end: Buffer.byteLength(capture.text) }];
  }
  const bounded = boundForReview(candidateText, REVIEW_CHAR_CAP);
  omitted ||= bounded.truncated;
  if (rangeCoverage === "known") {
    let remaining = Buffer.byteLength(bounded.text);
    ranges = ranges.flatMap((range, i) => {
      if (i > 0) remaining = Math.max(0, remaining - 2); // inserted section separator
      const length = Math.min(range.end - range.start, remaining);
      remaining -= length;
      return length > 0 ? [{ ...range, end: range.start + length }] : [];
    });
  }
  const presented: PresentedOutput = {
    kind: "presented", text: bounded.text, hash: contentHash(bounded.text), source: capture, ranges, rangeCoverage,
    omitted, candidateCoverage: candidate.truncated || manifest?.entries.some((s) => s.text.length > 2000) ? "limited" : "complete",
  };
  let sanitize: SanitizeDecision | undefined;
  let verify: VerifyDecision | undefined;
  let text = bounded.text;
  let why: string | undefined;
  if (text.trim() && (sanitizeMode !== "off" || verifyMode !== "off")) {
    const observed = await deps.observe({ task: input.task, source: `tool:${capture.sourceId}`, actionSummary: input.action, intent: input.action, status: input.status, truncated: omitted || capture.completeness !== "complete", content: text }, { signal: input.signal, sanitize: sanitizeMode !== "off", verify: verifyMode !== "off" });
    alive();
    sanitize = sanitizeMode !== "off" ? observed.sanitize : undefined;
    verify = verifyMode !== "off" ? observed.verify : undefined;
    if (sanitizeMode === "active" && sanitize?.action === "block") {
      text = `[brainstem] blocked tool output (probable injected instructions): ${sanitize.reasons.join("; ")}`;
      why = "sanitize blocked output";
    } else {
      const notes: string[] = [];
      if (sanitizeMode === "active" && sanitize?.action === "review") { notes.push(`[brainstem] review this content: ${sanitize.reasons.join("; ")}`); why = "sanitize review notes prepended"; }
      if (verifyMode === "active" && verify?.action === "mismatch") { notes.push(`[brainstem] verify: this output may not satisfy what the tool call was trying to do (${verify.reasons.join("; ")}). Consider a different approach if progress stalls.`); why ??= "verify notes prepended"; }
      else if (verifyMode === "active" && verify && !verify.verified) { notes.push("[brainstem] verify: unavailable — result not verified"); why ??= "verify unavailable notes prepended"; }
      if (notes.length) text = `${notes.join("\n")}\n\n${text}`;
    }
  }
  const notes: string[] = [];
  if (focusMode === "active" && selected?.length && omitted) notes.push(`[brainstem] focus: showing ${selected.length} of ${manifest!.entries.length} sections relevant to the task.`);
  if (omitted) notes.push(capture.recovery
    ? `[brainstem] output omitted; archived as artifact ${capture.recovery.sourceId} — ${capture.recovery.instructions}`
    : "[brainstem] output omitted; this host supplies no recovery tool for the rest.");
  if (capture.completeness !== "complete") notes.push(`[brainstem] source capture ${capture.completeness}; completeness is not established.`);
  if (focusMode === "active" && presented.candidateCoverage === "limited") notes.push("[brainstem] Focus candidate coverage limited; selection did not evaluate all source text.");
  if (focusMode === "active" && decision?.mode === "compute_or_retrieve") notes.push("[brainstem] focus: use retrieval or computation; selected excerpts may not answer this task.");
  if (input.nonTextCount && (sanitizeMode === "active" || verifyMode === "active")) { notes.push(`[brainstem] ${input.nonTextCount} non-text content part(s) withheld: unreviewed content types are never delivered.`); why ??= "non-text content withheld"; }
  if (notes.length) text = [text, ...notes].filter(Boolean).join("\n\n");
  alive();
  return { kind: "reviewed", presented, text, sanitize, verify, review: { sanitize: sanitizeMode, verify: verifyMode }, focusDecision: decision, manifest, why };
}
