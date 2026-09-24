import { describe, expect, it } from "vitest";

import { BENCHMARK_COMPONENT } from "../src/index.js";

describe("benchmark scaffold", () => {
  it("records the planned matrix size", () => {
    expect(BENCHMARK_COMPONENT.plannedRuns).toBe(20);
  });
});
