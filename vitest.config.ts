import { fileURLToPath } from "node:url";
import { defaultExclude, defineConfig } from "vitest/config";

const alias = {
  "@brainstem/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
  "@brainstem/pi-adapter": fileURLToPath(new URL("./packages/pi-adapter/src/index.ts", import.meta.url)),
  "@brainstem/reflexes": fileURLToPath(new URL("./packages/reflexes/src/index.ts", import.meta.url)),
};

// These files assert on wall-clock deadlines (process-group kill bounds, resume
// timing). With the suite's default unbounded file parallelism they contend for
// 16 cores, event loops starve, timers fire late, and whichever of them loses the
// scheduler lottery fails — a drifting failure set, not a real regression. They get
// their own project with a later `sequence.groupOrder` so they run after the parallel
// bulk has finished rather than alongside it. Ordering the projects is the lever that
// works; `fileParallelism` is not accepted per-project, only globally.
const TIMING_SENSITIVE = ["packages/cli/test/tools.test.ts", "experiments/evals/paired/test/runner.test.ts"];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "timing",
          include: TIMING_SENSITIVE,
          environment: "node",
          sequence: { groupOrder: 1 },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "experiments/evals/paired/test/**/*.test.ts"],
          exclude: [...defaultExclude, ...TIMING_SENSITIVE],
          environment: "node",
          sequence: { groupOrder: 0 },
        },
      },
    ],
  },
});
