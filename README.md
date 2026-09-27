<p align="center"><img src="assets/wordmark.png" alt="brainstem" width="420"></p>

A plugin layer that adds bounded System One judgments to a coding agent: assess proposed actions, review tool output, and guide the host agent's next step. Jev (TypeSafe's System One model) supplies judgments; the host agent owns execution.

## Who owns what

| Owner | Responsibilities |
|---|---|
| Host agent/runtime | Tool execution, filesystem permissions/isolation, approval UI, execution budgets |
| Brainstem plugin | Judgment evidence, reflex policies, reviewed output, integration hooks |
| Jev (System One) | Narrow semantic judgments for all seven reflexes |
| Main model | Strategy, code, explanations |
| User | Intent, constraints, approvals |


`@brainstem/reflexes` exposes the judgment API. `@brainstem/pi-adapter` attaches
it to an existing Pi agent through message preparation, tool hooks, progress checkpoints, and model routing. `@brainstem/cli` is a runnable
reference host demonstrating the integration; its local tools are not a sandbox
or a transactional workspace product. A safe custom filesystem backend is not a
prerequisite for using the plugin.

## Reflexes

Implemented: **Gate**, **Sanitize**, **Verify**, **Pulse**, **Steer**, **Select**, **Focus**

**Tend** is a later checkpoint workflow, not a continuous filter.

What each reflex is shown is as much a part of the contract as what it decides:

| Reflex | Evidence it receives |
|---|---|
| Gate | The reference CLI supplies the command or a bounded write diff/new-file summary, flagged when incomplete. The Pi adapter snapshots arguments and accepts host-provided change evidence. Message Gate separately reviews incoming requests and source-labelled attachments before host dispatch. |
| Sanitize / Verify | One bounded envelope: task, source, action summary, capped intent, status, truncation, and the exact content actually delivered — never a second independent slice of the raw capture. Reviewed regardless of `isError`: a thrown tool error's text gets the same review as any other output, not a bypass. The bound is one shared character cap (`packages/core/src/presentation.ts`, `REVIEW_CHAR_CAP` = 8,000 chars) applied once, before both Sanitize and delivery — a single very long line cannot exceed it either. |
| Pulse | Recent actions with statuses, labelled repeat counts, failure fingerprints, and whether the approach changed — all computed in code. |
| Steer | The latest completed observation and the active capability descriptions. |
| Select | One independent relevance judgment per optional catalog capability, batched by size; code always includes baseline and explicit selections. |
| Focus | One independent relevance judgment per structural output section (paragraphs, header/child groups, or line windows), with a dependency closure, character budget, and UTF-8 source ranges. Off by default — see below. |

Literal facts are never delegated: containment, counts, durations, exit codes and
budgets are computed in code. A write resolving outside the project root skips
Gate's judgment entirely and takes the static floor verdict.

## Use the plugin

The public API exposes all seven reflexes independently. Use `createPluginSession`
for scoped message preparation and approval handoff, or `attachReflexes` for a Pi
host. Its returned `prompt()` wrapper runs incoming-message judgments; tool hooks
alone do not intercept user messages. Select can pass suggestions to the main
agent or ask the host to load the recommended tools/skills.

See the [integration guide](docs/integration/plugin.md) for lifecycle boundaries,
off/shadow/active modes, recovery, confidence semantics, and telemetry. The
[typechecked example](packages/pi-adapter/examples/host-plugin.ts) shows how the
host connects all seven reflexes. Generic judges report unavailable confidence;
parsing an answer does not automatically authorize an action.

## Run the reference CLI

```sh
bun install
```

`.env` needs `TYPESAFE_API_KEY` and `ZAI_API_KEY` (bun auto-loads it). Example:

```sh
bun packages/cli/src/main.ts --cwd /tmp/repo --task "fix the failing test" --trust 0.5
```

## Trust dial

`trust` raises/lowers the auto-run CONFIDENCE BAR (`policy.ts`: `autoConfidence = 0.95 - 0.35*trust`). `trust 0` does NOT mean "ask about everything". Safety thresholds (deny lines, credential nouls) never change with trust.

## Approvals

A gate `ask` opens a pending approval and waits inside the pre-execution hook.
Approval permits that exact validated action once; denial, EOF, and cancellation
execute nothing, and neither elapsed time nor an empty response approves. If the
action changes between request and resolution, the approval is invalidated.

Approval identity includes the executable arguments; changing them while approval
is pending invalidates the request. In the reference CLI, a write approval shows
the proposed diff and applies only to the captured path and content. Detected
file changes during review invalidate the proposed write.

Without an approval handler (a non-interactive run), an `ask` returns a blocked
tool result telling the agent to ask the user, and the CLI exits nonzero.

