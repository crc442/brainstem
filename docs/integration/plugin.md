# Integrating Brainstem with a host agent

Brainstem provides seven independent reflexes. The host executes tools, owns permissions and approvals, retains output, and controls the main agent's resources. Use one `createReflexes` instance per session so caches, the circuit breaker, and progress history have a clear owner.

## Public API and lifecycle

| Reflex | Public API | Pi integration |
|---|---|---|
| Select | `select()` or `createPluginSession().prepareMessage()` | `handle.prompt()`/`prepareMessage()` evaluates the host catalog for each incoming user message |
| Focus | `processOutput()`; `focus()` remains a low-level selection helper | After the original tool-result hook, before final presentation |
| Gate | `messageGate()`, `gate()`; scoped approval through `createPluginSession` | Message wrapper and before-tool hook |
| Sanitize | `observe()` or `processOutput()` | Exact bounded presented text, including errors that reach the hook |
| Verify | `observe()` or `processOutput()` | Same text; independently configurable from Sanitize |
| Pulse | `pulse()` or session `checkpoint()` | After-turn checkpoint, every three turns by default |
| Steer | `steer()` or session `route()` | Before each model dispatch, using a host-provided alternative model |

`attachReflexes(agent, reflexes, options)` returns a handle. Existing code may continue ignoring the return value for tool hooks. Incoming-message features require `handle.prompt(text, options)` or an explicit call to `handle.prepareMessage(...)` before host dispatch. Direct `agent.prompt`, `steer`, and `followUp` calls are not intercepted as incoming user messages. Plugin-generated progress interventions do not recursively trigger Select or message Gate.

For an explicit preparation call, inspect `allowed` and `isCurrent()` immediately before dispatch. A newer message or disposal invalidates the old preparation. Message approval never authorizes a later tool action.

## Modes and defaults

Each entry in `modes` accepts `off`, `shadow`, or `active`:

- `off`: no judgment request for that reflex.
- `shadow`: compute and report judgments without applying their recommendations or verdicts.
- `active`: apply the result at the declared host boundary.

The Pi adapter defaults Gate, Sanitize, and Verify to active; Select, Focus, message Gate, Pulse, and Steer default to off. `gateBehavior: "advisory"` makes active gates advisory; the default is `"enforce"`. Advisory gate results are available in callbacks and returned review results; they do not block dispatch. Existing host denials remain authoritative in either mode.

Bounding, source-completeness notices, and host permission rules are deterministic behavior, independent of semantic modes. Text-only review withholds non-text blocks when Sanitize or Verify is active. With both off/shadow, existing non-text blocks remain governed by the host.

The reference CLI exposes the same per-reflex controls through `HarnessOptions.reflexModes`. Its defaults preserve existing behavior: Gate, Sanitize, Verify, Select, and Pulse are active; Steer runs when a mini model is provided; message Gate is off; Focus uses the existing `focusMode` setting. `--focus-mode off|shadow|on` remains compatible. Other per-reflex switches are library configuration, not new shell flags. Reference-host static denials and required approvals remain enabled even when semantic Gate is off or shadow.

## Capability suggestions and loading

Select needs a host-supplied catalog, available IDs, and baseline IDs. Explicit requests and dependencies remain separate from relevance scores. Missing explicit capabilities are reported. The plugin does not install tools or read skill files.

Without `loadCapabilities`, the Pi wrapper inserts a concise capability suggestion for the main agent. With that callback, the host returns `{ tools, skillInstructions? }`; the adapter applies the loaded data only if the message and catalog are still current. The callback should load data, not mutate the agent. Stable selections reuse the loaded set and avoid adding duplicate skill instructions.

Catalog descriptions are judgment evidence. Loading a selected skill is a host policy decision; selection grants no new permission. A host can use `prepareMessage()` to inspect recommendations and implement its own presentation.

## Actions and approval

The Pi adapter snapshots tool arguments and accepts an optional `actionEvidence(context, signal)` callback for a bounded diff or change summary. It does not open files to produce that evidence itself. A write without change evidence is explicitly incomplete and cannot receive an automatic semantic approval. Changes to live arguments during judgment or approval block that attempt.

`approve(review, signal)` receives a separate copy of the reviewed subject, subject digest, revision, reasons, and verdict. Return `true` only when the host actually authorizes that subject. Without this callback, an enforced `ask` is unresolved and blocks. Neither elapsed time nor an unavailable judge counts as approval.

The low-level `reflexes.gate()` returns a judgment; callers own binding it to the exact action they execute. `createPluginSession().reviewAction()` supplies the snapshot/approval checks for hosts that want them. Filesystem isolation, atomic writes, command containment, and tool side effects remain host responsibilities.

## Output and recovery

`processOutput()` is the shared implementation used by the reference CLI and Pi adapter:

