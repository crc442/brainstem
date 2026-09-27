# Paired validation

Start here:

```sh
bun run eval:paired:dry-run
bun run eval:paired:offline /tmp/brainstem-paired-v1
bun run eval:paired:report /tmp/brainstem-paired-v1
```

These commands make no provider calls. The offline run has 12 development fixtures × 11 arms × 1 repetition = 132 jobs, each in a fresh Bun worker. The report writes `report.json` and `report.md` next to the run manifest. Use a directory outside the repository.

This is the first part of the [product-validation plan](../../../docs/plans/2026-09-22-product-validation.md). It checks the production Pi adapter with scripted main-agent steps and scripted judge answers. It doesn't measure whether a real agent benefits from Brainstem. The 12 fixtures are public regression data, not the planned 12 coding tasks or a held-out corpus. See the [recorded smoke result](smoke-2026-09-27.md).

The arms are baseline, deterministic controls, one arm for each of Select/Focus/message Gate/action Gate/Sanitize/Verify/Pulse/Steer, and the full plugin. Gate has two boundaries; there are still seven reflexes. Each arm gets the same tool catalog, action trace, synthetic files, approval oracle and resource limits.

- Baseline uses the Pi host with an 8,000-character output prefix and no plugin. Deterministic uses the plugin with every semantic component off: it adds the shared presentation/recovery notices. Neither makes judge calls.
- Select supplies advice while every arm retains the complete tool catalog. It doesn't manufacture a baseline disadvantage by hiding tools.
- Focus receives the retained source before presentation. Recovery reads its archived tail; it never repeats the original tool. The fixture read/write/bash tools are in-memory recording stubs. They don't access real project files or execute shell commands.
- The host requires approval for `config.txt` writes and rejects absolute/traversing paths in every arm. The common oracle approves only `config.txt`. Project writes can still violate the task objective; those proposals and effects are counted even though the fixture cannot harm real files. Plugin approvals are counted separately, including duplicate confirmation.
- Steer can select `offline-primary` or `offline-mini`. These are labels for the scripted dispatcher, not real model comparisons. Non-Steer arms use the primary label.
- Every run creates a new agent, plugin session and judgment cache. The manifest records runtime versions, source revision/content hashes, fixture snapshots, protocol, effective arms, seeded order and all jobs. Scripts and labels are frozen together; grading reads outcomes and fixture facts, not judge confidence.

The external worker deadline covers the whole run, including initialization. The script enforces main-call and request-byte limits; the plugin enforces the judgment-call ceiling. There is no paid driver. The configured token/spend limits and null model/pricing fields are planning inputs only; the dry run never presents an estimate as an enforced monetary ceiling.

Resume uses the same command and directory. A claim is written before each worker starts. Claimed jobs are never automatically rerun, including interrupted ones. A mismatched manifest is rejected. Source/environment changes during execution stop the study and invalidate the affected result. If the runner process itself dies, first verify that it and its worker have exited before removing `runner.lock`. Retain interrupted attempts; use a new directory for an explicitly labeled rerun.

Reports include every scheduled job, missing/interrupted/invalid records, timeouts, failed rubrics, paired coverage, forbidden proposals/effects, approvals, recovery, judge calls, local cache hits and all-attempt worker latency. Refusals are separate from allowed-work completion. API cost is exactly zero for completed scripted runs; missing accounting remains unknown. Provider prompt-cache usage is unavailable. With 12 samples per arm, p50/p95 are descriptive smoke measurements that include process startup.

Next work is the real coding-task corpus and live driver: freeze model IDs, provider settings, billing/token bounds, cache conditions, host isolation, grading, retry rules and the actual spending ceiling. Expand the boundary fixtures and independently review ambiguous labels. Size and freeze held-out tasks after the development study; the manifest generator rejects a held-out run when no held-out tasks exist. The current runner rejects live commands.
