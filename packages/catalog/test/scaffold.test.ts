import { describe, expect, it } from "vitest";

import { CATALOG_COMPONENT } from "../src/index.js";

describe("catalog scaffold", () => {
  it("starts with no publishable capability releases", () => {
    expect(CATALOG_COMPONENT.releaseCount).toBe(0);
  });
});
