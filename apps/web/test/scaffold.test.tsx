import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "../src/App.js";

describe("web scaffold", () => {
  it("renders the product identity", () => {
    expect(renderToStaticMarkup(<App />)).toContain("Lemma");
  });
});
