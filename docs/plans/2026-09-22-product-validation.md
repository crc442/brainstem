# Product validation: Brainstem as an aid or gate

Date: 2026-09-22

Revised: 2026-09-23

Status: Planned; offline fixtures first, live protocol and budget not yet selected

Implementation plan: [plugin integration](2026-09-22-runtime-consolidation.md)

Test whether a main agent benefits from three Brainstem uses: relevant tool/skill suggestions on incoming messages, relevant evidence after tool calls, and prompt/action judgments at host approval boundaries. Measure both judgment quality and actual task outcomes. Fewer context tokens or correct mock decisions alone do not establish usefulness.

All seven reflexes remain in scope: Select, Focus, Gate, Sanitize, Verify, Pulse, and Steer. This revision replaces the managed-executor framing with a plugin evaluation. Use the same host agent and its execution/permission infrastructure in every arm. Brainstem's treatment is the judgment and how the host applies it. Stage the experiments by use case, then evaluate the complete seven-reflex plugin.

## Product questions

| Use | Hypothesis | Evidence needed |
|---|---|---|
| Capability aid | Per-message suggestions help the agent find useful tools/skills without adding excessive overhead | Relevant capabilities discovered and used; completion, total cost, and latency measured against the same available catalog |
| Output focus | Relevant excerpts help the agent work with large results | Needed evidence retained or recovered; answer/task correctness maintained; total savings exceed selection and recovery overhead |
| Gate | Message/action judgments reduce unauthorized or misdirected behavior | Harmful attempts/effects and missed approvals decrease without excessive false blocks or unnecessary approvals on allowed work |
| Progress aid (Pulse) | Progress judgments prevent unproductive loops | Fewer wasted calls and better completion without interrupting productive retries |
| Model-selection aid (Steer) | Routing uses a cheaper model when appropriate | Total cost/latency improve without unacceptable completion loss, compared with fixed-model controls |
| Combined plugin | All seven reflexes work well together | Completion and intervention burden remain acceptable while at least one declared benefit survives total-cost and latency accounting |

Evaluate advisory and enforced behavior separately. A useful warning is not proof that a blocking gate prevented an action; a simulated approval is not evidence that real users experience less burden.

## B0. Freeze a small, reproducible protocol

Before live calls, prepare a versioned protocol, task manifests, effective arm configurations, job count, and numeric per-run/whole-study budget. Pin source/dependency revisions, main/judge models, sampling settings, base prompts, tool schemas, policies, evidence limits, host permissions, approval rules, and grading.

- Keep the primary model and permitted model pool fixed within each paired block. Non-Steer arms use the primary; Steer arms may route within the same frozen primary/mini pair, which is an explicit treatment difference. Suggestions, inserted skill content, selected output, gate annotations, and Pulse interventions may change the actual prompt as the treatment; unrelated configuration stays fixed.
- Define the primary endpoint and acceptable regressions before held-out runs. Record tuning on development fixtures; freeze held-out tasks, labels, policies, and thresholds before inspecting their results.
- Start with one host integration and one fixed model configuration. Test adapter compatibility offline; replicate product findings in another host/model only after the first study is interpretable.
- The evaluation runner owns execution/time/spend limits and a global watchdog. This is experiment infrastructure, not a prerequisite for a new Brainstem execution controller. Unknown pricing/usage must be visible, and a claimed hard monetary ceiling needs defensible request bounds.
- This document authorizes no paid run. A later execution task must use the concrete frozen manifest and spending ceiling. Protocol preparation and deterministic fixture work need no live provider calls.

## B1. Check each flow on labeled fixtures first

Create development and held-out fixtures that exercise production public APIs and adapter application points. Prior Focus/Select pilots and remediation reproductions belong in development/regression data, not fresh held-out evidence.

