# Plugin integration: capability aid, output focus, and judgment gates

Date: 2026-09-22

Revised: 2026-09-27

Status: Implemented for the public API, Pi adapter, and reference CLI; live product validation remains separate

Brainstem supplies fast System One judgments to a main agent. It can recommend useful tools or skills, select relevant tool output, and judge whether a message or proposed action should proceed. The host applies those judgments and owns the agent loop, tool execution, permissions, approval UI, isolation, and whole-agent budgets.

This revision supersedes this document's earlier managed-runtime proposal. Shared judgment and evidence handling remain useful; a new execution controller, execution permits, and transactional filesystem backend are outside this plan. The [P1/P2 remediation history](2026-09-22-review-remediation.md) remains a source of regression cases, with its current plugin-scope correction taking precedence over historical executor requirements. The [product-validation plan](2026-09-22-product-validation.md) measures all seven reflexes independently and together. The three uses below explain the product; they do not reduce the reflex set.

## The three product flows

| Event | Brainstem's job | Host's job | Example |
|---|---|---|---|
| Incoming user message or task update | Recommend relevant capabilities from the host's available catalog | Expose selected tools or load suggested skills under existing host policy | A request to debug a UI suggests browser inspection and the project's frontend skill |
| Tool result arrives | Select task-relevant evidence and review the view that will reach the agent | Retain original output, provide retrieval if supported, deliver the resulting view | A long test log becomes the failing tests and their diagnostic context |
| Message or proposed action needs checking | Return allow, block, or request-approval advice with reasons and uncertainty | Enforce its permission rules, apply the verdict, and resolve approval requests | An instruction to expose a secret is flagged before it reaches an action; a proposed upload is checked against the user's authorization |

An **aid** returns recommendations the host or main agent may use. A **gate** runs at a host-defined blocking boundary. A gate recommendation becomes effective only when that boundary applies it. Brainstem must not describe an advisory integration as an enforced gate.

## All seven reflexes remain in scope

| Reflex | Aid or gate function | Host application point |
|---|---|---|
| Select | Suggest useful tools and skills | Incoming message/task update, before context and capabilities are prepared |
| Focus | Select relevant evidence | Tool result presentation |
| Gate | Judge whether a message or proposed action should proceed | Pre-message or pre-tool boundary; message review is an extension to today's action Gate |
| Sanitize | Flag injected instructions in untrusted evidence | Before evidence enters the main agent's context |
| Verify | Judge whether a result supports the intended outcome | After tool results, before the agent decides its next step |
| Pulse | Detect stalled progress and suggest intervention or stopping | Host-provided progress checkpoints |
| Steer | Recommend an appropriate model tier | Before a main-model call at a supported routing boundary |

Pulse and Steer are supporting aids throughout the task, not extra executors. The host applies a Pulse intervention/stop or a Steer model recommendation under its own lifecycle, permissions, and budgets. Each reflex remains independently usable and configurable.

## Baseline before implementation

- Core already contains Select, Focus, Gate, Sanitize, Verify, Pulse, and Steer decisions. Existing mechanisms are reused where they fit; all seven remain part of the public integration plan. An adapter must explicitly declare any unsupported trigger or application point.
- The public `createReflexes` facade exposes Gate, Focus, and observation (Sanitize/Verify). Select exists in core and the reference CLI but is not exposed through that facade or attached to incoming messages by the Pi adapter.
- The Pi adapter composes before/after tool hooks. It currently supplies command/path to Gate, without host-provided change evidence. Its Focus mode is off by default and has no built-in recovery service.
- Existing Gate judges proposed tool actions. Sanitize examines tool evidence. Neither should be presented as an already implemented incoming-message gate.
- `genericJudge` supplies synthetic confidence of `1`. This must become explicit unavailable confidence before parsed choices can support automatic approval policies.
- The reference CLI has additional capture, recovery, capability, and approval behavior. Extract shared plugin behavior where it removes duplication; retain host-specific implementations in the CLI.

