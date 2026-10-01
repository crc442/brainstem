export type Family = "testrunner" | "tsc";

const PATTERNS: { family: Family; pattern: RegExp }[] = [
  { family: "tsc", pattern: /^(?:(?:npx|bunx)\s+)?tsc(?=\s|$)|^(?:npm|bun|pnpm|yarn)\s+(?:run\s+)?typecheck(?=\s|$)/ },
  {
    family: "testrunner",
    pattern:
      /^(?:(?:npx|bunx)\s+)?(?:vitest|jest|pytest)(?=\s|$)|^(?:go|cargo)\s+test(?=\s|$)|^(?:npm|bun|pnpm|yarn)\s+(?:run\s+)?test(?=\s|$)/,
  },
];

const SHELL_OPERATORS = new Set([";", "&", "|", "<", ">", "`", "$", "(", ")", "{", "}"]);

export function detectFamily(command: string): Family | null {
  const trimmed = command.trim();
  for (const { family, pattern } of PATTERNS) if (pattern.test(trimmed)) return family;
  return null;
}

export function isSimpleCommand(command: string): boolean {
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "\n" || char === "\0") return false;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === "\\") {
        const next = command[i + 1];
        if (next === "\n") return false;
        // Bash only treats backslash specially before these characters inside
        // double quotes. In particular, \" is data and cannot end the quote.
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          escaped = true;
          continue;
        }
      } else if (char === '"') quote = undefined;
      else if (char === "$" || char === "`") return false;
      continue;
    }
    if (char === "\\") {
      if (i === command.length - 1 || command[i + 1] === "\n") return false;
      escaped = true;
      continue;
    }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else if (SHELL_OPERATORS.has(char)) return false;
    else if (char === "#" && (i === 0 || /\s/.test(command[i - 1]!))) return false;
  }
  return quote === undefined && !escaped;
}

const FAILURE = /\b(FAIL|FAILED|ERROR|AssertionError|Expected|Received)\b|Error:|✗|×|^\s+at\s|\berror TS\d+\b/;
const SUMMARY = /^(Tests?|Test Files|Suites?|Snapshots?|Duration|=+ (FAILURES|short test summary))/i;

const capSlice = (text: string, cap: number): string => {
  let end = Math.min(text.length, cap);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
};

export function filterOutput(family: Family | null, text: string): string {
  if (family === null) return text;
  const streams = /^(--- stdout ---[^\n]*\n)([\s\S]*?)(\n--- stderr ---[^\n]*\n)([\s\S]*)$/.exec(text);
  if (streams) {
    const stdout = filterOutput(family, streams[2]!);
    const stderr = streams[4]!;
    return `${streams[1]}${stdout}${streams[3]}${stderr}`;
  }
  const lines = text.split("\n");

  if (family === "tsc") {
    const diagnostics = lines.map((line, index) => (/\berror TS\d+\b/.test(line) ? index : -1)).filter((index) => index >= 0);
    if (diagnostics.length === 0) return text;
    const keep = new Set<number>();
    for (const index of diagnostics) {
      for (let i = Math.max(0, index - 3); i <= Math.min(lines.length - 1, index + 8); i++) {
        if (lines[i]!.length > 2000 && !/\berror TS\d+\b/.test(lines[i]!)) continue;
        keep.add(i);
      }
    }
    const selected = [...keep].sort((a, b) => a - b);
    const omittedChars = lines.reduce((sum, line, index) => sum + (keep.has(index) ? 0 : line.length + 1), 0);
    if (omittedChars < 1000) return text;
    return selected.map((index) => lines[index]!).join("\n");
  }

  // A green run carries no failure evidence to select, so trimming it would only
  // remove the reassurance that it passed.
  if (!lines.some((line) => FAILURE.test(line))) return text;
  const failureLines = lines.map((line, index) => (FAILURE.test(line) ? index : -1)).filter((index) => index >= 0);
  if (failureLines.length === 0) return text;
  const keep = new Set<number>();
  for (const failureLine of failureLines) {
    // Test reporters place locations, stack frames, and expected/actual blocks next
    // to failure markers. Preserve nearby continuation lines as a single excerpt.
    const start = Math.max(0, failureLine - 4);
    let end = Math.min(lines.length - 1, failureLine + 12);
    while (end + 1 < lines.length && lines[end + 1]!.trim() && !/^\s*PASS\b|^\s*✓(?:\s|$)/.test(lines[end + 1]!)) end++;
    for (let i = start; i <= end; i++) {
      if (/^\s*PASS\b|^\s*✓(?:\s|$)/.test(lines[i]!)) continue;
      if (lines[i]!.length > 2000 && !FAILURE.test(lines[i]!)) continue;
      keep.add(i);
    }
  }
  lines.forEach((line, index) => {
    if (SUMMARY.test(line)) keep.add(index);
  });
  const selected = [...keep].sort((a, b) => a - b);
  // Dense/ambiguous formats with little omitted content are safer as a full view.
  // A huge unrelated progress row is excluded even when it is the only omitted row.
  const omittedChars = lines.reduce((sum, line, index) => sum + (keep.has(index) ? 0 : line.length + 1), 0);
  if (selected.length > lines.length * 0.8 && omittedChars < 1000) return text;
  return selected.map((index) => lines[index]!).join("\n");
}