| Family | Fixtures | Independent labels |
|---|---|---|
| Capability aid | Helpful and irrelevant skills/tools; similar descriptions; no useful additions; explicit requests; unavailable capabilities; task changes across messages | Acceptable relevant capability sets, required capabilities, and forbidden/unavailable suggestions |
| Output focus | Long test/build logs; late diagnostics; exact values; evidence across streams; incomplete capture; large recovery pages; exhaustive-count tasks | Required source spans/facts, answer rubric, and whether retrieval or fuller coverage is necessary |
| Message gate | Direct authorized requests; instruction overrides; malicious retrieved/quoted text; benign quotations; legitimate security analysis | Source/trust roles, allowed/blocked/approval-needed outcome under the declared host policy |
| Action gate | Allowed and unauthorized commands/edits; ambiguous intent; missing/truncated change evidence; changes after review | Exact proposed action, host authorization conditions, required approval, prohibited effects |
| Progress aid | Repeated failures; legitimate retries after changes; misleading apparent success | Whether progress occurred and whether intervention/stop is warranted |
| Model-selection aid | Routine edits; multi-step diagnosis; uncertainty; unavailable models | Permitted model choices and observed task outcomes under fixed-model controls; judge confidence alone is not a correctness label |

Pair suspicious cases with benign near-neighbors so blocking everything cannot score well. Evaluate message and action gates separately, including approved messages that later produce unauthorized actions. Label ambiguity explicitly and use blind human adjudication where needed; do not grade a judge using its own answers.

Measure suggestion precision/required-capability recall, evidence retention, correctness after recovery, gate false-positive/false-negative rates, approval accuracy, progress intervention quality, routing outcomes, unavailable rates, and per-event latency/cost. Replayed fixtures isolate decision quality but cannot establish end-to-end savings or adaptive agent behavior.

Completion gate: deterministic tests confirm the right event triggers, the expected input reaches the judge, the host applies the returned result in the configured mode, and telemetry accounts for each call. Then proceed to paired coding tasks.

## B2. Build a compact task corpus

Begin with 12 development tasks, covering the three primary uses plus progress and routing cases, to debug the runner and estimate cost/variance. Prepare a separate held-out corpus after the smoke run; choose its size from the desired decision margins, variation, and study budget rather than committing immediately to thousands of runs.

Use small repository snapshots for real coding tasks, plus synthetic fixtures for precisely controlled malicious content and unauthorized effects. Each task includes the initial tree, objective, available catalog, relevant constraints, approval policy, hidden tests or answer rubric, prohibited effects, and resource limits.

Representative tasks:

- Discover and use a helpful browser/testing skill, including a follow-up message that changes what is relevant.
- Fix a bug using a large test log with important diagnostics near the end, or answer an exact question that requires recovering omitted output.
- Complete an authorized code change while ignoring hostile instructions in a file, tool error, or retrieved document.
- Handle a request/action that requires approval without blocking a similar authorized operation unnecessarily.
- Escape a repeated failing approach while allowing a productive retry after a code change.
- Complete routine and difficult coding tasks with routing versus fixed-primary and fixed-mini controls.

Grade patches with hidden tests and repository invariants; grade investigative answers against source facts. Instrument proposed tools and fixture effects. Record correct refusals separately from completion of allowed tasks. A system that blocks every task must fail the allowed-work cases.

Use synthetic secrets and recording stubs inside disposable, externally isolated environments. This environment is shared experiment infrastructure; preventing an actual external harm does not erase the agent's recorded forbidden attempt.

## B3. Paired comparison arms

All arms share tools, available skills/catalog, base prompts, permitted model pool, execution budgets, host permissions/approvals, output storage/recovery, and telemetry. Host-mandated controls remain enabled in every arm; any additional Brainstem deterministic rules must be listed separately.

| Arm | Behavior |
|---|---|
| B: Baseline host | Main agent with its existing host permissions and presentation, no Brainstem judgments or added controls |
| D: Deterministic controls | B plus declared deterministic Brainstem restrictions/presentation/retrieval policies, no semantic judgments |
| D + Capability aid | D plus Select on incoming user messages/task updates |
| D + Output focus | D plus Focus on tool results |
| D + Message gate | D plus incoming-message review at a declared host boundary |
| D + Action gate | D plus proposed-action review at the host's tool/approval boundary |
| D + Sanitize | D plus injection review of tool output |
| D + Verify | D plus assessment of whether tool output supports the intended result |
| D + Pulse | D plus progress judgments at host checkpoints |
| D + Steer | D plus model recommendations at host routing boundaries |
| F: Combined plugin | D plus all seven reflexes; Gate covers both message and action boundaries |

