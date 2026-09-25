import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import { CATALOG_ROOT } from "../src/index.js";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway copy of the committed catalog that a test may break. */
export function catalogCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "lemma-catalog-"));
  made.push(root);
  for (const entry of ["economics.json", "releases", "fixtures"]) cpSync(join(CATALOG_ROOT, entry), join(root, entry), { recursive: true });
  return root;
}

export function readJsonFile<T extends object = Record<string, unknown>>(root: string, path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

export function writeJsonFile(root: string, path: string, value: unknown): void {
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

export const SERVER = "releases/mcp-server-payment-gating/0.1.0-skeleton";
export const CLIENT = "releases/mcp-client-paying-client/0.1.0-skeleton";

export const EVIDENCE = {
  benchmarkVersion: "bench-1",
  runSetDigest: `0x${"12".repeat(32)}`,
  fixtureProfileDigest: `0x${"13".repeat(32)}`,
  model: "example-model-1",
  measuredAt: "2026-09-20T00:00:00.000Z",
  staleAfter: "2026-12-20T00:00:00.000Z",
  runs: { control: 3, treatment: 3 },
  passed: { control: 3, treatment: 3 },
  controlMedianCostUsdc: "2500000",
  expectedRawSavingUsdc: "1000000",
  expectedTokenSaving: 420000,
};
