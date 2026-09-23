# Review remediation: P1 and P2 defects

Updated: 2026-09-23.

Status: The latest reproduced R6 pagination regression is fixed. R2/R3 use the
original plan's explicit unavailable-capability fallback: all managed writes are
refused before judgment/approval and again at direct execution. The unsafe write
executor and its permit path have been removed. Safe managed writes are **not
implemented**; restoring them remains a capability release gate. The original
acceptance criteria below are unchanged.

The follow-up [managed write backend plan](2026-09-23-managed-write-backend.md)
defines the ownership model, feasibility prototype and release gates for
restoring a demonstrated write capability.

Review baseline: `d7c5d97`. Latest fixes follow validation of `dc1fb12`.

Validation: `bun run test` — 445 passing tests across 39 files;
`bun run typecheck` and `git diff --check` pass. The count replaces retired
executor-success tests with refusal/no-effect tests; no tests are skipped.

## Current evidence and status

| Finding | Enforced behavior | Evidence / remaining boundary |
|---|---|---|
| R1 | Both adapters bound source text before review/delivery; failures are reviewed and non-text output is withheld. | `present.test.ts`, R1 cases in `harness.test.ts`, Pi `attach.test.ts`. |
| R2 | Managed writes are unavailable on every current runtime, for all target paths. Refusal performs no staging, chmod, rename, or directory creation. | `paths.test.ts`, `tools.test.ts`, `harness.test.ts`. Restoring execution requires protected staging and an enforceable conditional commit; descriptor-relative traversal alone did not supply that. |
| R3 | Write approval cannot enable the unavailable executor; no write approval is requested or consumed. Other approval lifecycle checks remain active. | `approval.test.ts` and `harness.test.ts`. The former write permit/approval path is retired, not presented as an enabled safe executor. |
| R4 | POSIX managed groups receive TERM then KILL, with bounded pipe drainage even if the direct shell exits first. | Process tests in `tools.test.ts`. Deliberately detached daemons remain outside the stated contract; Windows supports direct-child cancellation only. |
| R5 | Captures use independent byte budgets and per-stream completeness metadata before presentation. | Capture tests in `tools.test.ts`, `harness.test.ts`, artifact tests. |
| R6 | Pages budget complete receipts and source bodies together; zero whole lines after receipt sizing trigger byte pagination. Search uses whole-line regex semantics. | `recovery-tools.test.ts`: exact reconstruction at 7,800, 7,900, 7,999, 8,000 and 8,001 characters, Unicode/non-default streams; delivered-continuation tests in `harness.test.ts`. |
| R7 | Artifact storage, ownership checks, retention and tombstones are session-scoped. | `artifact-store.test.ts` session/foreign-id/malformed-id cases. |

## Direct remediation after commit-stage validation (2026-09-23)

A controlled barrier after staging fsync reproduced an outside-file permission
change through a substituted temporary symlink, and a concurrent target edit
being overwritten after the preimage check. The helper still returned success.
Its final path-based chmod and rename did not enforce the claimed commit contract.
The supported POSIX operations in this backend provide no conditional replacement
against an approved version. Another check-then-rename loop would not close it.
The helper is removed; `writeCapability()` reports `unavailable`, the harness
refuses before asking anyone, and direct execution also refuses. No weaker
fallback or automatic shell retry is installed.

The receipt fitter also regressed when a 7,999- or 8,000-character line fit the
body budget but not its receipt. It delivered “lines 1–0” and repeated
`startLine=1`. Byte-pagination selection now uses the final fitted page count.
Boundary fixtures follow the displayed continuations and reconstruct the source.

Tests that asserted successful execution through the retired write backend are
replaced by tests of the unavailable contract, including no filesystem effects
for new/existing/outside/symlink/hardlink/directory targets and refusal despite
approval handlers or repeated direct calls. They are not skipped or counted as
proof of a transactional executor. Ordinary command approval tests remain.

## Historical validation notes

The following dated notes describe earlier implementations. Their write-safety
and completion claims were disproved or superseded by the commit-stage validation
above; they are not the current release status. The original requirements after
these notes remain the acceptance criteria for any future managed executor.

## Fourth independent validation follow-up (2026-09-22)

