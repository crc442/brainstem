# brainstem

Public repo. Never commit secrets or content from `internal/`.

## Toolchain

Bun 1.4.3 (pinned in `package.json`) must be the first `bun` on PATH, not just the binary you invoke: tsdown shells out to `bun pm pack` for `build:check`, and older Bun releases (e.g. 1.1.6) have no `pm pack`. Check with `bun --version`.

## Verify

Run what CI runs before opening a PR:

```sh
bun run format:check && bun run lint && bun run typecheck && bun run test && bun run build:check
```

For changes under `packages/claude-plugin`, also run `bun run verify:plugin`. It builds, copies the plugin to a temp dir as an install would, drives the real hook entries with a deterministic judge, and prints the path of an evidence file. Extend `packages/claude-plugin/scripts/verify-build.ts` instead of hand-building fixtures in `/tmp`.

`eval:*` and `exp:*` scripts call Jev with `TYPESAFE_API_KEY` from `.env` and cost money. Ask before running them; `*:dry-run` and `*:offline` variants are free.

## Conventions

- Commits: `type(scope): summary`, e.g. `fix(claude-plugin): keep explicit background commands unwrapped`.
- User-facing package changes need a changeset (`bun run changeset`).

## Plans and decisions

`internal/` is a separate private repo (gitignored here), present only on the maintainer's machine:

- `internal/docs/decisions.md`: settled design decisions. Read it before changing host-boundary behavior; don't relitigate an entry without saying why.
- `internal/docs/plans/`: task plans and `*-results.md` validation notes.

## Friction

In this repo, friction goes to GitHub issues, not `~/.claude/friction.md`. Search open issues first (`gh issue list --label friction --search "<keywords>"`) and comment on a match instead of filing a duplicate. Otherwise `gh issue create --label friction` with what happened, how to reproduce it, and a suggested fix. Issues are public: keep `internal/` content, secrets, and local paths out of them.

## Dogfooding

Run the plugin on this repo while working on it: `bun run build`, then `claude --plugin-dir packages/claude-plugin`. File Gate false positives and misses, and Focus or output-review trimming that hid something you needed, as friction issues with the extra label `dogfood`.