## Ownership and package boundaries

| Component | Responsibility |
|---|---|
| `@brainstem/core` | Provider-neutral inputs/results, evidence metadata, question construction, decision policies, validation, cache/journal contracts |
| `@brainstem/reflexes` | Public judgment API, provider adapters, reusable message/action/output orchestration, decision events |
| `@brainstem/pi-adapter` | Translate supported Pi lifecycle events, compose existing hooks, apply configured verdicts/views, pass host capabilities and cancellation |
| `@brainstem/cli` | Reference host: tools, local execution, approval UI, output storage/recovery, model setup and agent lifecycle |
| Other hosts | Their own integrations with the same public API and declared lifecycle capabilities |

Start with internal modules in existing packages. Create a separate package only if a demonstrated dependency or reuse boundary warrants it. No new `@brainstem/runtime` package is required by this plan.

The plugin may receive an abort signal, judgment deadline, and judgment-call limit. It must bound its own work and ignore stale results. The host remains responsible for stopping main-model calls, tools, descendants, and the overall run. A plugin timeout cannot imply those operations stopped.

## Delivery units

| ID | Work | Depends on | Completion gate |
|---|---|---|---|
| A0 | Pin lifecycle and host ownership contracts | Current behavior inventory | Each flow has explicit trigger, delivery point, mode, and unavailable behavior |
| A1 | Shared evidence and decision contracts; honest confidence | A0 | Missing evidence/confidence cannot masquerade as complete or certain |
| A2 | Capability suggestions on incoming messages | A1 | Public API and supported adapter deliver relevant suggestions before model dispatch |
| A3 | Shared output selection and review | A1 | Both integrations deliver the reviewed view with truthful omission/recovery metadata |
| A4 | Message and action gates | A1 | Distinct inputs, host enforcement, and approval handoff work end to end |
| A5 | Progress and model-selection aids (Pulse/Steer) | A1 | Host checkpoints and model boundaries consume recommendations without transferring loop ownership |
| A6 | Contract suite, telemetry, examples | Incrementally with A2–A5 | All seven reflexes are testable independently and together through public integration paths |

Recommended sequence: A0/A1, then A2 as the first product slice, followed by A3, A4, and A5. Add tests and telemetry with each slice. Offline product-validation fixtures can start immediately; live evaluation of a slice waits only for that slice's contracts to pass.

## A0. Pin lifecycle and integration behavior

- Inventory exports, installed Pi extension points, hook ordering, and the CLI's message dispatch. Specify which events count as incoming user messages/task updates; tool results and plugin-generated annotations are separate events and must not recursively trigger message handling.
- Provide a host-callable message preparation API even if Pi lacks an attachable pre-message hook. If a wrapper around prompt dispatch is required, make that integration step explicit rather than claiming `attachReflexes` intercepts messages automatically.
- Support explicit off, shadow, and active behavior per flow. Shadow records a judgment without changing context or permission outcomes. For active behavior, declare whether recommendations are advisory or enforced at a host boundary.
- Existing host denials remain authoritative. Brainstem cannot grant a tool, permission, or skill that the host does not make available. No plugin decision overrides a host block or resolves an approval by itself.
- Define task/session/revision identifiers and lifecycle cleanup. A result for an older message or ended session must not alter the next prompt. Hook disposal restores host behavior and does not leak listeners or state across sessions.

Acceptance: scripted host/Pi fixtures demonstrate where each input enters and where its result is applied. Unsupported hooks and missing services are explicit integration capabilities.

## A1. Shared inputs, evidence, and decision semantics

Use small contracts that preserve the distinction between source evidence, a model-facing view, and a judgment. Names below are illustrative; do not introduce types without a consumer.

