import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const src = (workspace: string) => fileURLToPath(new URL(`./${workspace}/src/index.ts`, import.meta.url));

// `npm test` runs workspace unit tests only. Fixture repositories, benchmark run
// copies and Foundry dependencies contain their own test files, which are run by
// their own harness (or fail by design) and must never be collected here.
export default defineConfig({
  resolve: {
    // Tests exercise workspace sources, not whatever was last built into dist/.
    alias: {
      "@lemma/core": src("packages/core"),
      "@lemma/catalog": src("packages/catalog"),
      "@lemma/benchmark": src("packages/benchmark"),
      "@lemma/server": src("apps/server"),
      "@lemma/bridge": src("apps/bridge"),
    },
  },
  test: {
    include: ["{packages,apps}/*/test/**/*.test.{ts,tsx}"],
    exclude: [
      ...configDefaults.exclude,
      "**/fixtures/**",
      "packages/benchmark/runs/**",
      "contracts/**",
      "**/dist/**",
      "**/dist-types/**",
    ],
  },
});
