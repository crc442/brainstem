# Reflexes

A reflex is one narrow judgment at one boundary of the agent loop. Each is independent: turn any of them on, off, or into shadow mode without touching the others.

| Reflex | When it runs | What it decides | Pi adapter default |
|---|---|---|---|
| Gate | Before a tool call runs, or before an incoming message is dispatched | Run it, ask for approval, or deny | Active (message Gate off) |
| Sanitize | After a tool returns, before the model sees the output | Withhold output carrying injected instructions | Active |
| Verify | After a tool returns | Whether the result achieved what was asked | Active |
| Pulse | Every few tool turns | Whether the agent is looping or stalled | Off |
| Steer | Before each model dispatch | Route the next step to the primary or a cheaper model | Off |
| Select | When a user message arrives | Which optional tools and skills are relevant | Off |
| Focus | After a tool returns, before Sanitize and Verify | Which sections of large output are relevant | Off |

Literal facts such as paths, counts, exit codes, and budgets are always computed in code, never delegated to a judgment. A write resolving outside the project root skips Gate's judgment and takes the static floor verdict.

The [integration guide](integration/plugin.md#reflex-evidence) lists exactly what evidence each reflex receives.

## Modes

Each reflex runs in one of three modes, set per reflex through `modes`:

- `off`: no judgment request.
- `shadow`: judge and report, but don't act on the result.
- `active`: apply the result at the host boundary.

Gate also has `gateBehavior: "advisory"`, which reports active Gate verdicts without blocking dispatch. Host denials stay authoritative either way.

## Trust

Trust (0 to 1) lowers the confidence Gate needs before auto-running an action:

```text
autoConfidence = 0.95 - 0.35 * trust
```

The library default is trust `0.3`. Pass `policy: policyForTrust(n)` from `@brainstem/core` to `createReflexes` to change it, or `--trust` to the reference CLI.

`trust 0` does not mean "ask about everything". Safety thresholds such as deny lines and credential-access checks never change with trust. Auto-approval also requires confidence from an accepted source; when that's missing, Gate falls back to asking. See [policy.ts](../packages/core/src/policy.ts) for every threshold.

## Who owns what

Brainstem only judges. The host agent still executes tools, owns filesystem permissions and approvals, and keeps output. See [who owns what](integration/plugin.md#who-owns-what) in the integration guide.