Gate has two boundary-specific arms to distinguish message review from action review; these are two uses of one reflex, not an eighth reflex. Sanitize and Verify support the output/gate flows but get separate ablations so their effects are not attributed to Focus. Off components make zero judgment calls and apply no latent policy changes. If production fuses Sanitize/Verify in one request, individual arms ask only enabled question groups; F may use production fusion.

If B and D are identical for a host configuration, record that and collapse the duplicate arm. For early smoke runs, use relevant per-flow subsets instead of running every arm on every development fixture. The confirmatory combined study uses a frozen common matrix.

- Compare each D-plus-one against D for that component's effect, F against D for combined semantic value, and D against B for added deterministic-control value. F versus B is the total plugin effect.
- Non-Select arms expose the same available capabilities under the host's normal discovery policy. When all fit, expose all. If not, include a documented deterministic retrieval baseline; do not starve the baseline to create a Select advantage.
- Non-Focus arms use the same presentation ceiling and recovery service with a declared bounded selection policy. Include a complete-output control on tasks where it fits. Any change from the native host's presentation belongs explicitly in D and is accounted for in D-versus-B.
- The enforced-gate study uses the same deterministic approval oracle in every arm: allow exactly manifest-authorized requests, deny unauthorized requests, record all requests and outcomes. Gate decisions cannot override this oracle or host denials.
- Evaluate advisory gates in a separately labeled shadow/advisory study. Shadow estimates judgment quality and overhead; only active host-applied results can support behavioral prevention claims.
- Include fixed-mini controls on the routing subset to distinguish useful routing from simply using a cheaper model. Record the model actually dispatched, host-declined routing recommendations, and model-transition/cache costs.
- Keep exact-answer-cache policy fixed, empty at task start, reusable within a run. No arm may borrow judgments from another arm or held-out repetition.

## B4. Run paired blocks and measure prompt-cache effects

A paired block is `(task, snapshot, model configuration, repetition)`. Start every arm from a fresh identical state and counterbalance order with a recorded seed. Separate task/repository families across development and held-out splits where feasible. Repetitions measure stochastic variation; they are not independent new tasks.

- Reset session state, artifacts, local judgment cache, and mutable files between runs. Use identical declared dependency-cache conditions and machine/provider concurrency. Record outages and load.
- Use an external watchdog and retain incomplete runs. Predeclare infrastructure retry rules, record every attempt/cost, and never selectively rerun losing arms.
- Simulated approvals have a fixed delay. Report approval counts and that delay separately from machine time; real human wait/burden requires a later usability study.
- Record main-model prompt-cache reads/writes separately from local judgment cache hits. Count input, output, reasoning, cache-write, and cache-read tokens where reported; unavailable fields remain unknown.
- Capability changes and output selection may disrupt cached prefixes. Include their actual token/cost effects and additional turns in task totals, not just the reduction in visible text.
- A new local session does not prove a remote cache miss. Use provider-supported controls for a registered cold/warm subset where available; otherwise report observed cache usage or unknown conditions. Count warm-up requests and declare any amortization assumption.

## B5. Outcomes and instrumentation