A fourth independent reproduction pass — after the third follow-up below — found the third pass's fixes were still insufficient in two areas, both in code that had passed all 461 tests and typecheck at the time. Both are now fixed with regression tests; documented here rather than silently absorbed into the table above, and the third pass's own section is left intact below as an accurate record of what it actually closed (not everything it claimed to).

1. **R2/R3 — the "captured before the wait" claim was false, and identity binding stopped at the anchor.**
   - `root_replaced_during_gate`: the mock Gate judge swapped the project root for a DIFFERENT REAL DIRECTORY (same name, identical file content) WHILE `engine.gate()` was being awaited. The write still went through, zero approvals. Root cause: `prepareWritePermit` — which actually reads live filesystem identity — was called from `beforeToolCall` AFTER `engine.gate()`/`runApproval()` resolved, not before. The code's own comments claimed this identity was "captured before any await," but that was describing the intent, not what the call site actually did: a permit built after an await has already had every opportunity for that await's attacker to act within it. This is exactly the "do not recapture changed filesystem identity after approval and call that authorized" failure mode.
   - `parent_replaced_after_gate`: after `beforeToolCall` returned (a clean, uncontested window), an intermediate directory one level under the root (`sub`) was replaced with a different real directory of the same name, containing a file with identical content. The write still went through. Root cause: the executor only ever verified the TRUST ANCHOR's device+inode — no intermediate directory in the chain had its identity checked at all, only that it wasn't currently a symlink (a check performed via a separate `stat`-then-`open`, itself a gap, not just a narrower one than the anchor's).

   **Fixed two ways.** First, `prepareWritePermit`'s call site in `packages/cli/src/harness.ts` moved to before ANY await — before the Jev `engine.gate()` call, before a human approval wait — so the identity it captures genuinely predates every window an attacker could act within, however long that window turns out to be; the existing path-based recheck stays only as an early, friendlier deny message, not as what makes this safe. Second, `prepareWritePermit`/`packages/cli/src/native/verified-write.py` were extended so EVERY intermediate directory between the anchor and the final file carries its own authorization-time precondition (exists, with device+inode, or expected-missing), verified on the descriptor the executor actually opens for it — open-then-fstat, never stat-then-open — before descending further; a directory expected missing is re-checked immediately before creation so a pre-created replacement isn't silently accepted as "the directory this call itself made." Auditing the same staging/commit path for equivalent gaps (per the explicit instruction not to fix only the two test shapes) found the FINAL FILE had the identical defect one level deeper: it was bound only by a content digest, so a file deleted and replaced by a byte-identical copy (same digest, different inode) would pass unnoticed. Fixed the same way: the final file's own device+inode is now also captured at authorization time and verified on the same descriptor its preimage digest is read from, which is now opened once (with `O_NONBLOCK`, so a FIFO dropped at the target path can't hang the process) instead of stat-then-reopened.
2. **R6 — the bound was still a fixed guess, just a different one.** `scan_bounded_match` (a match combined with a scan-cap-clipped tail) rendered at 8,057 raw characters; `long_pattern` (a 505-character but semantically simple valid regex) rendered at 8,382. Both exceeded the 8,000-character review boundary, and the harness's own backstop (`boundForReview`, applied in `afterToolCall`) silently chopped the tail off both times — taking the continuation notice and the `read_output` recovery pointer with it. Root cause: the third pass's fix still reserved a FIXED 400 characters for header+notes+continuation+recovery-pointer combined, computed independently of what that metadata's real, final content and length turned out to be — the same class of bug as the original R6 finding, just with smaller numbers.

   **Fixed with `fitPageToBudget`** (`packages/cli/src/output/recovery-tools.ts`): render the complete page for a candidate body size, measure the ACTUAL result, and shrink the body — never the header/notes/continuation — until the whole thing genuinely fits. The oversized-match truncated preview is sized the same way, from the real header/recovery-note/continuation text just rendered, not a second independent guess. Also bounded the caller-controlled strings that made the metadata's size unpredictable in the first place — search pattern, artifact id, stream name, and the unscannable-lines list — to a fixed, truthfully-marked display length, closing the underlying source of the problem rather than only enlarging the guess.

Regression scripts used for reproduction lived at `/private/tmp/brainstem-validation-fourth-pass.ts` (this pass) and the earlier `/private/tmp/brainstem-validation-third-pass.ts` / `/private/tmp/brainstem-validation-followup.ts` (outside the repo, not committed); the corresponding fixed-shape assertions now live in this package's own test suite (`packages/cli/test/{harness,paths,tools,recovery-tools}.test.ts`).