## Reference CLI file writes

The CLI's `write` tool creates and replaces local files. It demonstrates the
plugin workflow: prepare an action, apply static policy, ask System One for a
judgment, request approval if needed, then execute the reviewed action.

The CLI rejects final symlinks and non-regular targets, requires approval for
allowed outside-project writes, and preserves static denials for sensitive
paths. Execution checks the exact approved path/content, consumes that action
once, and rejects file changes detected since review. Replacement uses private
staging, descriptor-based permission changes, and rename; existing permissions
are preserved and hard-linked copies are not modified in place.

These are ordinary local-tool safeguards. Checks and rename are separate
operations: an editor or another process can still change a file between them.
The CLI does not promise transactional conflict detection or protection against
hostile processes modifying its filesystem. Its `bash` tool also runs with the
host user's permissions. Use the host's sandbox or other isolation when needed.

Plugin consumers keep their own executor, permission system, and concurrency
policy. Attaching Brainstem does not replace those systems. The earlier
[transactional backend proposal](docs/plans/2026-09-23-managed-write-backend.md)
is deferred as a separate execution-product idea, not plugin release work.

## Managed process termination

The `bash` tool launches commands in their own POSIX process group (via
`detached: true`) and, on timeout or cancellation, signals the whole group —
not just the immediate shell — with SIGTERM, a short configurable grace
period, then SIGKILL. SIGKILL is sent as soon as the direct child's own exit
is observed (or the grace period elapses, whichever comes first) — not tied
to whether that child's stdio has also closed, since a backgrounded job with
redirected stdio can outlive the shell that spawned it while remaining in the
same group. Pipe drainage is separately bounded past that point so a
lingering or detached descendant holding a pipe open cannot hang the tool
call indefinitely.

Two runtime specifics this relies on: process exit is detected via the
ChildProcess `"exit"` event, not `"close"` (`"close"` additionally waits for
stdio to end, which never happens if a descendant inherited those same pipe
fds without redirecting them); and because Bun 1.1.6's `process.kill()`
rejects a negative pid outright instead of performing a real process-group
signal, group termination falls back to shelling out to the `kill(1)`
binary, which is unaffected by that validation.

**Supported guarantee:** ordinary parent/child/grandchild descendants,
including a process that ignores SIGTERM or one with redirected stdio that
outlives the shell that spawned it, are terminated within the configured
deadline plus grace/cleanup allowance — independent of whether the direct
child's own exit or stdio settles first. **Not claimed:** containment of a
deliberately detached daemon (e.g. a double-forked process that leaves the
group via `setsid`) — that requires an outer sandbox/supervisor boundary,
which this harness does not provide; such a descendant is bounded only by
the drain timeout, not actually terminated. Windows has no process-group
kill primitive here and falls back to signalling only the direct child; this
is a documented platform limitation, not process-tree cancellation.

## Output artifacts and recovery

Every captured tool result — success or a thrown tool error, including empty
output — is stored whole, as separate named streams (`stdout`/`stderr` for
`bash`, a single `output` stream for everything else), before any reduced
view is presented, so nothing the model was not shown is lost. The bash
tool's own capture limit is a per-stream byte cap (256,000 bytes), decoupled
from the much smaller character budget used for what's actually displayed —
a 60,000-character capture is never marked complete after silently losing
characters to a display-oriented cap, and a `read` beyond its size limit is
read with bounded streaming, never loaded whole into memory first. Whitespace
is preserved; `(no output)` is presentation wording substituted at delivery
time, never baked into the archived capture.

Artifacts are stored per session, under
`<journal-parent>/sessions/<sessionId>/artifacts` (the session id comes from
`SessionRecorder`, never a timestamp-only directory name). Every artifact is
stamped with its owning session and validated on every read; a malformed or
foreign id is rejected before any filesystem path is ever derived from it.
Two sessions sharing a journal parent directory can never read or evict each
other's artifacts. Tombstones (evicted-but-remembered metadata) are bounded
by a retention horizon; beyond it a purged id reports "unknown" rather than
"expired" — the store genuinely no longer has evidence to distinguish the
two. Pre-existing artifacts from the old shared-directory layout are neither
migrated nor deleted by this change; a new session simply never reads them.

Two always-available tools recover a capture without rerunning the command:

```
read_output({ id, stream?, startLine, lineCount, startByteInLine? })
search_output({ id, stream?, pattern, limit, startLine? })
```

Responses carry their real source ranges (or, for a single line too large for
one page, an explicit UTF-8 byte range and a `startByteInLine` continuation
value) and completeness markers, and pass through the same bounded
presentation and sanitize path as any other tool result — including hostile
content in a late recovery page. Unknown ID, unknown stream, evicted artifact,
capture truncation, and empty source are distinct outcomes — never a bare "no
output". Both tools guarantee forward progress and never silently drop
evidence they actually found:

