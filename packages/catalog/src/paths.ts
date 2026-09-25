import { fileURLToPath } from "node:url";

/** The catalog package root, from `src/` in tests and `dist/` at runtime. */
export const CATALOG_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const PUBLIC_DIR = "releases";
export const PROVISIONAL_DIR = "releases.provisional";
export const FIXTURES_DIR = "fixtures";
export const ECONOMICS_FILE = "economics.json";

export const MANIFEST_FILE = "manifest.json";
export const BUNDLE_FILE = "bundle.json";
export const PAYLOAD_DIR = "payload";