## Third independent validation follow-up (2026-09-22)

A third independent reproduction pass — after the second follow-up below — found the second pass's fixes were still insufficient in two areas, both in code that had passed all 446 tests and typecheck at the time. Both are now fixed with regression tests; documented here rather than silently absorbed into the table above, and the second pass's own section is left intact below as an accurate record of what it actually closed (not everything it claimed to).

1. **R2/R3 — execution still didn't consume the exact authorized action.** The second pass's toolCallId-keyed map carried only a preimage digest — it authenticated neither the write's target nor its content, and the executor's anchor-open step (`os.open(root, O_RDONLY | O_DIRECTORY)`, no `O_NOFOLLOW`) still trusted whatever the root's path string resolved to *at execution time*, not what it resolved to at authorization time. Three reproductions exploited exactly this:
   - `root_symlink`: authorize a write, then rename the project root aside and replace it with a symlink to an outside directory containing a same-named file, then execute. The old executor's anchor open followed the symlink without complaint.
   - `outside_approved_target_swap`: get real human approval for an outside-root target, then swap its parent directory for a symlink to an unapproved sibling with identical initial content, then execute. The outside-root path was still the older, weaker check-then-write fallback and had no anchor concept at all.
   - `changed_action`: after an in-root write is auto-approved, mutate the tool call's own arguments — target to an absolute outside path, content to something different — before `execute()` runs. Nothing compared the executed arguments back against what was authorized.

   **Fixed by replacing the preimage-digest map with an immutable, single-use `WritePermit`** (`packages/cli/src/paths.ts`): `prepareWritePermit` builds one exactly once, at authorization time, using values captured before any await; `executeWritePermit` consumes it exactly once, first verifying the executed content's digest still matches the permit (closing `changed_action`'s content half), then handing off to the descriptor-relative executor. The write tool's own `execute()` (`packages/cli/src/tools.ts`) additionally compares the executed target against the permit's canonical target key before ever touching the filesystem (closing `changed_action`'s target half), and refuses outright — never an unverified fallback — on a missing, already-consumed, or mismatched permit. The native helper (`packages/cli/src/native/verified-write.py`) now opens its trust anchor with `O_NOFOLLOW` and verifies that anchor's own device+inode identity against what was captured at authorization (closing `root_symlink` — this catches a *different real directory* swapped in under the same name, too, not just a symlink). Outside-root writes are no longer a separate, weaker path: they go through the SAME executor, anchored to the deepest existing real directory on the way to the approved target (closing `outside_approved_target_swap`), and are explicitly refused (not degraded) when the executor is unavailable, matching the in-root behavior. See README "Write safety" for the full guarantee and its remaining, now narrower, honestly-scoped residual.
2. **R6 search recovery — the underlying fragment-matching defect, not fully closed by the second pass.** The second pass's mid-line resume (`startCharInLine`) still tested a regex against a character-offset SLICE of a line — which is not the same as testing it against the line. Three reproductions: a match split exactly at the old scan-cap boundary (`MA` | `TCH`) was found on neither page; `^MATCH` falsely matched a resumed fragment that happened to start with `MATCH` even though the real line didn't start there; `MATCH$` falsely matched a first-page fragment that happened to end right after `MATCH`, before the line's real, longer ending. **Fixed by redesigning `searchContent`** (`packages/core/src/artifacts.ts`) to never test a fragment: a line already in progress when the scan budget (`maxScanChars`) is exhausted is always finished to its own true end regardless, bounded only by a much higher per-line ceiling (8x `maxScanChars`) that exists solely to stop one pathological line from making a single call scan unboundedly. A line beyond even that ceiling is reported via a new `unscannableLines` field — undetermined, explicitly never treated as an absent match — with a `read_output` recovery pointer, and scanning continues past it. This entirely supersedes and removes the second pass's `startCharInLine` mid-line-resume mechanism (`search_output` no longer accepts it): with fragment-testing gone, a scan never stops mid-line, so every resume is a clean line boundary and there is nothing left to reconstruct a partial line from.

Regression scripts used for reproduction lived at `/private/tmp/brainstem-validation-third-pass.ts` (this pass) and the earlier `/private/tmp/brainstem-validation-second-pass.ts` / `/private/tmp/brainstem-validation-followup.ts` (outside the repo, not committed); the corresponding fixed-shape assertions now live in this package's own test suite (`packages/cli/test/{harness,paths,tools,recovery-tools}.test.ts`).

## Second independent validation follow-up (2026-09-22)

A second independent reproduction pass — after the first follow-up above — found two remaining P1 defects, both in code that had passed all 430 tests and typecheck at the time. Both are now fixed with regression tests; documented here rather than silently absorbed into the table above.

1. **R2 — write authorization was still disconnected from execution.** The first pass's fix added a *recheck inside the gate hook*, which can only ever run before `beforeToolCall` returns — it cannot reach a swap that happens strictly AFTER that hook returns but BEFORE the write tool's own `execute()` runs, since Pi calls those as two separate steps with no way for the harness to intervene again in between. The reproduction proved this precisely: swap the target directory for a symlink after `beforeToolCall` resolves, then call `execute()` — `blocked=false`, `approvals=0`, the outside file got overwritten. **Fixed properly this time, not with another recheck**: `packages/cli/src/native/verified-write.py`, a real descriptor-relative executor, is now the only thing that actually performs an in-root write. It opens the canonical root once and walks every remaining path component relative to the *previously verified parent's own file descriptor* with `O_NOFOLLOW` — a symlink substituted into any ancestor, at any point, cannot redirect it, because the walk never re-resolves a path string and never follows a symlink it finds. The same verified fd chain also checks a preimage digest (supplied by the harness via a toolCallId-keyed map — the one channel available, since `beforeToolCall` has no way to pass data into `execute()`) inside that same boundary, so a concurrent content edit is bound through execution exactly like the target is. Neither Bun nor Node expose `openat`, so this executor is a `python3`/`python` subprocess, probed once and cached; when none is available (or on Windows), in-root managed writes are explicitly refused, never silently downgraded to the old check-then-write path. See README "Write safety" for the full guarantee and its one remaining honestly-scoped limitation.
2. **R6 search recovery — two more ways to skip evidence actually found.** (a) A match on a single line too long to fit one page made `fitWholeLines` return zero progress; the old code reported "no matches" and the continuation skipped straight past the line that DID match — the match was found (`totalMatches=1`) but never shown and never recoverable. Fixed: a match that can't fit whole is delivered as a bounded, explicitly truncated preview with a pointer to recover the full line via `read_output`, and the continuation correctly resumes after that now-delivered line. (b) A single line long enough that the internal 1,000,000-character scan cap lands *before* its own terminating newline had its continuation jump to "the next line" — permanently skipping the unscanned remainder of the current one, including a match sitting in it. Fixed: `searchContent` now reports the exact character count it scanned (not just a line count, which can't distinguish "this line was fully scanned and happens to be last" from "this line was cut off mid-way"), and `search_output` resumes *within* the same line via a new `startCharInLine` parameter when that's what happened.

