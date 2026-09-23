# Managed write backend: design and feasibility

Date: 2026-09-23
Status: Design proposal; prototype and runtime integration not implemented
Baseline: `fa59e21` — managed writes explicitly unavailable

The [review remediation plan](2026-09-22-review-remediation.md) specifies the
R2/R3 safety requirements and unavailable fallback. The [runtime plan](2026-09-22-runtime-consolidation.md)
defines prepared actions and permits. Neither selects a backend that enforces
authorization through commit. This plan addresses that gap before re-enabling
writes; it does not replace the original requirements with weaker guarantees.

## Decision to establish first

There are two different product contracts:

| Contract | Required guarantee | Current disposition |
|---|---|---|
| Write into the user's existing checkout | Other editors/processes can modify it; commit must not overwrite an unapproved version or affect another target. | Unavailable until an actual enforcing mechanism is demonstrated. |
| Write into a controlled session workspace | A broker owns authoritative versions; tools work on a confined projection and propose changes for publication. | Candidate for a feasibility prototype, not yet a supported capability. |

Prototype the second contract first. It creates a place where every authoritative
write can pass through one transaction boundary. It is a proposed additional
workspace mode, **not proof that the existing-checkout contract is solved**.
Applying its output to the user's checkout is a separate operation with the same
original concurrency problem. Exporting a patch must not be reported as applying
it. Keep the existing CLI `write` refusal until a supported execution profile and
its exact filesystem effects have been validated.

## W0. Define ownership and the threat model

Write down, and test, which actor can access each resource:

- The model, tool arguments, repository content and command subprocesses are
  untrusted. Tool code can attempt symlink swaps, staging substitution, arbitrary
  paths, stale permits and direct writes that bypass the broker API.
- Editors and other sessions may change the user's original checkout at any time.
  A session must not overwrite those changes during import, export or application.
- Only the trusted broker may modify authoritative versions, approval records,
  commit receipts and protected staging. Specify the OS identity/mount/access
  boundary that actually prevents tool subprocesses from touching them.
- A directory outside the checkout, random names, mode 0700 under the same user,
  a separate process, or a Git worktree is not accepted as evidence of this
  isolation. Test denied access from the actual command-execution identity.
- Do not claim protection against arbitrary privileged host processes. State
  that trust boundary explicitly. A malicious same-user process with access to
  broker storage must not be quietly assumed unable to modify it.

Deliverable: a platform/capability table for macOS and Linux identifying enforced
boundaries, prerequisites, unsupported configurations and fail-closed behavior.
Windows and remote/network filesystems remain unavailable unless separately
validated. No installation, daemon deployment or production configuration change
is needed to write the design or run the transaction-model tests.

## W1. Prototype versioned commits independently of the filesystem

Build a small offline experiment under `experiments/managed-write/`. Candidate:
a SQLite-backed store with file bytes, modes, versions, permits and receipts in
the **same database transaction**. Keep prototype APIs independent of Pi and the
CLI; do not start the larger runtime extraction here.

Proposed operations:

1. `prepare`: capture session/workspace identity, base revision, normalized
   relative target, expected file version or absence, exact proposed bytes and
   mode, action digest, and task/constraint revision in a private record.
2. `approve`: bind a decision to that record. Approval does not hold an open
   database transaction while waiting for a human. Changed content, target or
   task constraints require a new preparation and review.
3. `commit`: in one transaction, verify authorization and expected revision,
   publish exactly the approved content/mode, consume the permit and record the
   result. A revision conflict publishes nothing. Require explicit re-review;
   do not automatically rebase the approval onto newer contents.
4. `result`: distinguish committed, conflict, denied, cancelled and unavailable.
   A retry with the same operation identity returns its existing receipt or a
   clear refusal; it never applies the operation twice.

Test two real connections/processes and restart behavior. Required cases include
competing commits, missing-file creation races, modified arguments, content/mode
changes, cross-session and replayed permits, cancellation before commit, process
death around commit, and loss of the response after a successful commit. Define
the transaction commit as the point after which cancellation cannot undo an
already committed effect. Keep bytes in the database for this first experiment;
an external blob store would add a separate publication/durability problem.