```text
host capture -> optional Focus -> bounded view -> enabled Sanitize/Verify -> delivery
```

`CapturedOutput` records source identity and complete/limited/unknown capture status. `PresentedOutput` records the exact source view, hash, selected UTF-8 byte ranges, omissions, and Focus candidate coverage. `ReviewedOutput` records the judgments and resulting delivery text. A reviewed result can be blocked or unavailable; the name does not certify safety or correctness.

Ranges are half-open byte offsets with a stream name. Hosts combining streams may supply `segments` to map rendered offsets back to retained stdout/stderr or other named streams. Custom fallback renderers without a source map have explicitly unknown range coverage. Plugin-authored notices are separate from the source view; source text is never appended after review.

The Pi adapter has no built-in artifact store. Its `outputSource(context, effectiveText, signal)` callback may identify retained output and supply a recovery reference. The text must match the effective result after existing host transformations. Recovery references use `handle.session.sessionId`; foreign-session references are rejected. The host owns retrieval tools and must enforce storage/session access there too. Adding `outputSource` alone does not implement recovery.

Register recovery tools in `capturedTools` so their pages receive the same enabled review. The defaults include `read_output` and `search_output`. Recovery must read retained output rather than rerun the original action. Without host recovery, omitted content is explicitly unrecoverable; Focus remains opt-in.

Default limits are 100,000 UTF-16 code units for Focus candidates and 8,000 for the source view reviewed/delivered. Individual Focus questions sample bounded section evidence; limited candidate/section coverage is disclosed. Exhaustive questions can request retrieval/computation instead of treating selected evidence as complete. Host-authored receipts may add text around the bounded source view.

Only configured tools passing through Pi's before/after-tool hooks are covered. Framework-generated results that bypass those hooks, direct tool execution, and downstream transformations outside the adapter need host integration at those boundaries. Text judgments do not review images or provider-owned opaque content.

## Progress, routing, and cancellation

Pulse consumes bounded progress history. Provide `recentActivity` for useful cross-turn evidence; otherwise the Pi adapter uses the current turn's tool results. It applies a stop through Pi's host checkpoint or queues an intervention. Productive progress clears intervention deduplication; task changes reset history. Host deadlines still apply independently.

Steer chooses between the current primary model and `miniModel`. With unavailable or unacceptable confidence it keeps the primary. Without a supplied alternative, the host keeps the primary even if a recommendation says mini. Model compatibility, provider credentials, and execution budgets belong to the host. Telemetry distinguishes recommendations from actual dispatched models.

Every engine uses a local judgment deadline and circuit breaker. `maxJudgmentCalls` limits new provider attempts; exact-answer cache hits require no new attempt. Provider timeouts count toward the breaker; user cancellation releases a half-open probe. Local cancellation can stop waiting even if a provider ignores abort, but cannot guarantee its remote computation or billing stopped.

The signal passed to `handle.prompt(..., { signal })` also calls `agent.abort()` after dispatch. Signals on raw judgment/session APIs cancel plugin work. `dispose()` cancels pending plugin work and restores attached hooks; the host remains responsible for stopping an already-running agent. A disposed handle cannot start another prompt.

## Confidence, telemetry, and compatibility

`genericJudge` returns `confidence: null`, `confidenceSource: "unavailable"`, null distributions, and null token usage when these are unreported. Numeric parsing rejects coercion from strings, booleans, or null. Jev preserves provider-reported confidence; that provenance is not an empirical calibration claim. Calibrated confidence requires a named calibration profile.

Gate automatic approval and Steer routing require confidence from a policy-accepted source. Defaults accept provider-reported or calibrated values, not self-reported or legacy values. Missing provenance cannot be promoted into certainty. Gate falls back to `ask`; Steer keeps the primary. Other reflexes can use valid scores under their own policies.

The answer-cache key includes answer schema, provider capabilities, policy, evidence, and questions. Journals retain their existing envelope with additive `answerSchema: 2` and revision metadata; legacy records remain readable. Replay reports missing confidence provenance as unsupported for confidence-dependent policies and does not replay failed judgments. Unknown usage is not zero. Failed validation preserves reported usage for accounting, without applying its answers.

`onJudgment` reports IDs, revision, status, model, latency, usage, and cache provenance without prompt/tool text. Cache hits report zero incremental usage and reference the original judgment. `onDecision` carries the decision and judgment ID. Adapter `onEvent` reports mode and the host-applied outcome using the same session ID. Combine these with host model/tool/approval measurements for total cost and latency; enabling `journalPath` also stores the richer journal evidence and is a separate choice.

A typechecked host integration example is in [host-plugin.ts](../../packages/pi-adapter/examples/host-plugin.ts). Live provider calls and usefulness benchmarks are separate from integration correctness tests.
