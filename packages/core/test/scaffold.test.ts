import { describe, expect, it } from "vitest";

import { CORE_COMPONENT, LEMMA_DECISIONS } from "../src/index.js";

describe("core scaffold", () => {
  it("freezes the initial schema and decision vocabulary", () => {
    expect(CORE_COMPONENT.schemaVersion).toBe("1");
    expect(LEMMA_DECISIONS).toContain("decline");
  });
});