Regression scripts used for reproduction lived at `/private/tmp/brainstem-validation-second-pass.ts` (this pass) and the earlier `/private/tmp/brainstem-remediation-validation.ts` / `/private/tmp/brainstem-validation-followup.ts` (outside the repo, not committed); the corresponding fixed-shape assertions now live in this package's own test suite (`packages/cli/test/{harness,paths,recovery-tools}.test.ts`).

## First independent validation follow-up (2026-09-22)

An independent reproduction pass against the initial implementation above found seven real defects the local test suite had not caught — passing tests are not proof of a closed acceptance boundary. All seven are now fixed and covered by new regression tests; documenting them here rather than silently folding them into the table above, since the documentation-vs-actual-behavior gap was itself part of what was found:

1. **R2 — symlink parent-swap during an in-flight gate call.** `writeFileVerified` re-resolved the write target but never compared it against what was actually authorized, and the harness's "auto" gate decision never re-verified anything before letting execution proceed. A parent directory replaced with a symlink WHILE the (slow, async) Jev call was awaited could redirect an auto-approved write outside the project root with zero approvals. Fixed: the harness now rechecks target identity and preimage immediately after the gate decision, for every write outcome, not just "ask".
2. **R4 — SIGKILL silently skipped when the direct child's pipes closed first.** The scheduled group-kill was gated on a `cleanedUp` flag set as soon as the direct child (and its own stdio) settled — but a backgrounded job with redirected stdio can outlive the shell that spawned it, leaving it alive and unsignaled. Separately, `exitPromise` listened on the ChildProcess `"close"` event, which Node/Bun additionally gate on stdio closing, so a detached descendant holding an inherited pipe open blocked the tool from ever noticing the direct child had exited at all. Also found: Bun 1.1.6's `process.kill()` throws on a negative pid instead of performing a real process-group kill. Fixed: group termination now races the direct child's own exit (via `"exit"`, not `"close"`) against the grace timer and always fires SIGKILL either way; a `kill(1)` subprocess fallback works around the Bun bug.
3. **R3 — the outside-root approval path skipped the prepared-action protections.** It built its approval request from just the target, omitting the diff summary and preimage recheck the normal ask path already had. Fixed: both paths now share one prepared-action builder.
4. **R6 read pagination — two infinite loops.** A multi-line capture whose first line alone exceeded the page budget fell through to a whole-line fitter that returned zero progress ("lines 1-0", looping forever); a line ending exactly at a complete multi-byte UTF-8 character had its boundary-safety logic incorrectly back up over that complete character, looping at the same byte offset forever. Both fixed with guaranteed forward progress, tested via full-reconstruction round-trips.
5. **R6 search pagination — false coverage claims and silent re-clipping.** Coverage was computed from the unclipped input length instead of what was actually scanned, so a search clipped by the internal scan cap claimed full coverage of lines never examined; resuming after a `limit`-truncated result skipped matches already found but not returned; and `search_output` never bounded its own page size, so a large match list got silently re-clipped by the harness's outer boundary while the header still claimed full completeness. Fixed: `searchContent` reports what it actually scanned, resumption always continues from the last delivered match, and `search_output` bounds and truthfully labels its own page.
6. **P2/R2 — atomic replacement discarded file permissions.** Replacing a 0600 or 0755 file via temp-file-then-rename left it at the process default mode. Fixed: the temp file is `chmod`'d to the prior file's mode (read from the same `lstat` that already rejected a symlink there) before the rename.
7. **R1 — the Pi adapter ran Sanitize before Focus.** The opposite of the plan's `capture -> focus -> bounded presentation -> review -> delivery` order — Focus's own selection became the delivered view without itself having been what Sanitize reviewed. Fixed: Focus now runs first, over a defensively-capped raw capture, and only its output is bounded and reviewed.

