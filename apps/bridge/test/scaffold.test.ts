import { describe, expect, it } from "vitest";

import { BRIDGE_COMPONENT } from "../src/index.js";

describe("bridge scaffold", () => {
  it("exports its component identity", () => {
    expect(BRIDGE_COMPONENT.status).toBe("scaffold");
  });
});
