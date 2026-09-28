# @brainstem/pi-adapter

## 0.3.0

### Minor Changes

- f73a5f7: Allow an explicit host authorization lookup to resolve Gate's approval request for the current action without prompting twice. Preserve host and Gate denials, keep authorization separate from judgment caching, and invalidate actions changed while awaiting the host hook or approval lookup.

### Patch Changes

- Updated dependencies [f73a5f7]
  - @brainstem/reflexes@0.3.0

## 0.2.2

### Patch Changes

- 8d58270: Pulse no longer runs on turns without tool results, so a final answer can't trigger a new intervention and restart a completed task.

## 0.2.1

### Patch Changes

- 327a613: Build with tsdown: ESM `.mjs` output with declaration maps, and export `./package.json`.
- Updated dependencies [327a613]
  - @brainstem/reflexes@0.2.1