/** Build a bounded, stream-aware source view before the shared review cap is applied. */
export function presentOutput(family: Family | null, text: string, cap: number): { text: string; truncated: boolean } {
  const streams = /^(--- stdout ---[^\n]*\n)([\s\S]*?)(\n--- stderr ---[^\n]*\n)([\s\S]*)$/.exec(text);
  if (!streams) {
    const filtered = filterOutput(family, text);
    const shown = capSlice(filtered, Math.max(0, cap - 96));
    return { text: shown, truncated: filtered !== text || shown.length !== filtered.length };
  }

  const rawOut = streams[2]!;
  const rawErr = streams[4]!;
  const filteredOut = filterOutput(family, rawOut);
  const filteredErr = filterOutput(family, rawErr);
  const outWasFiltered = filteredOut !== rawOut;
  const errWasFiltered = filteredErr !== rawErr;
  const headingsLength = streams[1]!.length + streams[3]!.length + 2;
  // Leave space for bounded per-stream receipts; the pipeline will add its own
  // shared omission notice after review.
  const bodyBudget = Math.max(0, cap - headingsLength - 240);
  const outNonempty = filteredOut.length > 0;
  const errNonempty = filteredErr.length > 0;
  const outFailure = FAILURE.test(filteredOut);
  const errFailure = FAILURE.test(filteredErr);
  let outWeight = outNonempty ? 1 : 0;
  let errWeight = errNonempty ? 1 : 0;
  if (outNonempty && errNonempty) {
    if (outFailure && !errFailure) [outWeight, errWeight] = [0.7, 0.3];
    else if (errFailure && !outFailure) [outWeight, errWeight] = [0.3, 0.7];
    else [outWeight, errWeight] = [0.5, 0.5];
  }
  const weightTotal = outWeight + errWeight || 1;
  let outBudget = Math.floor((bodyBudget * outWeight) / weightTotal);
  let errBudget = bodyBudget - outBudget;
  let shownOut = Math.min(filteredOut.length, outBudget);
  let shownErr = Math.min(filteredErr.length, errBudget);
  let remaining = bodyBudget - shownOut - shownErr;
  const priority = errFailure && !outFailure ? ["err", "out"] : ["out", "err"];
  for (const stream of priority) {
    if (remaining <= 0) break;
    if (stream === "out") {
      const extra = Math.min(remaining, filteredOut.length - shownOut);
      shownOut += extra;
      remaining -= extra;
    } else {
      const extra = Math.min(remaining, filteredErr.length - shownErr);
      shownErr += extra;
      remaining -= extra;
    }
  }

  const out = capSlice(filteredOut, shownOut);
  const err = capSlice(filteredErr, shownErr);
  const outLimited = out.length < filteredOut.length;
  const errLimited = err.length < filteredErr.length;
  const head = (source: string, view: string, total: number, selectedTotal: number, filtered: boolean) => {
    const details = [
      ...(filtered ? [`failure context selected from ${total} source characters`] : []),
      ...(view.length < selectedTotal ? [`showing ${view.length} of ${selectedTotal}${filtered ? " selected" : ""} characters`] : []),
    ];
    return `${source.trimEnd()}${details.length ? ` (${details.join("; ")})` : ""}\n`;
  };
  const result = `${head(streams[1]!, out, rawOut.length, filteredOut.length, outWasFiltered)}${out}\n${head(
    streams[3]!,
    err,
    rawErr.length,
    filteredErr.length,
    errWasFiltered,
  )}${err}`;
  return { text: result, truncated: outWasFiltered || errWasFiltered || outLimited || errLimited || result !== text };
}