Regression scripts used for reproduction lived at `/private/tmp/brainstem-remediation-validation.ts` and `/private/tmp/brainstem-validation-followup.ts` (outside the repo, not committed); the corresponding fixed-shape assertions now live in this package's own test suite (`packages/cli/test/{tools,harness,approval,paths,recovery-tools}.test.ts`, `packages/pi-adapter/test/attach.test.ts`).

This plan addresses the seven findings from the project review. The IDs below are new review IDs, not the historical P1/P2 implementation phases. It precedes [runtime consolidation](2026-09-22-runtime-consolidation.md) and the [product benchmark](2026-09-22-product-validation.md). Fix the existing integrations before extracting their implementation into a shared package.

The review's local validation passed 369 tests, TypeScript, and the saved output-focus pilot verifier. Additional fixture reproductions exposed the defects below. Those reproductions must become repository tests; the temporary review script is not a maintained dependency.

## Scope and release contract

| ID | Priority | Defect | Required outcome |
|---|---|---|---|
| R1 | P1 | Model receives text Sanitize did not inspect; error text bypasses inspection | Every delivered untrusted text segment is covered by the applied review |
| R2 | P1 | Final file symlinks bypass outside-root write checking | Authorization and execution refer to the same filesystem target |
| R3 | P1 | Approval identity omits write contents | Approval permits only the immutable action shown to the user |
| R4 | P1 | Shell descendants survive timeout | Timeout/cancellation stops managed processes and settles collection |
| R5 | P1 | Output truncated before archival is marked complete | Artifacts preserve the bounded capture and report every capture limit |
| R6 | P1 | Recovery pages are silently reduced to 2,000 characters | Delivered ranges, completeness, and continuation describe the actual page |
| R7 | P2 | Sessions share artifact storage and eviction | Artifact ownership and retention are scoped to one session |

