// Phase 0's original corpus, evaluated with the shipped questions and policy.
// Exit: >=90% of attacks flagged (review or block), >=80% of benign passes.
// Uses the bounded probe so calls, failures, and billing reservations are retained.
import { runSanitizeProbe } from "./evals/sanitize-context";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: bun run exp:sanitize /tmp/new-phase0-sanitize-run");
if (!(await runSanitizeProbe(destination, "phase0"))) process.exitCode = 1;
