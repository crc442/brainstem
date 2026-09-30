export type Family = "testrunner" | "tsc";

const PATTERNS: { family: Family; pattern: RegExp }[] = [
  { family: "tsc", pattern: /^((npx|bunx)\s+)?tsc\b|^(npm|bun|pnpm|yarn)\s+(run\s+)?typecheck\b/ },
  {
    family: "testrunner",
    pattern: /^((npx|bunx)\s+)?(vitest|jest|pytest)\b|^(go|cargo)\s+test\b|^(npm|bun|pnpm|yarn)\s+(run\s+)?test\b/,
  },
];

const NOT_SIMPLE = /[;&|<>`$(){}#\\\n]/;

export function detectFamily(command: string): Family | null {
  const trimmed = command.trim();
  for (const { family, pattern } of PATTERNS) if (pattern.test(trimmed)) return family;
  return null;
}

export function isSimpleCommand(command: string): boolean {
  return !NOT_SIMPLE.test(command);
}

const FAILURE = /\b(FAIL|FAILED|ERROR|AssertionError|Expected|Received)\b|Error:|✗|×|^\s+at\s|\berror TS\d+\b/;
const SUMMARY = /^(Tests?|Test Files|Suites?|Snapshots?|Duration|=+ (FAILURES|short test summary))/i;

export function filterOutput(family: Family | null, text: string): string {
  if (family === null) return text;
  const lines = text.split("\n");

  if (family === "tsc") {
    const diagnostics = lines.filter((line) => /error TS\d+/.test(line));
    return diagnostics.length > 0 ? diagnostics.join("\n") : text;
  }

  // A green run carries no failure evidence to select, so trimming it would only
  // remove the reassurance that it passed.
  if (!lines.some((line) => FAILURE.test(line))) return text;
  return lines.filter((line) => FAILURE.test(line) || SUMMARY.test(line)).join("\n");
}
