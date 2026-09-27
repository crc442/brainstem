# Live configuration pilot

```sh
bun run eval:paired:live:dry-run
bun run eval:paired:live /tmp/brainstem-live-pilot-v1
bun run eval:paired:live:report /tmp/brainstem-live-pilot-v1
```

`live` makes paid requests using `ZAI_API_KEY` and `TYPESAFE_API_KEY`. The user authorized live validation on 2026-09-27. The frozen [protocol](protocol.ts) caps this development study at $20, with a $1 reservation limit per run. The full matrix's conservative request bound is $13.285982208: four tasks × baseline/deterministic/full/fixed-mini = 16 runs, up to six main-model and 24 judge calls per run. There are no billable warmups, retries or auxiliary calls. Model-list availability checks are separate read-only requests.

The primary model is GLM-4.7, mini is GLM-4.5-Air, and judge is Jev 1.13.0. Temperature is zero; GLM thinking is disabled, with at most 2,048 output tokens per request. The account's model catalog exposes Air, so this pilot uses it instead of FlashX. Model IDs are pinned and response IDs checked; provider-side weights can still change behind those IDs.

Prices were checked against the [Z.AI pricing page](https://docs.z.ai/guides/overview/pricing) and [TypeSafe model reference](https://docs.typesafe.ai/models) on 2026-09-27. Per million tokens, GLM-4.7 input/cached/output is $0.60/$0.11/$2.20, Air is $0.20/$0.03/$1.10, and Jev input is $0.042 with free output. Each request reserves uncached cost for the full published context limit, rounded up to 204,800 main tokens or 65,536 judge tokens, plus the main output cap. This avoids assuming a tokenizer's bytes-to-tokens ratio. Reservations remain charged to the experiment on errors or timeouts; they aren't claims about what the provider ultimately billed. The ceiling assumes the documented API rates and token limits, not an account-level billing control.

The tasks are small configuration edits: a missing package export diagnosed from a long log, strict TypeScript settings, and a hostile/benign pair of project notes. They use fresh in-memory file trees and independent JSON/invariant checks. Model-proposed edits never execute as code, and the tools expose no filesystem, environment, shell or network access. Provider credentials stay in the experiment transport. `check` returns a pass/fail result; it doesn't expose the expected object. This is a narrow coding-workflow pilot, not the plan's representative 12-task corpus.

All arms have the same tools, constraints, output ceiling, recovery service and permission oracle. Every write requests host approval; the oracle allows only the user-authorized file. Forbidden proposals are still counted when host permissions prevent their effects. Select advises while keeping all tools available. The full plugin enables all seven reflexes, with two Gate boundaries. Fixed-mini has the baseline host using Air; it helps interpret full-plugin routing results. Pulse runs every two tool turns. Judge deadlines are 10 seconds; main requests have a 60-second timeout; an external worker watchdog stops the entire task at 180 seconds. Exact judgment caches start empty; provider prompt-cache reads are measured where reported, without assuming cold caches.

The run directory contains the frozen prompt, fixtures, source hashes, protocol and counterbalanced job order. A durable claim reserves each run before dispatch. Each network request writes a reservation to its call ledger before sending it, then appends its response status and usage. No automatic retries or selective reruns. A provider error stops the remaining matrix; those jobs stay missing. Claimed/interrupted jobs aren't repeated on resume. Don't remove a stale lock until the runner and its worker have exited. A new study needs a new directory and must still fit the authorized aggregate budget.

Reports retain failure statuses and all-attempt cost/latency. Missing cache counts make exact cost unknown; the uncached upper estimate is reported separately. Failed requests retain their reservation. Provider usage times published rates is an estimate, not an invoice. Pi's numeric cost fields in message transcripts are placeholders; use the transport ledger for accounting.

Interpret this as development evidence. Four tasks can't establish completion noninferiority, gate safety or p95 latency. Individual reflex ablations, code-edit tasks, independent label review, held-out sampling and broader host/model replication remain.
