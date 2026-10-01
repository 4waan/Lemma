import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import base from "../vitest.config.js";

/**
 * `npm run e2e`'s test run (after e2e/prepare.ts). The default `npm test`
 * never collects these files: its include covers `{packages,apps}/*\/test`.
 * Workspace packages resolve to their sources, as in unit tests; the
 * operator scripts the run starts as processes use the built ones.
 */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  ...(base.resolve === undefined ? {} : { resolve: base.resolve }),
  test: {
    include: ["e2e/**/*.e2e.ts"],
    // One chain, one story: the scenarios run in order and share its state.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // A failure is a real one: a retry would meet a chain the first try changed.
    retry: 0,
    // Each scenario by name, with its time.
    reporters: ["verbose"],
  },
});