- `read_output` bounds a page to whole lines unless even the first requested
  line doesn't fit, in which case it falls back to UTF-8-byte-range
  pagination of that one line (never splitting a multi-byte character,
  including a complete one that happens to sit at the exact end of the page
  window).
- `search_output`'s `startLine` resumes a prior page using its own delivered
  receipt, never a caller-assumed formula like "scanned-to plus one" (which
  would skip matches already found within the scanned region but withheld by
  `limit`). It bounds its own delivered match list to the same review budget
  as everything else, with an explicit "page bounded" note distinct from
  "scan bounded by size" (the internal 1,000,000-character scan cap,
  reported via a `scannedLines`/`scannedChars` pair that reflects what was
  actually scanned, not the full requested range). A single match whose own
  formatted line is too large to fit one page is never reported as "no
  matches" — it is delivered as a bounded, explicitly truncated preview with
  a pointer to recover the full line via `read_output`.
  A regex is never evaluated against a character-offset fragment of a
  line — doing so silently breaks anchors (`^`/`$`), lookaround, and any
  pattern spanning the cut point. A line already in progress when the scan
  budget is reached is always finished to its own true end (bounded by a
  much higher per-line ceiling, not the scan budget itself), so resuming is
  always a clean line boundary. A line beyond even that higher ceiling is
  reported as unscannable — undetermined, never as an absent match — with a
  pointer to inspect it directly via `read_output`; scanning continues past
  it rather than stalling.

## Focus rollout

`--focus-mode off|shadow|on` (default `off`) controls whether Focus's section
selection ever shapes what the model sees:

- `off` — the artifact's bounded view is the first 10 lines plus a recovery
  notice, same as always. No Focus judgment runs.
- `shadow` — Focus runs and its decision is journaled (mode, status, section
  manifest hash), but the presented view is unchanged from `off`. Use this to
  evaluate selection quality and cost before trusting it to shape output.
- `on` — a `"select"` decision presents only the relevant sections plus a
  coverage receipt (`showing K of N sections... use read_output or
  search_output to recover the rest`); a `"full"` or `"compute_or_retrieve"`
  decision falls back to the bounded view. Internal scores never appear in
  presented text. Sanitize always judges the exact bounded view the model
  will see, never a separate slice of the raw capture.

## Replay

```sh
bun packages/cli/src/main.ts replay <journal.ndjson> [--trust N] [--mode policy|reevaluate]
```

Re-scores recorded judgments offline against a different policy, resolved strictly by `judgmentId` — never by "the most recently seen judgment of this type," which could silently misattribute an unrelated earlier judgment's answers to a decision that was never actually sent to Jev. The report distinguishes three outcomes: `replayed` (a resolved judgment, re-decided — this is what `unchanged`/`changed` count), `static-only` (no judgment at all — a floor verdict, never replayable), and `unsupported` (a `select`/`focus` decision, whose bitmap outcome can't be reconstructed without the full catalog or section manifest recorded alongside it — not yet journaled; visible in the report rather than silently dropped).

`--mode reevaluate` (new live judgment calls, not offline reuse of recorded scores) is recognized but not implemented — it exits with an explicit error rather than silently no-op'ing. `--mode policy` (default) never makes an API call. Side effects and human approvals are never replayed; approval remains a recorded historical outcome that a changed policy cannot manufacture.

## Answer cache

Every reflex — gate, sanitize, verify, pulse, steer, select, focus — shares one bounded, in-memory exact-answer cache by default (no configuration needed; pass `answerCache` to `createHarness` to override or disable). A judgment is cached only on success and is checked *before* any budget gate, since reuse costs zero new provider calls; on a hit, the cached answers are re-validated against the current question table before use, and a stale/incompatible entry silently falls through to a fresh call rather than surfacing as a new failure. Concurrent identical requests are deduplicated into one in-flight call. Journal `reflex` events record `cacheHit`/`cachedFromJudgmentId` so a cache hit's provenance stays distinguishable from a fresh one. See `docs/tasks/p10.md` for what's covered and what's deliberately deferred (gate batching, pulse/steer/select fusion, a buffered journal sink, gate prefetch, journal seeding).

## Versions

The `@earendil-works/pi-*` dependencies (0.86.1) are pinned deliberately; upgrades are explicit checks.

## Packages and builds

The public core, reflexes, and Pi adapter packages build ESM and type declarations with `bun run build`. Published exports point to `dist`; repository tests and development scripts resolve current workspace sources. See each package README for installation.

MIT licensed; see [LICENSE](LICENSE).
