# @brainstem/reflexes

## 0.3.0

### Minor Changes

- f73a5f7: Allow an explicit host authorization lookup to resolve Gate's approval request for the current action without prompting twice. Preserve host and Gate denials, keep authorization separate from judgment caching, and invalidate actions changed while awaiting the host hook or approval lookup.

## 0.2.1

### Patch Changes

- 327a613: Build with tsdown: ESM `.mjs` output with declaration maps, and export `./package.json`.
- Updated dependencies [327a613]
  - @brainstem/core@0.2.1
