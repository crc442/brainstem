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
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\" && quote !== "double") {
      if (i === command.length - 1 || command[i + 1] === "\n") return false;
      escaped = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      else if (char === "$" || char === "`") return false;
      continue;
    }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    else if (SHELL_OPERATORS.has(char) || char === "\\" || char === "\n") return false;
    else if (char === "#" && (i === 0 || /\s/.test(command[i - 1]!))) return false;
  }
  return quote === undefined && !escaped;
}

const FAILURE = /\b(FAIL|FAILED|ERROR|AssertionError|Expected|Received)\b|Error:|✗|×|^\s+at\s|\berror TS\d+\b/;
const SUMMARY = /^(Tests?|Test Files|Suites?|Snapshots?|Duration|=+ (FAILURES|short test summary))/i;

export function filterOutput(family: Family | null, text: string): string {
  if (family === null) return text;
  const streams = /^(--- stdout ---[^\n]*\n)([\s\S]*?)(\n--- stderr ---[^\n]*\n)([\s\S]*)$/.exec(text);
  if (streams) {
    const stdout = filterOutput(family, streams[2]!);
    const stderr = streams[4]!;
    return `${streams[1]}${stdout}${streams[3]}${stderr}`;
  }
  const lines = text.split("\n");

  if (family === "tsc") return text;

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
      keep.add(i);
    }
  }
  lines.forEach((line, index) => {
    if (SUMMARY.test(line)) keep.add(index);
  });
  const selected = [...keep].sort((a, b) => a - b);
  // Dense/ambiguous formats are safer as a full ordinary view.
  if (selected.length > lines.length * 0.8) return text;
  return selected.map((index) => lines[index]!).join("\n");
}
