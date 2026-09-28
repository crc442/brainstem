<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.png">
    <img src="assets/wordmark-light.png" alt="brainstem" width="420">
  </picture>
</p>

<p align="center"><a href="https://brainstem.sh">brainstem.sh</a></p>

<p align="center">
  <a href="https://github.com/crc442/brainstem/actions/workflows/ci.yml"><img src="https://github.com/crc442/brainstem/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

Brainstem gives your coding agent reflexes: fast judgments that sit between the agent and its tools. They pause risky actions before they run, and block injected instructions and trim tool output before the main model sees them. Your agent still runs everything.

## What it looks like

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/demo-dark.gif">
  <img src="assets/demo-light.gif" alt="Session replay: Select narrows the tool catalog, Sanitize blocks an injected instruction, Gate allows a low-risk edit and pauses a risky rm -rf, Focus trims dry-run output to 3 relevant lines">
</picture>

A scripted replay of a real session shape, with no live API calls; token counts are illustrative.

## Install

```sh
npm install @brainstem/reflexes @brainstem/pi-adapter
```

| Package | Version | Purpose |
|---|---|---|
| [`@brainstem/reflexes`](packages/reflexes) | [![npm](https://img.shields.io/npm/v/@brainstem/reflexes?label=)](https://www.npmjs.com/package/@brainstem/reflexes) | Judgment API (`createReflexes`, `jevJudge`); bring your own judge model |
| [`@brainstem/pi-adapter`](packages/pi-adapter) | [![npm](https://img.shields.io/npm/v/@brainstem/pi-adapter?label=)](https://www.npmjs.com/package/@brainstem/pi-adapter) | Wires reflexes into a Pi agent (`attachReflexes`) |
| [`@brainstem/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@brainstem/core?label=)](https://www.npmjs.com/package/@brainstem/core) | Low-level engine, policy, and journal; installed automatically |
| [`@brainstem/cli`](packages/cli) | not published | Reference host demonstrating the integration (not a sandbox) |

## Quick start

Reflex judgments come from Jev, [TypeSafe](https://typesafe.ai)'s judgment model, so you'll need a `TYPESAFE_API_KEY`. Attach reflexes to an existing [Pi](https://github.com/earendil-works/pi/tree/main/packages/agent) agent:

```ts
import { createReflexes, jevJudge } from "@brainstem/reflexes";
import { attachReflexes } from "@brainstem/pi-adapter";

const reflexes = createReflexes({ judge: jevJudge() }); // reads TYPESAFE_API_KEY

const plugin = attachReflexes(agent, reflexes, { cwd: process.cwd() });

await plugin.prompt("Fix the failing login test");
```

Gate, Sanitize, and Verify are on by default; the rest are opt-in via `modes`. Not using Pi? Call the reflexes directly from `@brainstem/reflexes` or use `createPluginSession`. See the [typechecked host example](packages/pi-adapter/examples/host-plugin.ts) for all seven wired up.

## Reflexes

| Reflex | What it does |
|---|---|
| Gate | Decides whether a tool call or incoming message runs, asks for approval, or is denied |
| Sanitize | Withholds tool output carrying injected instructions before the model sees it |
| Verify | Checks whether a tool result actually achieved what was asked |
| Pulse | Detects loops and stalled progress across tool turns |
| Steer | Routes the next step to the primary or a cheaper model |
| Select | Picks which optional tools/skills are relevant to the task |
| Focus | Cuts large output down to relevant sections (off by default) |

Literal facts (paths, counts, exit codes, budgets) are always computed in code, never delegated to a judgment.

Each reflex runs in `off`, `shadow` (judge and log, don't act), or `active` mode.

## Trust dial

`trust` (0–1) lowers the confidence bar for auto-running actions: `autoConfidence = 0.95 - 0.35 * trust` (see `packages/core/src/policy.ts`). `trust 0` does not mean "ask about everything". Safety thresholds such as deny lines and credential-access thresholds never change with trust.

## Try the reference CLI

Add `TYPESAFE_API_KEY` and `ZAI_API_KEY` to `.env` (bun auto-loads it), then:

```sh
bun install
bun packages/cli/src/main.ts --cwd /tmp/repo --task "fix the failing test" --trust 0.5
bun packages/cli/src/main.ts replay <journal.ndjson> [--trust N]
```

## Development

```sh
bun run test
bun run typecheck
bun run lint
bun run build
bun run format
```

Add a changeset with `bun changeset` for changes that should ship.

The `@earendil-works/pi-*` dependencies are pinned deliberately; upgrade them explicitly.

## Docs

Full docs live at [brainstem.sh/docs](https://brainstem.sh/docs/).

- [Getting started](docs/getting-started.md): install, attach to a Pi agent, shadow mode
- [Reflexes](docs/reflexes.md): what each reflex decides, modes, trust
- [Integration guide](docs/integration/plugin.md): lifecycle, modes, approvals, output recovery, confidence, telemetry
- [Reference CLI internals](docs/cli.md): approvals, file writes, process termination, output recovery, Focus rollout, replay, answer cache

MIT licensed; see [LICENSE](LICENSE).