| Contract | Required meaning |
|---|---|
| Message context | User message, task/session revision, relevant constraints, and source/trust labels for attached or quoted material |
| Capability recommendation | Available catalog revision, suggested tool/skill IDs, reasons, evaluation coverage, and unavailable/partial status |
| Action evidence | Tool identity and argument snapshot, host action ID/revision, optional host-supplied diff/summary, evidence completeness; not an execution permit |
| Captured output | Host source reference, stream identity, retained/observed coverage where known, capture status; an in-memory source is sufficient for simple hosts |
| Presented output | Exact text/blocks, source ranges, omissions, candidate-scan coverage, and optional host recovery reference |
| Reviewed output | The exact presented view reviewed, separate Sanitize/Verify outcomes, supported content coverage, and resulting delivery decision |
| Gate verdict | Subject and revision, allow/block/ask result, reasons, evidence gaps, uncertainty, and policy version |

Keep source completeness distinct from presentation omissions and review coverage. Unknown source size is unknown, not complete. Source ranges must have a declared unit and stream identity; preserve Unicode correctness. Display line numbers cannot substitute for unambiguous source ranges.

- Separate full action arguments from bounded display/log summaries. Decisions refer to the snapshot reviewed; the host must re-evaluate if it changes the action. The plugin does not promise to make a host's execution atomic.
- Treat tool text, skill descriptions, and quoted documents as evidence, not authoritative instructions to the judge. Preserve role/source labels and bound inputs explicitly.
- Represent confidence as unavailable or numeric with provenance. Provider-reported, self-reported, and empirically calibrated signals are different. Preserve unknown usage and distributions rather than fabricating zeros or one-hot probabilities.
- Update provider parsing, policies, cache keys, journals, and replay together. Legacy results without provenance cannot be silently treated as calibrated. A parsed generic answer alone is insufficient for automatic approval.
- Define fallback per flow: suggestions leave the host's existing capability set in place; Focus falls back to the host's declared bounded presentation; an enforced uncertain/unavailable gate requests host approval or returns unresolved/blocked when approval is unsupported. Shadow behavior never changes delivery.
- Wire shared provider timeout/circuit-breaker behavior where appropriate. Cancellation ends plugin work, and late responses cannot update current context. Do not claim remote compute cancellation when unsupported.

Acceptance: unavailable versus zero confidence, partial evidence, mutation/stale revisions, Unicode source spans, cancellation, and incompatible cached answers have meaningful tests.

## A2. Capability aid on each incoming message

Expose Select through the public reflex API and integrate it at message preparation. Each incoming user message/task update is evaluated against the current task and available catalog; exact repeated inputs may reuse a valid cached judgment.

- Accept host-supplied capability IDs, descriptions, availability, dependencies, baseline capabilities, and explicitly requested tools/skills. Brainstem neither installs tools nor reads arbitrary skill files on its own.
- Return useful capability suggestions and concise reasons. The host may surface them to the main agent or load their schemas/skill instructions before dispatch. Loading remains subject to host policy.
- Preserve baseline and explicitly requested available capabilities. An empty recommendation means no additional suggestion, not removal of essential tools. Missing explicit capabilities are reported, not fabricated.
- Keep relevance separate from permission. Selecting a tool never authorizes its use; selecting a skill does not elevate instructions found inside it.
- Cache by task/message and catalog/policy revision. Reuse stable loaded prefixes when selections do not change, and avoid repeatedly inserting the same skill instructions.

Acceptance: a new task, changed task, no useful capability, unavailable explicit skill, large catalog, misleading description, cancellation, and repeated messages produce the expected next model context. Include a fixture that shows the main agent actually using a suggested capability.

## A3. Relevant output with a shared review boundary

Share the plugin-owned flow across the CLI and Pi integration:

```text
host supplies output and source metadata -> optional Focus
-> bounded presented view -> Sanitize/Verify when enabled
-> host delivers the resulting view and omission/recovery metadata
```