Pass condition: stale actions never publish, readers observe complete versions,
and receipts agree with durable state after restart. This demonstrates the
transaction model only. It does **not** demonstrate OS isolation or host-file
replacement safety.

## W2. Prove the real execution boundary

Choose and test an OS-enforced sandbox, container/VM arrangement or separately
privileged broker suitable for each supported platform. A design without a
working enforcement boundary remains unavailable.

- Materialize an immutable approved snapshot into a disposable execution area;
  imported host files must not be writable aliases/hardlinks to the originals.
- Run shell/build tools with access to that area but no broker database,
  approval state, host checkout, credentials or protected staging access.
- Treat command-produced files as untrusted proposals. Their existence does not
  authorize publication. Ensure reads, commands and managed writes agree about
  which revision they operate on; no hidden second filesystem view.
- Reject symlinks/special files and define mode, executable-bit, directory and
  file-size policies at import/publication. Do not derive authorized paths from
  an untrusted post-approval directory walk.
- Test staging mutation, ancestor replacement, direct broker access, inherited
  descriptors, surviving descendants, and cancellation during materialization.
  Use explicit barriers and inspect effects from a separate process.

Pass condition: the adversarial command process cannot mutate authoritative
state except through a validated transaction. Controlled tests against the
removed executor must either be impossible at the enforced access boundary or
fail without outside-file changes, lost edits or successful false receipts.

## W3. Import, export and application contract

Define how dirty/untracked files, concurrent editor saves, symlinks, modes and
multiple sessions enter the session snapshot. A changing host file must produce
a documented snapshot or an import conflict, never a false claim of a consistent
whole-project snapshot.

Initially export a reviewable change artifact with its base revision and exact
new content. Do not automatically apply it to the live checkout. Investigate
host application separately: identify the conditional-commit or enforced
exclusive-ownership mechanism, then reproduce target/preimage changes at its
actual publication boundary. Advisory cooperation alone cannot satisfy a threat
model that includes writers bypassing that cooperation.

Deliverable: a feasibility report distinguishing session commits, confined
command execution, export, and host application. State which are demonstrated
and which remain unavailable. A snapshot-only success needs an explicit product
decision about the additional workspace mode before CLI integration.

## W4. Integrate only the demonstrated capability

- Map the proven backend to the runtime plan's `PreparedAction` and
  `ExecutionPermit`; avoid reviving the old path-based permit executor.
- Advertise the exact supported workspace/write profile. Keep unsupported
  in-place and outside-root writes refused before judgment or approval.
- Exercise approvals, direct execution, provider-visible success/error results,
  lifecycle cleanup and multiple sessions through both adapter profiles.
- Re-enable a write capability only after its platform tests pass; record the
  backend/version and capability in session metadata. Keep command execution's
  containment claims separate from file-commit claims.

## Sequence and stopping criteria

Land W0's contract and W1's experimental model first, in separate commits with
tests. Follow with W2's platform proof before any production integration.
Stop and report unavailable if isolation or conditional commit cannot be
demonstrated. No live-model calls, paid benchmark, automatic host application,
or replacement of the runtime/product-validation plans is part of the prototype.

## Technical basis

- SQLite documents serializable transactions between connections and serialized
  writers. That makes it a candidate for W1's authoritative version/permit
  transaction; it does not protect database files from unauthorized OS access.
  [SQLite isolation](https://www.sqlite.org/isolation.html).
- Linux documents atomic replacement, exchange and no-replace rename operations.
  None of those interfaces accepts an expected content version. Our conclusion
  is that another preimage-check-plus-rename sequence would retain the reproduced
  gap; this is not a claim that every possible storage backend is incapable.
  [Linux rename manual](https://man7.org/linux/man-pages/man2/rename.2.html).
- Git worktrees provide additional working trees with shared repository
  resources. We will treat them as organization, not as a security boundary.
  [Git worktree documentation](https://git-scm.com/docs/git-worktree).
