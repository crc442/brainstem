import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  boundForReview,
  InvalidPatternError,
  REVIEW_CHAR_CAP,
  searchContent,
  sliceByLines,
  splitLines,
  type ArtifactStore,
} from "@brainstem/core";

export interface RecoveryToolDeps {
  store: ArtifactStore;
  /** Test-only override for searchContent's internal scan cap, so mid-scan-clip behavior can be exercised with small fixtures instead of literal million-character ones. Production uses the real default. */
  maxScanChars?: number;
}

const READ_DEFAULT_LINES = 200;
const READ_MAX_LINES = 2_000;
const SEARCH_DEFAULT_LIMIT = 50;
// Caller-controlled text embedded in a receipt (an artifact id, a stream
// name, a search pattern) is bounded to a fixed display length so the
// receipt's own metadata — header, notes, recovery pointers, continuation —
// has a knowable maximum size, never an attacker- or model-supplied
// unbounded string. Bounding is display-only: matching still uses the FULL
// original pattern, never this truncated form.
const MAX_LABEL_DISPLAY_CHARS = 200;
const MAX_LIST_DISPLAY_ITEMS = 20;

function clampInt(value: number | undefined, fallback: number, max: number, min = 1): number {
  const n = Math.floor(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Bounds a caller-supplied label (id, stream name, pattern) for DISPLAY only — truthfully marked when truncated, never silently, and never splitting a UTF-16 surrogate pair (delegated to boundForReview's own surrogate-safe slicing). */
function boundedLabel(s: string, maxChars: number = MAX_LABEL_DISPLAY_CHARS): string {
  const bounded = boundForReview(s, maxChars);
  if (!bounded.truncated) return s;
  return `${bounded.text}…(truncated for display, ${s.length} chars total)`;
}

/** Bounds a caller-visible list (e.g. unscannable line numbers) to at most `maxItems` entries, with a truthful "+N more" instead of an unbounded join. */
function boundedList(items: (string | number)[], maxItems: number = MAX_LIST_DISPLAY_ITEMS): string {
  if (items.length <= maxItems) return items.join(", ");
  return `${items.slice(0, maxItems).join(", ")}, +${items.length - maxItems} more`;
}

/**
 * Renders a page whose surrounding metadata (header, notes, continuation,
 * recovery pointers) is computed from the ACTUAL text `render` produces for
 * a given candidate size — never a fixed guessed reserve independent of
 * what that metadata turns out to contain. Starts at `maxSize` (a whole
 * unit count: lines, matches, or bytes) and shrinks until the COMPLETE
 * result (metadata + body together) fits within `capChars`, so a page's
 * mandatory recovery/continuation instructions are never the part a
 * downstream cap (packages/core/src/presentation.ts's REVIEW_CHAR_CAP
 * backstop) silently cuts off. `render(0)` is trusted to be the caller's
 * own tightly-bounded fallback (e.g. an already-bounded truncated preview,
 * or "no matches") and is always the last candidate tried.
 */
function fitPageToBudget(maxSize: number, capChars: number, render: (size: number) => string): { text: string; size: number } {
  let size = maxSize;
  let text = render(size);
  while (text.length > capChars && size > 0) {
    // Estimate units to drop from the observed average size per unit, not
    // the raw character overflow directly — a size unit here is a whole
    // line/match/byte-window, and its character cost can be far larger than
    // 1, so subtracting `overflow` characters' worth of UNITS would remove
    // vastly more than necessary (or, worse, overshoot straight to 0 and
    // fall back to a degraded single-item preview when several whole items
    // would actually have fit). Re-measured every iteration, so an
    // imprecise estimate still converges — it just may take another pass.
    const overflow = text.length - capChars;
    const avgCharsPerUnit = size > 0 ? text.length / size : 1;
    const unitsToRemove = Math.max(1, Math.ceil(overflow / Math.max(1, avgCharsPerUnit)));
    size = Math.max(0, size - unitsToRemove);
    text = render(size);
  }
  return { text, size };
}

function defaultStream(content: Record<string, string>, requested?: string): string | undefined {
  if (requested !== undefined) return requested in content ? requested : undefined;
  if ("stdout" in content) return "stdout";
  if ("output" in content) return "output";
  return Object.keys(content)[0];
}

function streamsList(content: Record<string, string>): string {
  const keys = Object.keys(content);
  return keys.length > 0 ? keys.join(", ") : "(none)";
}

/** Returns the largest whole-line prefix of `lines` that fits within `capChars` (joined with "\n"), never a partial line. */
function fitWholeLines(lines: string[], capChars: number): { text: string; count: number } {
  let count = 0;
  let total = 0;
  for (const line of lines) {
    const size = line.length + (count > 0 ? 1 : 0);
    if (count === 0 && line.length > capChars) break; // even one line alone doesn't fit — caller falls back to byte pagination
    if (count > 0 && total + size > capChars) break;
    total += size;
    count += 1;
  }
  return { text: lines.slice(0, count).join("\n"), count };
}

/**
 * Byte-safe slice of a single (possibly huge) line, never splitting a UTF-8
 * sequence at either edge, and always making forward progress (start <
 * returned endByte, unless start === totalBytes already).
 */
function sliceLineByBytes(
  line: string,
  startByte: number,
  maxBytes: number,
): { text: string; startByte: number; endByte: number; totalBytes: number } {
  const buf = Buffer.from(line, "utf8");
  const totalBytes = buf.length;
  const start = Math.max(0, Math.min(startByte, totalBytes));
  const rawEnd = start + maxBytes;

  // The window reaches (or exceeds) the buffer's true end — there is no
  // "trailing partial sequence" to back away from; the slice legitimately
  // ends here, including a complete final multi-byte character. Skipping the
  // boundary-safety logic below in this case is what actually matters:
  // running it anyway would incorrectly back up over a COMPLETE trailing
  // UTF-8 character (e.g. a 2-byte 'é' at the very end of the buffer) just
  // because it happens to start with a lead byte, producing an end that
  // never reaches totalBytes and repeating the same byte range forever.
  if (rawEnd >= totalBytes) {
    return { text: buf.subarray(start, totalBytes).toString("utf8"), startByte: start, endByte: totalBytes, totalBytes };
  }

  let end = rawEnd;
  // Back up over any continuation bytes, then (if the resulting lead byte's
  // declared sequence length would run past `end`) over the lead byte too,
  // so the slice never ends mid-codepoint.
  while (end > start && (buf[end - 1]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  if (end > start) {
    const lead = buf[end - 1]!;
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (seqLen > 1 && end - (end - 1) < seqLen) end -= 1;
  }
  // Guard against a pathological window too small to hold even one
  // codepoint (e.g. maxBytes=1 landing inside a 4-byte sequence): accept a
  // possibly-split character rather than stall with zero forward progress.
  // The caller's byte window is always far larger than 4 bytes in practice,
  // so this should not trigger for real captures.
  if (end <= start) end = rawEnd;

  return { text: buf.subarray(start, end).toString("utf8"), startByte: start, endByte: end, totalBytes };
}

// Every failure mode gets its own explicit wording: the model must be able to
// tell a wrong id apart from an evicted capture apart from an empty capture.
// Labels are bounded (never the raw caller-supplied string) so these short,
// fixed-shape messages stay short and fixed-shape regardless of input.
function unknownMessage(id: string): string {
  return `unknown artifact ${boundedLabel(id)}: no capture with this id exists in this session`;
}

function expiredMessage(id: string): string {
  return `artifact ${boundedLabel(id)} expired: the capture was evicted from the artifact store and can no longer be recovered without rerunning the command`;
}

function emptyMessage(id: string, stream: string): string {
  return `artifact ${boundedLabel(id)} stream ${boundedLabel(stream)} is empty: this stream contains no output`;
}

function entryOutcome(captureComplete: boolean): "complete" | "truncated-capture" {
  return captureComplete ? "complete" : "truncated-capture";
}

export function makeRecoveryTools(deps: RecoveryToolDeps): AgentTool[] {
  const readParams = Type.Object({
    id: Type.String({ description: "Artifact id from a capture notice" }),
    stream: Type.Optional(
      Type.String({ description: 'Which captured stream to read (e.g. "stdout", "stderr", or "output"); defaults to stdout/output' }),
    ),
    startLine: Type.Optional(Type.Number({ description: "First line to return (1-indexed, default 1)" })),
    lineCount: Type.Optional(
      Type.Number({ description: `Number of lines to return (default ${READ_DEFAULT_LINES}, max ${READ_MAX_LINES})` }),
    ),
    startByteInLine: Type.Optional(
      Type.Number({
        description:
          "Resume a single line that was too long to fit in one page, at this byte offset within that line (from a previous page's continuation notice).",
      }),
    ),
  });
  const readOutput: AgentTool<typeof readParams> = {
    name: "read_output",
    label: "Read Captured Output",
    description:
      "Recover lines from a previously captured tool output artifact by id. Use this instead of rerunning a command when the presented output was bounded.",
    parameters: readParams,
    executionMode: "parallel",
    execute: async (_id, params) => {
      const entry = deps.store.get(params.id);
      if (!entry) {
        return { content: [{ type: "text", text: unknownMessage(params.id) }], details: { outcome: "unknown" } };
      }
      if (entry.content === null) {
        return { content: [{ type: "text", text: expiredMessage(params.id) }], details: { outcome: "expired" } };
      }
      const stream = defaultStream(entry.content, params.stream);
      if (stream === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `unknown stream "${boundedLabel(params.stream ?? "")}" for artifact ${boundedLabel(params.id)}: available streams are ${streamsList(entry.content)}`,
            },
          ],
          details: { outcome: "unknown-stream" },
        };
      }
      const content = entry.content[stream]!;
      if (content.length === 0) {
        return { content: [{ type: "text", text: emptyMessage(params.id, stream) }], details: { outcome: "empty" } };
      }

      const start = clampInt(params.startLine, 1, Number.MAX_SAFE_INTEGER);
      const requestedCount = params.startByteInLine !== undefined ? 1 : clampInt(params.lineCount, READ_DEFAULT_LINES, READ_MAX_LINES);
      const slice = sliceByLines(content, start, requestedCount);
      const complete = entry.meta.streams[stream]?.complete ?? entry.meta.captureComplete;

      const idLabel = boundedLabel(params.id);
      const streamLabel = boundedLabel(stream);

      if (slice.text.length === 0) {
        const header = `artifact ${idLabel} stream ${streamLabel} lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines} (${entryOutcome(complete)})`;
        return {
          content: [{ type: "text", text: `${header}\n(requested range is past the end of the capture)` }],
          details: { outcome: "ok", startLine: slice.startLine, endLine: slice.endLine },
        };
      }

      const lines = splitLines(slice.text);
      // Computed unconditionally against the FULL review budget (a generous
      // upper-bound candidate, not yet accounting for the header/continuation
      // it will actually be delivered alongside — that's what fitPageToBudget
      // below is for) so the byte-fallback trigger covers EVERY case where
      // even the first requested line doesn't fit whole — not only when it
      // happens to be the sole line in the slice. A multi-line slice whose
      // first line alone exceeds the budget previously fell through to
      // fitWholeLines, which returned count=0 (a truthful "delivered
      // nothing"), producing a nonsensical "lines N-(N-1)" header and a
      // continuation notice pointing right back at the same startLine forever.
      const fit = params.startByteInLine === undefined ? fitWholeLines(lines, REVIEW_CHAR_CAP) : { text: "", count: 0 };

      const rendered = fitPageToBudget(fit.count, REVIEW_CHAR_CAP, (count) => {
        const deliveredEndLine = slice.startLine + count - 1;
        const pageBounded = count < lines.length;
        const header = `artifact ${idLabel} stream ${streamLabel} lines ${slice.startLine}-${deliveredEndLine} of ${slice.totalLines} (${entryOutcome(complete)}${pageBounded ? ", page bounded — more requested lines remain" : ""})`;
        const cont = pageBounded ? `\n[brainstem] continue with startLine=${deliveredEndLine + 1} to recover the rest of this range.` : "";
        const body = lines.slice(0, count).join("\n");
        return body.length > 0 ? `${header}\n${body}${cont}` : `${header}${cont}`;
      });

      // A line can fit by itself but fail once its receipt is included.
      // Choose byte pagination from the final page fit, not the body fit.
      if (params.startByteInLine !== undefined || rendered.size === 0) {
        // Either explicitly continuing a prior oversized-line page, or the
        // FIRST requested line itself doesn't fit in one page — paginate
        // that one line by UTF-8 byte range instead of silently clipping it
        // or stalling on a zero-progress "page bounded" response. The byte
        // window itself is shrunk (never the header/continuation) until the
        // COMPLETE page fits the review boundary.
        const lineText = lines[0] ?? "";
        const otherStream = stream !== defaultStream(entry.content) ? `, stream="${streamLabel}"` : "";
        const { text } = fitPageToBudget(REVIEW_CHAR_CAP, REVIEW_CHAR_CAP, (maxBytes) => {
          const byteSlice = sliceLineByBytes(lineText, params.startByteInLine ?? 0, Math.max(1, maxBytes));
          const header = `artifact ${idLabel} stream ${streamLabel} line ${slice.startLine} bytes ${byteSlice.startByte}-${byteSlice.endByte} of ${byteSlice.totalBytes} (${entryOutcome(complete)}, partial line)`;
          const cont =
            byteSlice.endByte < byteSlice.totalBytes
              ? `\n[brainstem] line continues — call read_output again with startLine=${slice.startLine}, startByteInLine=${byteSlice.endByte}${otherStream} to continue.`
              : "";
          return `${header}\n${byteSlice.text}${cont}`;
        });
        return {
          content: [{ type: "text", text }],
          details: { outcome: "ok", startLine: slice.startLine, endLine: slice.startLine, partialLine: true },
        };
      }

      return {
        content: [{ type: "text", text: rendered.text }],
        details: { outcome: "ok", startLine: slice.startLine, endLine: slice.startLine + rendered.size - 1 },
      };
    },
  };

  const searchParams = Type.Object({
    id: Type.String({ description: "Artifact id from a capture notice" }),
    stream: Type.Optional(
      Type.String({ description: 'Which captured stream to search (e.g. "stdout", "stderr", or "output"); defaults to stdout/output' }),
    ),
    pattern: Type.String({ description: "Regular expression to search for" }),
    limit: Type.Optional(Type.Number({ description: `Maximum matches to return (default ${SEARCH_DEFAULT_LIMIT})` })),
    startLine: Type.Optional(
      Type.Number({
        description:
          "Resume scanning from this line (1-indexed, default 1) — use the continuation notice from a truncated search to continue coverage without gaps or re-scanning.",
      }),
    ),
  });
  const searchOutput: AgentTool<typeof searchParams> = {
    name: "search_output",
    label: "Search Captured Output",
    description:
      "Search a previously captured tool output artifact by id for a regular expression, with exact line numbers. Use this to locate content in captures whose presented view was bounded.",
    parameters: searchParams,
    executionMode: "parallel",
    execute: async (_id, params) => {
      const entry = deps.store.get(params.id);
      if (!entry) {
        return { content: [{ type: "text", text: unknownMessage(params.id) }], details: { outcome: "unknown" } };
      }
      if (entry.content === null) {
        return { content: [{ type: "text", text: expiredMessage(params.id) }], details: { outcome: "expired" } };
      }
      const stream = defaultStream(entry.content, params.stream);
      if (stream === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `unknown stream "${boundedLabel(params.stream ?? "")}" for artifact ${boundedLabel(params.id)}: available streams are ${streamsList(entry.content)}`,
            },
          ],
          details: { outcome: "unknown-stream" },
        };
      }
      const content = entry.content[stream]!;
      if (content.length === 0) {
        return { content: [{ type: "text", text: emptyMessage(params.id, stream) }], details: { outcome: "empty" } };
      }

      const allLines = splitLines(content);
      const startLine = clampInt(params.startLine, 1, Math.max(1, allLines.length));
      // Every resume is a whole-line boundary — scanFrom's own line 1 is
      // ALWAYS the complete, original text of `startLine`, never a fragment
      // of it. searchContent itself guarantees it never stops mid-line (see
      // R6 in docs/plans/2026-09-22-review-remediation.md), so there is
      // nothing here to reconstruct a partial line from.
      const scanFrom = allLines.slice(startLine - 1).join("\n");
      const complete = entry.meta.streams[stream]?.complete ?? entry.meta.captureComplete;

      let result;
      try {
        result = searchContent(
          scanFrom,
          params.pattern,
          clampInt(params.limit, SEARCH_DEFAULT_LIMIT, Number.MAX_SAFE_INTEGER),
          deps.maxScanChars,
        );
      } catch (error) {
        if (error instanceof InvalidPatternError) {
          return {
            content: [
              {
                type: "text",
                text: `invalid pattern for search_output: ${boundedLabel(params.pattern)} (${boundedLabel(error.message)}). Fix the regular expression and retry.`,
              },
            ],
            details: { outcome: "invalid-pattern" },
          };
        }
        throw error;
      }
      // Line numbers from searchContent are relative to `scanFrom`, whose
      // first line IS original line `startLine` in full — so line 1 of
      // scanFrom is original line `startLine`, with no offset arithmetic.
      const rebasedMatches = result.matches.map((m) => ({ line: m.line + startLine - 1, text: m.text }));
      const rebasedUnscannable = result.unscannableLines.map((l) => l + startLine - 1);
      // Last line fully covered by this scan (matched, not-matched, or
      // explicitly unscannable) — always a whole-line count now, since
      // searchContent never stops mid-line.
      const fullyScannedThroughLine = startLine - 1 + result.scannedLines;

      const idLabel = boundedLabel(params.id);
      const streamLabel = boundedLabel(stream);
      const patternLabel = boundedLabel(params.pattern);
      const unscannableLabel = boundedList(rebasedUnscannable);
      const matchLines = rebasedMatches.map((m) => `${m.line}: ${m.text}`);
      const coverageText = `lines ${startLine}-${fullyScannedThroughLine} of ${allLines.length}`;

      // Renders the complete page — header, notes, body, and continuation —
      // for a candidate `count` of whole matches delivered. Metadata (the
      // notes list and continuation) is computed FROM this same count, not
      // independently of it, so fitPageToBudget below can shrink `count`
      // until the WHOLE result fits the review boundary: the earlier defect
      // reserved a fixed guessed amount for header+notes+continuation, which
      // a long pattern, a long unscannable-lines list, or simply several
      // notes at once could exceed, silently losing the continuation/
      // recovery pointer to a downstream cap that knows nothing about them.
      const render = (count: number): string => {
        const matchTruncated = count === 0 && rebasedMatches.length > 0;
        // deliveredMatches is known BEFORE the body text is — the truncated-
        // preview case (matchTruncated) still delivers exactly the first
        // match, just as a bounded preview instead of its full text — so
        // every piece of metadata below (pageBounded, notes, continuation)
        // can be computed first, and the preview's own available space
        // measured from the ACTUAL resulting metadata, never guessed.
        const deliveredMatches = count > 0 ? rebasedMatches.slice(0, count) : matchTruncated ? [rebasedMatches[0]!] : [];
        const pageBounded = deliveredMatches.length < rebasedMatches.length || matchTruncated;

        // Continuation: whenever there's more of the CONTENT left to scan —
        // because of the match `limit`, this page's own size, or the scan
        // cap — resume right after the last delivered match when one
        // exists, else right after the last fully-scanned line (always a
        // whole-line boundary now; searchContent never stops mid-line).
        // Compared against the true total (not the limit-capped match
        // list), so a limit cap triggers this the same way a page-size
        // truncation does. An unscannable line does NOT by itself justify a
        // "keep scanning" continuation — re-scanning it would hit the same
        // ceiling again — so it gets its own note and read_output pointer
        // instead.
        const hasMoreToDeliver = result.totalMatches > deliveredMatches.length || result.scanClipped;
        const resumeLine = hasMoreToDeliver
          ? deliveredMatches.length > 0
            ? deliveredMatches[deliveredMatches.length - 1]!.line + 1
            : fullyScannedThroughLine + 1
          : undefined;

        const notes: string[] = [];
        if (result.scanClipped) {
          notes.push("scan bounded by size — matches beyond the scanned range are not yet known");
        }
        if (matchTruncated) {
          notes.push(`showing 1 of ${rebasedMatches.length} match(es) in this range, truncated (see note below to recover it in full)`);
        } else if (pageBounded) {
          notes.push(`page bounded — showing ${deliveredMatches.length} of ${rebasedMatches.length} matches found in this range`);
        }
        if (rebasedUnscannable.length > 0) {
          // Never label these lines "no match": their match status is
          // genuinely undetermined, and a fragment-based check (the earlier
          // defect) could produce a false positive or false negative. Point
          // at read_output, the one path that returns their true, complete
          // text.
          notes.push(
            `line(s) ${unscannableLabel} exceed the per-line search limit and were not evaluated (undetermined, not absent) — use read_output with startLine=<N> to inspect directly`,
          );
        }
        const header = `artifact ${idLabel} stream ${streamLabel} search "${patternLabel}" from line ${startLine}: ${result.totalMatches} match(es) found in ${coverageText} (${entryOutcome(complete)}${notes.length > 0 ? `, ${notes.join("; ")}` : ""})`;
        const continuationNotice = resumeLine !== undefined ? `\n[brainstem] continue with startLine=${resumeLine} to cover the rest.` : "";

        if (matchTruncated) {
          // Not even one whole match line fits alongside this page's
          // metadata. Never silently drop a match that WAS found: deliver a
          // bounded, explicitly truncated preview and point at how to
          // recover the full line via read_output, instead of reporting "no
          // matches" and skipping past it. The preview's own budget is
          // whatever's left AFTER the header, the recovery note, and the
          // continuation — measured from their real, final text, not a
          // second independent guess about how much room they'll need.
          const first = deliveredMatches[0]!;
          const recoveryNote = `\n[brainstem] match on line ${first.line} truncated — use read_output with startLine=${first.line} to recover it in full.`;
          const reserved = header.length + 1 + recoveryNote.length + continuationNotice.length;
          const bounded = boundForReview(matchLines[0]!, Math.max(0, REVIEW_CHAR_CAP - reserved));
          return `${header}\n${bounded.text}${recoveryNote}${continuationNotice}`;
        }
        const renderedBody = matchLines.slice(0, deliveredMatches.length).join("\n");
        return renderedBody.length === 0 ? `${header}\nno matches${continuationNotice}` : `${header}\n${renderedBody}${continuationNotice}`;
      };

      const rendered = fitPageToBudget(rebasedMatches.length, REVIEW_CHAR_CAP, render);
      const finalDelivered = rendered.size > 0 ? rendered.size : rebasedMatches.length > 0 ? 1 : 0;
      return {
        content: [{ type: "text", text: rendered.text }],
        details: {
          outcome: "ok",
          totalMatches: result.totalMatches,
          truncated: result.truncated,
          scannedTo: fullyScannedThroughLine,
          delivered: finalDelivered,
          unscannableLines: rebasedUnscannable,
        },
      };
    },
  };

  return [readOutput, searchOutput];
}
