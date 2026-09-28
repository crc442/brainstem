# Getting started

Brainstem gives your coding agent reflexes: fast judgments that sit between the agent and its tools. They pause risky actions before they run, and block injected instructions and trim tool output before the main model sees them. Your agent still runs everything.

## Install

```sh
npm install @brainstem/reflexes @brainstem/pi-adapter
```

| Package | Purpose |
|---|---|
| `@brainstem/reflexes` | Judgment API (`createReflexes`, `jevJudge`); bring your own judge model |
| `@brainstem/pi-adapter` | Wires reflexes into a Pi agent (`attachReflexes`) |
| `@brainstem/core` | Low-level engine, policy, and journal; installed automatically |

## Attach to a Pi agent

Reflex judgments come from Jev, [TypeSafe](https://typesafe.ai)'s judgment model, so you'll need a `TYPESAFE_API_KEY`.

```ts
import { createReflexes, jevJudge } from "@brainstem/reflexes";
import { attachReflexes } from "@brainstem/pi-adapter";

const reflexes = createReflexes({ judge: jevJudge() }); // reads TYPESAFE_API_KEY

const plugin = attachReflexes(agent, reflexes, { cwd: process.cwd() });

await plugin.prompt("Fix the failing login test");
```

Send user messages through `plugin.prompt()` rather than `agent.prompt()` so message-level reflexes see them. Call `plugin.dispose()` to detach.

## Start in shadow mode

Gate, Sanitize, and Verify are active by default; the rest are off. To see what Brainstem would do before letting it act, run reflexes in `shadow`:

```ts
attachReflexes(agent, reflexes, {
  cwd: process.cwd(),
  modes: { gate: "shadow", sanitize: "shadow", verify: "shadow", pulse: "shadow" },
  onEvent: (event) => console.log(event),
});
```

See [Reflexes](reflexes.md) for what each one does and [modes and defaults](integration/plugin.md#modes-and-defaults) for the full list.

## Not using Pi?

Call the reflexes directly from `@brainstem/reflexes` (`gate()`, `observe()`, `processOutput()`, `pulse()`, `steer()`, `select()`), or use `createPluginSession()` for approval binding and output recovery. The [integration guide](integration/plugin.md) covers the lifecycle, and the [typechecked host example](../packages/pi-adapter/examples/host-plugin.ts) wires up all seven reflexes.

## Try the reference CLI

The repo includes a runnable reference host. Add `TYPESAFE_API_KEY` and `ZAI_API_KEY` to `.env`, then:

```sh
bun install
bun packages/cli/src/main.ts --cwd /tmp/repo --task "fix the failing test" --trust 0.5
```

See [Reference CLI internals](cli.md) for how it handles approvals, writes, and output recovery.
