export * from "./build-index.js";
export * from "./check.js";
export * from "./economics.js";
export * from "./fixtures.js";
export * from "./load.js";
export * from "./pack.js";
export { CATALOG_ROOT } from "./paths.js";

export const CATALOG_COMPONENT = {
  name: "@lemma/catalog",
  status: "loader",
} as const;