- Reuse current selection and review logic rather than inventing another output implementation. Original host transformations occur before the final plugin review. Later changes to source content require review again when review is enabled.
- Focus chooses evidence relevant to the current task, retaining source spans and coverage. Exact-value questions, exhaustive counts, and insufficient candidate coverage must be allowed to request retrieval or preserve more evidence instead of pretending a summary is sufficient.
- The host retains omitted output and implements recovery if available. Recovery reads stored output and follows the same enabled review policy; it never reruns a side-effecting tool to reconstruct evidence.
- If recovery is unavailable, advertise that fact. Keep Focus opt-in in that integration and disclose unrecoverable omissions. Distinguish Focus selection from truncation before Focus saw the source.
- Cover successful results, errors, existing after-hook overrides, long lines, large pages, and unsupported content kinds. Text-only judgments do not imply images or opaque blocks were reviewed. Preserve host protocol requirements under an explicit content policy.
- Keep Sanitize and Verify independently configurable for evaluation, even when production combines their provider request. Review outcomes are judgments, not guarantees that content is safe or correct.

Acceptance: inspect the next model request, not just helper calls. It contains the selected/reviewed view and accurate coverage notices; host-backed recovery reconstructs omitted evidence without executing the original tool again.

## A4. Message and action gates with host approval handoff

Implement distinct entry points for incoming-message review and proposed-action review. Reuse policy and provider plumbing where appropriate; their evidence and permission semantics differ.

- Message review distinguishes a direct user request from quoted text, retrieved instructions, and tool-origin material. It can flag attempted instruction overrides or suspicious requests without treating all imperative text as malicious. Keep policy restrictions and injection judgments distinguishable.
- An allowed message is not blanket authorization for later tools. Action review examines the actual proposed arguments plus optional bounded change evidence supplied by the host. Missing or truncated evidence remains visible in the verdict.
- The host chooses whether a message verdict is an advisory annotation or a blocking pre-dispatch decision. Blocking happens before model dispatch. Action blocking happens before tool dispatch. Record which boundary actually applied the decision.
- Map existing Gate `auto_run`/`deny`/`ask` semantics deliberately to the public host contract; avoid silently changing existing consumers while adding message review.
- An approval-capable host receives the reviewed subject/revision, reasons, and evidence summary. A host without an approval service returns unresolved/blocked for `ask`, with a clear reason. Brainstem must not invent approval or claim to replace an existing permission service.
- Enforce configured deterministic restrictions before semantic approval. Unknown confidence, unavailable review, or mutated subjects cannot create a new automatic permission. Existing approvals remain scoped to the host's actual authorization rules.

Acceptance: allowed requests, malicious instructions, benign quoted attacks, legitimate security work, uncertain judgments, missing change evidence, existing host denials, approval handoff, and mutated actions are covered. Tests show both an advisory host and an enforcing host applying the same verdict correctly.

## A5. Progress and model-selection aids

Expose the existing Pulse and Steer behavior through the public API and connect it to declared host lifecycle points.

- Pulse receives a bounded host-supplied progress history, recent actions/results, current objective, and task revision. It returns continue/intervene/stop advice with reasons. The host decides how to add an intervention or stop its agent loop; Pulse is not a substitute for hard host budgets.
- Preserve the distinction between a legitimate retry after changed evidence and repetition without progress. Suppress duplicate interventions, scope history to the task/session, and discard stale judgments.
- An unavailable Pulse judgment leaves the host's progress policy in control; it must not invent a stop or override a host deadline.
- Steer receives the current task context and a host-approved model catalog/pair. It recommends a supported tier/model; the host owns provider credentials, model switching, conversation compatibility, and dispatch.
- Missing routing evidence or unavailable judgment keeps the host's configured primary model. Selection cannot introduce an unavailable model or bypass host spend limits. Unknown confidence must not be treated as certainty that a cheaper tier is sufficient.
- Keep model/tool context stable where possible. Record the model the host actually used, not only the recommendation, and account for judgment latency and prompt-cache effects.

