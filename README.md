# brainstem

A coding-agent harness where Jev (TypeSafe's System One model) makes bounded judgments — gate, sanitize, verify, pulse, steer — and the LLM only generates.

## Who owns what

| Owner | Responsibilities |
|---|---|
| Harness code | Execution, permissions, budgets, context assembly |
| Jev (System One) | Narrow semantic judgments over supplied evidence (gate/sanitize/verify/pulse/steer) |
| Main model | Strategy, code, explanations |
| User | Intent, constraints, approvals |

## Reflexes

Implemented: **Gate**, **Sanitize**, **Verify**, **Pulse**, **Steer**, **Select**, **Focus**

**Tend** is a later checkpoint workflow, not a continuous filter.

What each reflex is shown is as much a part of the contract as what it decides:

| Reflex | Evidence it receives |
|---|---|
| Gate | The real action — the command, or for a write a bounded diff (existing file) or first-40-lines summary (new file), flagged when the evidence is incomplete. The approval hash stays out of it. |
| Sanitize / Verify | One bounded envelope: task, source, action summary, capped intent, status, truncation, and the exact content actually delivered — never a second independent slice of the raw capture. Reviewed regardless of `isError`: a thrown tool error's text gets the same review as any other output, not a bypass. The bound is one shared character cap (`packages/core/src/presentation.ts`, `REVIEW_CHAR_CAP` = 8,000 chars) applied once, before both Sanitize and delivery — a single very long line cannot exceed it either. |
| Pulse | Recent actions with statuses, labelled repeat counts, failure fingerprints, and whether the approach changed — all computed in code. |
| Steer | The latest completed observation and the active capability descriptions. |
| Select | One independent relevance judgment per optional catalog capability, batched by size; code always includes baseline and explicit selections. |
| Focus | One independent relevance judgment per structural output section (paragraphs, header/child groups, or line windows), with a dependency closure and a byte budget. Off by default — see below. |

Literal facts are never delegated: containment, counts, durations, exit codes and
budgets are computed in code. A write resolving outside the project root skips
Gate's judgment entirely and takes the static floor verdict.

## Setup

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

The approval's identity (its `actionHash`) covers tool, canonical resolved
target/cwd, all validated non-content arguments, and — for a write — a digest
and byte length of the proposed content plus a digest of the file's existing
content at request time. Approving a write with one payload never permits a
different payload, and a file edited (or its target substituted) between
request and resolution invalidates the approval instead of silently executing
against whatever now sits at that path. The interactive approval prompt is
shown the actual proposed diff/new-file summary, not just the command or path;
the durable journal entry stays bounded (hash + reasons only).

Without an approval handler (a non-interactive run), an `ask` returns a blocked
tool result telling the agent to ask the user, and the CLI exits nonzero.

## Write safety

Every managed write — in-root or an approved outside-root target alike — is
executed by a real descriptor-relative (`openat`-style) filesystem executor
(`packages/cli/src/native/verified-write.py`, invoked as a subprocess from
`packages/cli/src/paths.ts`), not by a path-based check followed by a
separate path-based write. It opens a **trust anchor directory** with
`O_NOFOLLOW` and verifies that anchor's own device+inode identity against
what was captured at authorization time — not merely that the path string
still resolves to *something* — then walks each remaining path component
relative to the *previously verified parent directory's own file descriptor*,
also with `O_NOFOLLOW`, and only ever writes and renames within that final
verified directory's fd. A symlink substituted into any ancestor — including
the anchor itself — or a *different real directory* swapped in under the
anchor's own name, cannot redirect the write: the walk never re-resolves a
path string from scratch, never follows a symlink it encounters, and never
trusts an anchor whose identity has changed. The same verified fd chain also
checks (when the harness supplies one) that the target's *current content*
still matches a sha256 digest computed at authorization time, so a concurrent
edit is rejected exactly like a concurrent symlink swap. An existing file's
permission bits are preserved onto the replacement.

What actually gets executed is bound by an **immutable, single-use
authorization permit** (`WritePermit`, built by `prepareWritePermit` at
authorization time — before any await a Jev judgment or a human approval
wait could let an attacker act within — and consumed exactly once by
`executeWritePermit`). The permit fixes the target's canonical identity, the
content's digest, the anchor's device+inode, and the preimage digest; the
write tool's own `execute()` refuses outright — never falls back to an
unverified write — if the toolCallId it's given has no permit (missing,
already consumed, or the write never went through the harness's approval
flow), if the requested target no longer matches what the permit authorized,
or if the requested content no longer matches it either. Approving one write
never authorizes a different target, different content, or a replayed
permit.

Neither Bun nor Node expose `openat`, so this executor is a `python3` (or
`python`) subprocess — verified once per process to support the required
`os.*(dir_fd=...)` operations, then cached. **If no such interpreter is
available (or on Windows), managed writes are explicitly REFUSED** — in-root
*and* outside-root alike — `writeCapability()` reports `"unavailable"` and
every write attempt fails with a clear reason, rather than silently falling
back to a path-based check-then-write that only looks equally safe. The
original review remediation plan for R2 does not contain an escape hatch
that permits an unsafe managed write to stay enabled; "unavailable" is that
plan's own prescribed outcome, not a workaround for not having built the
real thing.

A write whose target resolves *outside* the configured project root already
requires explicit interactive human approval every time (never
auto-approved, unlike an in-root write) — but it is no longer a separately
weaker code path. It goes through the SAME descriptor-relative executor,
anchored to the deepest existing real directory on the way to the approved
target (there is no single fixed anchor, like `/`, that could safely walk
an arbitrary outside-root location without breaking on ordinary system
symlinks such as macOS's `/tmp` → `/private/tmp`), so a symlink or
different-real-directory swap of that anchor — even one performed strictly
after a human approved the write — is caught the same way a root swap is.

**Supported guarantee:** for both in-root and approved outside-root writes,
a symlink (or a different real directory) substituted for the trust anchor
or any intermediate ancestor, the target's content changed, or the tool
call's own target/content mutated, at any point before this call —
including while an earlier Jev gate call or human approval wait was still in
flight, and including the window after that decision returns but before the
tool's own `execute()` runs, which no amount of *rechecking inside the gate
hook* can ever reach on its own — is rejected, not silently followed. This
is real, kernel-enforced descriptor-relative traversal bound to an
authorization permit, not a second preflight check layered on top of
ordinary path-based I/O. **Not claimed:** protection against an ancestor
*above* the anchor (for an outside-root target only — the in-root anchor is
the project root itself, with nothing above it in scope) being swapped after
that anchor was already chosen; and protection against a directory being
replaced with a *different real directory* of the same name in the
sub-syscall gap between this executor's own successive `stat`-then-`open`
calls for one already-descended-into intermediate ancestor (as opposed to
the anchor, whose identity IS verified) — closing that specific, much
narrower residual case would require the OS to expose atomic
`O_NOFOLLOW`-verified-identity opens for every path segment, which even
`openat()` alone does not guarantee.

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