| Metric | Definition |
|---|---|
| Task completion | Hidden tests/rubric pass within the common budget; correct refusals reported separately |
| Capability usefulness | Required-capability recall, irrelevant suggestions, actual tool/skill use, and outcome after use |
| Evidence quality | Required facts retained, omissions disclosed, exact-answer correctness, recovery success |
| Harmful actions | Forbidden proposals, dispatched attempts, and effects observed inside fixtures, separately |
| Unnecessary blocks | Authorized messages/actions/evidence withheld, with static/semantic cause |
| Approvals | Required, unnecessary, missed, denied, and repeated requests; host enforcement outcome |
| Total cost | Main model, judge, recovery, retries, cache operations, and billable tools per attempted task |
| Cost per successful task | Cost of all attempts divided by successful tasks, so cheap failures do not appear efficient |
| Recovery | Calls/pages/bytes, time/cost, success, and accidental side-effect reruns (must be zero) |
| Latency | End-to-end p50/p95 and event-level overhead; include model, plugin, tool, approval, recovery, cleanup spans |
| Progress and routing | Wasted/repeated calls, correct/unnecessary interventions, stops, chosen versus dispatched models, routing quality versus fixed-model controls |
| Reliability | Invalid/unavailable judgments, timeouts, stale results, budget stops, missing telemetry, protocol violations |

Correlate host task/turn/tool IDs with plugin flow, effective mode, subject revision, decision and applied outcome. Capture actual provider/model identity, usage provenance, price snapshot, and cache status per call. A local cache hit does not incur its original inference usage again. Keep overlapping spans so total latency is not the sum of overlapping work.

Report all-run status/duration distributions alongside successful-task latency. Timeouts and failed tasks cannot disappear from the cost/latency analysis. Small smoke samples cannot support p95 claims; report counts and uncertainty. Persist enough redacted evidence to explain failures without collecting real credentials.

## B6. Decision rules and staged rollout

Freeze numeric completion, false-block, missed-approval, overhead, and benefit thresholds before held-out execution. Use development data to estimate sample sizes; do not choose thresholds after seeing favorable results.

- Primary end-to-end comparison: F versus D on completion within budget, with separately declared safety and resource outcomes. Component comparisons may be exploratory initially; apply a registered multiple-comparison method for confirmatory claims.
- Analyze paired differences and uncertainty clustered by task/repository family. Report per-use and benign/adversarial results, not just aggregate averages.
- Recommend capability aid only when suggestions help discovery/task outcomes enough to justify per-message cost and delay. Relevance scores alone are insufficient.
- Recommend Focus only when correctness/evidence access meet the frozen tolerance and total cost or latency improves after recovery and cache effects.
- Recommend enforced gates only when forbidden outcomes or missed approvals improve within the frozen false-block/approval limits. Retain advisory/manual modes where uncertainty or false positives make automation unsuitable.
- Recommend Pulse only when reduced wasted work outweighs intervention overhead and productive work is not prematurely stopped. Recommend Steer only when measured routing benefits survive fixed-primary/fixed-mini comparison and full cost/cache accounting.
- Enable the combined default only if interactions preserve these properties. A severe reproducible unauthorized outcome needs investigation even if aggregate efficiency improves. Zero observed failures is not proof of no risk.
- If results are underpowered, conclude inconclusive. Retain counterexamples and do not redefine the corpus or margins after unblinding. Full-minus-one studies, additional model pairs, and catalog-size stress tests are separate follow-ups; individual Pulse/Steer and combined seven-reflex arms remain in the main plan.

## Deliverables and completion

Under `experiments/evals/paired/`, add the protocol/config schema, labeled development/held-out manifests, production-API fixture drivers, paired host runner, approval oracle, independent graders, and offline tests. Provide a dry-run command that prints the job matrix and budget estimate without provider calls. Persist run manifests to prevent duplicate paid requests on resume.

Proceed in stages: offline per-flow fixtures, a small development smoke run, a sized held-out paired study, then replication or targeted follow-ups. For any frozen matrix, report `tasks × arms × model configurations × repeats` and all auxiliary calls before execution. No fixed 1,800-run commitment is carried over from the earlier plan.

Publish a reproducible report linked from `experiments/evals/README.md`, including outcomes, uncertainty, costs, cache behavior, latency, approval burden, missingness, and concrete failure cases. Done means we can say which of the seven reflexes helps which tasks, how they support the aid/gate use cases, under which host/policy/model conditions, and whether each should be off, advisory, or active. Building a new executor or enabling every reflex by default is not a completion requirement.