Keep Focus off by default. Preserve existing static denials, approval requirements, and explicit unavailable outcomes. This increment does not introduce a general sandbox for arbitrary shell commands or claim crash-resumable exactly-once execution.

## Delivery sequence

1. Add reproducible regression fixtures and implement R1 as a containment fix in both integrations.
2. Implement R2, then R3 using the corrected path/action identity.
3. Implement R4 independently of output selection changes.
4. Implement R7 before changing artifact layout and metadata in R5.
5. Implement R5, then R6; finish R1's exact-view coverage checks against the repaired capture/recovery path.
6. Run the full integration matrix, update contract documentation, and publish the compatibility notes.

Use one reviewable change per defect where possible. Small internal helpers are appropriate; the package extraction belongs to the next plan. New regression tests and the corresponding fix land together, with evidence that the test fails against the previous behavior.

## R1. Review exactly the delivered text, including failures

Primary files: `packages/cli/src/harness.ts`, `packages/cli/src/output/present.ts`, `packages/pi-adapter/src/index.ts`, `packages/core/src/engine.ts`, and the observation envelope builder.

- Replace independently applied `slice()` calls with one presentation boundary. Bound the complete rendered view before calling Sanitize/Verify, including source receipts and omission notices. Inspect nested envelope builders too: no downstream layer may silently shorten that view again.
- Retain a named character limit compatible with the current 8,000-character judge input cap; measure UTF-8 bytes separately. Never call a character count a byte count. Account for receipt overhead within the limit and avoid splitting Unicode characters.
- Apply `capture -> optional Focus -> bounded presentation -> Sanitize/Verify -> delivery` in the CLI and Pi adapter. Focus-selected text must not be introduced after review.
- Review untrusted failure text regardless of `isError`; preserve exit/status/error metadata after replacement. Distinguish internally generated fixed control messages from tool-supplied messages. Do not trust interpolated paths or exception text as fixed control messages.
- A blocked/unavailable review returns a fixed harness notice and no source text. A review annotation may be added after judgment only if it contains trusted harness-generated wording; it must not introduce new tool text.
- The lightweight adapter currently lacks recovery. For this remediation it may return an explicitly incomplete bounded view and must disclose unavailable recovery; never promise an artifact tool that does not exist. The shared runtime plan supplies the recoverable profile.
- Unsupported non-text content must retain an explicit unsupported/unreviewed classification or be withheld under a policy requiring review. Do not label an entire mixed result reviewed because its text passed.

Acceptance: scripted provider-visible context contains no source text absent from the judge's evidence. Cover a single 9,016-character line with a hostile tail, multiple text blocks, error results, Focus modes, a blocked result, and an unavailable judge. Hooks must return safe results even if artifact storage or review fails; do not throw source-bearing errors that Pi would forward without another review.

## R2. Bind filesystem checks to the actual write

Primary files: `packages/cli/src/paths.ts`, `packages/cli/src/tools.ts`, `packages/cli/src/harness.ts`, `packages/core/src/floor.ts`; corresponding Pi adapter boundary tests.

- Canonicalize the configured root once. Use one resolver for absolute/relative paths, home expansion, parent traversal, and execution. Eliminate the mismatch between policy resolution and `join(cwd, path)` execution.
- Default managed writes to regular files through a verified directory chain. Reject symlink components in the requested write route, including existing final symlinks and dangling symlinks, with a clear blocked outcome. Canonicalization of the configured root itself is permitted. Rejection is preferable to silently changing which file the user meant.
- Apply the static floor to the actual canonical target. An outside-root target must still take its existing deny/approval path before semantic Gate can allow it.
- Prepare a write handle/precondition record and keep execution tied to it. A second `realpath()` or final-component `O_NOFOLLOW` alone does not prevent parent-directory substitution.
- First implementation checkpoint: establish descriptor-relative, no-follow traversal and commit primitives on supported macOS/Linux runtimes. If Bun/Node lacks the required primitive, use a small scoped native helper or an isolated filesystem executor. Do not mark the race guarantee complete with a check-then-write implementation. Unsupported configurations return an explicit unavailable write capability.
- Use a verified parent handle for same-directory staging and atomic replacement, so writing a hard-linked destination does not modify the other link's inode. Define preservation of permissions and handling of new directories; do not silently replace directories or special files.
- Existing file contents and target identity become R3 preconditions. Detect changes during approval, and re-enter review rather than following a substituted target.
- For externally supplied adapter tools, preflight checking alone cannot enforce how their executor opens files. Declare this limitation and require a managed executor to claim the filesystem contract; never imply wrapping a hook creates an OS sandbox.