Acceptance: scripted progress checkpoints cover repeated failure, productive retries, interventions, and a host-applied stop. Model-boundary fixtures cover accepted/declined routing, unsupported models, uncertain results, and cancellation. Inspect subsequent host behavior and model requests, not only emitted recommendations.

## A6. Integration contracts, telemetry, and release checks

Run shared plugin contract fixtures through the public API and supported Pi/CLI entry points. Match expectations to declared host capabilities rather than requiring each host to become the CLI.

| Contract | Cases |
|---|---|
| Message aid | Every user-message trigger, catalog changes, explicit capabilities, stable context, stale results |
| Output evidence | Long lines, large recovery pages, incomplete captures, Unicode, error text, hook overrides, retrieval |
| Gates | Prompt/action distinction, source roles, uncertainty, host denials, approval mutations, missing services |
| Progress and routing | Productive retries versus stalls, intervention deduplication, host-applied stops, model fallback and actual dispatch |
| Lifecycle | Multiple sessions, foreign recovery references, cancellation, provider outage, attach/dispose behavior |
| Modes | Off makes no judgment calls; shadow changes no behavior; active applies only its configured flow |

Keep symlink/file-write and descendant-process regressions in reference-host tests. They validate that host's tools, not a filesystem or process-containment guarantee supplied by Brainstem.

Record flow, trigger/subject revision, judgment, effective mode, host-applied outcome, provider usage/provenance, latency, cache hit, fallback, selected capabilities, output coverage, and recovery. Link to host run IDs so the benchmark can combine plugin overhead with total task cost. Do not require storing full sensitive prompts or tool content in telemetry.

With each implementation slice, run focused tests, then the repository test suite and typecheck as appropriate. Update API examples and README to show the three primary uses, all seven reflexes, declared host requirements, and limitations. Stage delivery without removing Pulse or Steer from the implementation or validation scope.

Done means a host can consume all seven reflexes independently or together to aid or gate its main agent; supported adapters apply those results honestly at declared lifecycle boundaries; and the benchmark can measure their value and overhead without a new executor product.


## Implementation record — 2026-09-27

| Unit | Delivered evidence |
|---|---|
| A0 | Explicit Pi prompt/preparation wrapper; host ownership and supported hook boundaries documented; off/shadow/active modes; scoped cancellation and disposal |
| A1 | Unavailable confidence/usage, provenance-aware policies/cache/replay, bounded judgment service and breaker, action snapshots, captured/presented/reviewed output contracts |
| A2 | Public Select and per-message preparation; baseline/explicit/dependency handling; host loading or agent-facing suggestions; stale-load rejection |
| A3 | Shared `processOutput` used by CLI and Pi; exact bounded review, Unicode/named-stream ranges, omission/coverage metadata, host-backed recovery |
| A4 | Separate message/action inputs, source roles, incomplete-evidence escalation, host approval callback and argument-change invalidation |
| A5 | Public Pulse/Steer; Pi progress checkpoint and actual model dispatch integration; host-owned stop/routing and conservative fallbacks |
| A6 | Shared CLI/Pi lifecycle fixtures, adapter regression tests, metadata-only judgment and applied-outcome telemetry, integration guide and typechecked example |

Validation: 478 tests across 43 files, repository typecheck, whitespace checks, and a network-free Bun public-API smoke check. The added integration contracts inspect actual model requests and tool execution. Existing host-specific symlink, approval, descendant-process, recovery-page, and multi-session regressions remain in the suite.

See [the integration guide](../integration/plugin.md) for exact defaults and limitations. Incoming messages must use the wrapper or host preparation API; queued/direct dispatch is not automatically intercepted. Recovery storage, whole-agent budgets, and executor isolation remain host services. No live provider benchmark or product-value claim is included in this implementation.
