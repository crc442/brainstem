import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: Object.fromEntries(["core", "reflexes", "pi-adapter"].map((name) => [`@brainstem/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))])) },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
