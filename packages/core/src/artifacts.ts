import { createHash } from "node:crypto";

// Bumping this invalidates on-disk metadata written by an older shape — see
// LocalArtifactStore, which skips (never crashes on) a meta file whose
// schemaVersion does not match.
export const ARTIFACT_SCHEMA_VERSION = 1;

export interface StreamMeta {
  /** Total bytes the source actually produced for this stream, even if not all were retained. */
  bytesObserved: number;
  /** Bytes actually stored for this stream. */
  bytesRetained: number;
  /** True only when bytesRetained === bytesObserved for this stream; never inferred from retained length alone. */
  complete: boolean;
}

export interface ArtifactMeta {
  artifactId: string;
  /** Owning session — validated on every read/search/list so one session can never retrieve or evict another's artifacts (R7). */
  sessionId: string;
  schemaVersion: number;
  toolCallId: string;
  tool: string;
  commandOrTarget: string; // command for bash, path for read/write
  contentHash: string; // sha-256 of the canonical combined-for-hash representation (documented per caller)
  byteCount: number; // total retained bytes across all streams
  lineCount: number; // total retained lines across all streams (documented ordering: stream insertion order)
  captureComplete: boolean; // true iff every declared stream is complete
  createdAt: number;
  evicted?: boolean; // content deleted under store limits; meta retained
  /** Named streams this artifact was captured with — e.g. {stdout, stderr} for bash, {output} for everything else. */
  streams: Record<string, StreamMeta>;
}

export type ArtifactRecord = ArtifactMeta;

export interface ArtifactEntry {
  meta: ArtifactMeta;
  // null when the content was evicted; recovery surfaces this as an explicit expired outcome
  content: Record<string, string> | null;
}

export interface ArtifactStore {
  put(record: ArtifactMeta, content: Record<string, string>): void;
  get(id: string): ArtifactEntry | null;
  list(): ArtifactMeta[];
}

export class InvalidPatternError extends Error {
  readonly pattern: string;
  constructor(pattern: string, cause?: unknown) {
    super(`invalid regex pattern: ${pattern}`);
    this.name = "InvalidPatternError";
    this.pattern = pattern;
    this.cause = cause;
  }
}

// Only the final "\n" is a terminator, not a phantom empty line.
export function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function countLines(content: string): number {
  return splitLines(content).length;
}

export function sliceByLines(
  content: string,
  startLine: number,
  lineCount: number,
): { text: string; startLine: number; endLine: number; totalLines: number } {
  const lines = splitLines(content);
  const totalLines = lines.length;
  const start = Math.max(1, Math.floor(startLine) || 1);
  const count = Math.max(0, Math.floor(lineCount));
  if (count === 0 || start > totalLines) {
    return { text: "", startLine: start, endLine: start - 1, totalLines };
  }
  const end = Math.min(start + count - 1, totalLines);
  return { text: lines.slice(start - 1, end).join("\n"), startLine: start, endLine: end, totalLines };
}

// Regex work is capped by scanning at most this many characters, so a huge
// capture cannot turn search_output into a hang; matches are capped at `limit`.
export const DEFAULT_MAX_SCAN_CHARS = 1_000_000;

// A regex must only ever be evaluated against a COMPLETE original line —
// never a character-offset fragment of one, which silently breaks anchors
// (^/$), lookaround, and any pattern that spans the cut point. maxScanChars bounds how many
// separate lines a single call is willing to start scanning, but the line
// already "in progress" when that budget is reached is always still
// evaluated to its own true end — bounded instead by this much higher
// ceiling, which exists only to stop one pathological line from making a
// single call scan unboundedly. A line beyond even THIS ceiling is never
// fragment-tested; it is reported as unscannable (undetermined), not absent.
const MAX_LINE_CHARS_MULTIPLIER = 8;

export interface SearchResult {
  matches: { line: number; text: string }[];
  totalMatches: number;
  truncated: boolean;
  /** True only when the scan cap stopped the input short of its end — distinct from `truncated`, which is also set by an ordinary `limit`. Always lands on a line boundary; a line is never partially scanned. */
  scanClipped: boolean;
  /** Lines actually scanned within the given `content` (matched, not-matched, or unscannable) — may be fewer than its total line count when `scanClipped` is true. */
  scannedLines: number;
  /** Exact character count actually scanned (== content.length unless scanClipped). Can exceed maxScanChars by up to one line's length, since the line in progress when the budget is reached is always finished, never cut. */
  scannedChars: number;
  /** 1-indexed line numbers too large to evaluate even whole (see MAX_LINE_CHARS_MULTIPLIER) and therefore skipped entirely: neither matched nor confirmed absent. Empty for ordinary content. */
  unscannableLines: number[];
}

export function searchContent(content: string, pattern: string, limit = 50, maxScanChars: number = DEFAULT_MAX_SCAN_CHARS): SearchResult {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (cause) {
    throw new InvalidPatternError(pattern, cause);
  }
  const maxLineChars = maxScanChars * MAX_LINE_CHARS_MULTIPLIER;
  const allLines = splitLines(content);
  const cap = Math.max(0, Math.floor(limit));
  const matches: { line: number; text: string }[] = [];
  const unscannableLines: number[] = [];
  let totalMatches = 0;
  let scannedChars = 0;
  let scanClipped = false;
  let scannedLines = 0;

  for (let i = 0; i < allLines.length; i++) {
    // Refuse to START a new line once the budget is already spent — but a
    // line already being processed always runs to its own true end (below),
    // never sliced mid-way.
    if (scannedChars >= maxScanChars) {
      scanClipped = true;
      break;
    }
    const line = allLines[i]!;
    if (line.length > maxLineChars) {
      unscannableLines.push(i + 1);
    } else if (re.test(line)) {
      totalMatches += 1;
      if (matches.length < cap) matches.push({ line: i + 1, text: line });
    }
    scannedChars += line.length + (i < allLines.length - 1 ? 1 : 0);
    scannedLines += 1;
  }

  return {
    matches,
    totalMatches,
    truncated: totalMatches > matches.length || scanClipped || unscannableLines.length > 0,
    scanClipped,
    scannedLines,
    scannedChars,
    unscannableLines,
  };
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