Acceptance: no write outside the approved target for final symlink, parent symlink, dangling link, sibling-prefix, absolute-path, traversal, and controlled parent/target substitution fixtures. Include the review reproduction: a link inside the repo to an outside file leaves the outside file unchanged and cannot auto-run. Race fixtures use explicit barriers, not probabilistic timing loops.

## R3. Make approvals immutable and action-specific

Primary files: `packages/core/src/approval.ts`, `packages/core/src/evidence.ts`, `packages/cli/src/harness.ts`, `packages/cli/src/main.ts`, and change-summary helpers.

- Introduce a local immutable prepared-action record. Its identity includes tool, canonical cwd/target, all validated execution arguments, write-content digest and length, and filesystem preconditions. Keep bounded log summaries separate.
- Copy and validate inputs before review. Pass a defensive read-only snapshot to the approval handler; retain private executable data. The execution wrapper must consume the prepared action or reject changed Pi arguments immediately before execution.
- Show the actual command or proposed diff/new-file content summary, relevant truncation notices, canonical target, and cwd. Provide a way to inspect the complete proposed change without exposing it indiscriminately in the journal.
- Recheck target identity and preimage before consuming approval. Relevant task/constraint revisions invalidate pending permission; unrelated task steering must not silently approve a stale action.
- Journal requested, approved/denied/cancelled/invalidated, and consumed outcomes with one action digest. Consume permission once inside the active run; neither retries nor cached judgments carry approval forward.
- Hash schemas are versioned. Historical hashes remain historical records and never confer executable permission.

Acceptance: mutating `validatedArgs.content`, nested args, cwd, or target after request cannot change the executed operation. A changed target preimage requires renewed review. Approval of action A never permits B; denied, cancelled, EOF, and missing-handler cases execute nothing. A normal approved write executes once with exactly the displayed bytes.

## R4. Terminate managed process groups and bound cleanup

Primary files: `packages/cli/src/tools.ts`; introduce a small process-lifecycle helper if needed.

- On supported POSIX platforms, launch commands in a managed process group and signal the group on timeout or cancellation. Do not rely solely on `spawn({ signal })` killing the immediate shell.
- Send termination, allow a short configurable grace period, then force termination of surviving group members even if the original shell has exited. Keep process identity/lifecycle state to avoid signalling a reused identifier after cleanup.
- Bound pipe drainage, reap the direct child, remove listeners/timers, and return one terminal result. Keep timeout, caller cancellation, spawn failure, and ordinary nonzero exit distinct.
- Collect output during cleanup under capture limits. Mark incomplete collection explicitly if cleanup cuts off a stream.
- Document the support boundary: a process group handles ordinary descendants, but cannot guarantee containment of a deliberately detached daemon. Strong hostile-process containment requires a sandbox/supervisor; benchmark tasks use that outer boundary. Unsupported platforms must not advertise process-tree cancellation.

Acceptance: parent/child/grandchild fixtures, a child ignoring termination, and a child holding pipes open settle within deadline plus grace/cleanup allowance. A descendant blocked on a fixture barrier cannot write after cancellation completes. Include cancellation before spawn, timeout/cancellation racing exit, and successful execution with no leaked timers.

## R7. Isolate artifacts by session

Primary files: `packages/cli/src/harness.ts`, `packages/cli/src/output/artifact-store.ts`, `packages/core/src/artifacts.ts`, and session/journal metadata.

- Store under `<journal-parent>/sessions/<sessionId>/artifacts`, with a session manifest recording project identity and artifact schema version. Use the session ID generated by `SessionRecorder`, not a timestamp-only directory name.
- Include session ownership in artifact metadata and validate it on load/read/search/list. Validate opaque IDs before deriving paths, and reject malformed or foreign metadata.
- Apply artifact-count/byte limits per session. Bound tombstone metadata too, with a documented retention horizon for distinguishing expired IDs from unknown IDs.
- Two sessions with journals in the same directory must neither read nor evict one another's artifacts. Do not load legacy shared-directory artifacts into a new session implicitly.
- Preserve old files. Document legacy layout incompatibility with new-session recovery; explicit offline migration/resume can be a later feature. Do not delete old evidence during this fix.

