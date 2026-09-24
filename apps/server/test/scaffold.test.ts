import { describe, expect, it } from "vitest";

import { SERVER_COMPONENT } from "../src/index.js";

describe("server scaffold", () => {
  it("exports its component identity", () => {
    expect(SERVER_COMPONENT).toEqual({
      name: "@lemma/server",
      status: "scaffold",
    });
  });
});