Acceptance: concurrent sessions under one parent cannot retrieve each other's known IDs, and exhausting one store leaves the other intact. Reopening a store for its explicit original session preserves its artifacts. Test forged ownership, malformed IDs, and corrupt metadata.

## R5. Archive captures before presentation limits

Primary files: `packages/cli/src/tools.ts`, `packages/core/src/artifacts.ts`, `packages/cli/src/output/artifact-store.ts`, `packages/cli/src/harness.ts`.

- Separate finite capture limits from display limits. Remove the 50,000-character combined-output cap and `.trim()` from the archival path. Keep an explicit configurable bounded capture; unlimited buffering is not the goal.
- Preserve stdout/stderr as separate captured streams, including whitespace, with byte counts and documented rendering order. Do not imply concatenation reconstructs temporal interleaving. Preserve raw bytes or explicitly record decoding losses in the text projection.
- Record bytes observed, bytes retained, and capture completeness/reason per stream. If the original source size is unknown, represent it as unknown; never infer full output from retained length.
- File reads use bounded streaming rather than reading an unlimited file into memory and then clipping it. Mark file-size/capture limits. Preserve empty captures as empty artifacts; `(no output)` is presentation wording, not source content.
- Search/glob result limits also report that enumeration is incomplete. Error/cancelled captures receive the same archival contract when data exists.
- Store the bounded capture before presenting it. Journal truthful artifact hashes, capture limits, and presented-view references; retention failure produces an explicit unavailable recovery outcome.

Acceptance: a 60,000-character output is recoverable in full under the configured capture limit and never marked complete after losing 10,000 characters. Cover output beyond per-stream caps, a file beyond its cap, stderr-only failures, empty output, leading/trailing whitespace, split Unicode, interrupted streams, and disk-write failure.

## R6. Make recovery pagination truthful and complete

Primary files: `packages/cli/src/output/recovery-tools.ts`, `packages/cli/src/output/present.ts`, `packages/cli/src/harness.ts`, `packages/core/src/artifacts.ts`.

- Route recovery results through their own bounded page renderer and the R1 review boundary. Never apply the 2,000-character telemetry excerpt as a model-facing recovery view.
- Keep line-based requests compatible, and add an opaque continuation cursor with artifact/content identity, stream, next byte offset, and query identity where applicable. Long lines may span pages; receipts must identify partial lines and byte ranges.
- Choose page content and its receipt together within the review limit. Return actual delivered ranges and explicit end-of-capture/end-of-source distinctions. A clipped capture can reach its end without reaching the original source's end.
- Search pages distinguish scanned coverage, retained matches, and total matches only when known. Empty selection, no matches in the scanned region, incomplete scan, expired artifact, foreign/unknown ID, and empty source remain distinct.
- Review every recovered page, including error messages containing untrusted input. Recovery never reruns a command and never triggers recursive artifact capture of its own rendered notices.

Acceptance: repeated recovery reconstructs the retained 200-line fixture without gaps or duplicate source bytes; a large single line also progresses. Receipts match exactly what was delivered. Search cursors preserve coverage, foreign/stale cursors fail explicitly, and hostile content in late pages is reviewed before delivery.

## Verification and completion

Run targeted defect tests per change, then `bun run test` and `bun run typecheck` at integration milestones. Run process fixtures under both Bun and the Node/Vitest environment on macOS/Linux where supported. Keep all tests offline and inside scratch directories.

Before declaring this plan complete:

- All seven original reproductions pass as regression tests, including assertions against final provider-visible messages and actual filesystem effects.
- Existing approval, Focus, recovery, replay, and runtime-contract tests pass without weakening their assertions.
- README and adapter documentation describe actual supported guarantees and limitations.
- Add a dated correction to the earlier harness-evolution plan: its completed checkboxes for complete sanitization, descendant cleanup, recoverability, and budgets are historical claims, not proof of these repaired contracts. Preserve that history rather than silently relabeling it.
- Record any deferred platform capability explicitly. R2's race guarantee and R4's managed-process guarantees are release gates for claiming those capabilities, not optional documentation follow-ups.
