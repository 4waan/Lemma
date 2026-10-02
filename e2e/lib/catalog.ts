import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Address, type CapabilityRelease, type Hex32, type PatchBundle, type ProfileEvidence, bundleDigest, releaseDigest } from "@lemma/core";
import { keccak256, stringToHex } from "viem";

/** The capability the run's release answers. */
export const CAPABILITY = "mcp-server.add-payment-gating";

/** The file the release adds, and what the fixture repositories' tests import from it. */
const GATING_PATH = "src/lemma/gating.mjs";
const GATING_SOURCE = 'export function gate(price) {\n  return { network: "eip155:421614", asset: "USDC", price };\n}\n';

export interface E2eCatalog {
  /** A catalog root in `loadCatalog`'s layout: economics.json and releases/<id>/<version>/. */
  readonly root: string;
  readonly release: CapabilityRelease;
  readonly releaseDigest: Hex32;
  /** `releaseId@version`, how the operator script names it. */
  readonly ref: string;
  readonly evidence: ProfileEvidence;
}

const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** What names and labels a written catalog: the local run's, or a live run's demo (e2e/live/catalog.ts). */
export interface CatalogOptions {
  readonly releaseId: string;
  /** `<semver>+<benchmarkVersion>`, as frozen evidence names a release version. */
  readonly version: string;
  readonly title: string;
  readonly benchmarkVersion: string;
  /** Hashed into the evidence's run set digest and fixture profile digest: names, not measurements. */
  readonly runSet: string;
  readonly model: string;
  readonly claimWindowHours: number;
  readonly provenance: CapabilityRelease["provenance"];
  /** economics.json's `source`. */
  readonly economicsSource: string;
}

/** The local run's catalog. */
export const E2E_CATALOG: CatalogOptions = {
  releaseId: "payment-gating-e2e",
  version: "1.0.0+e2e-1",
  title: "Payment gating marker for the local end-to-end run",
  benchmarkVersion: "e2e-1",
  runSet: "lemma end-to-end",
  model: "e2e-model-1",
  claimWindowHours: 1,
  provenance: { repository: "https://github.com/tyler-turnpike/Lemma", commit: "fe49f70ee18b265a3f964ff7185f4e204547bb33", spdxLicense: "MIT" },
  economicsSource: "Lemma end-to-end run on a local chain: made-up economics, testnet only.",
};

/**
 * Writes a one-release catalog for the run: a release of the payment-gating
 * capability that adds one file, whose acceptance recipe is the repository's
 * `test` script, with fresh benchmark evidence (5 treatment runs, 4 passed:
 * the prior is 4 passes and 1 failure), a testnet price of 0.25 USDC paid to
 * `payTo` (a quarter of the measured saving, inside the 30% sale rule), and
 * the warranty window of `options` (the local run's: one hour). The evidence
 * is made up for the run and exists only in the directory written; nothing
 * is committed.
 */
export function writeCatalog(dir: string, payTo: Address, now: Date = new Date(), options: CatalogOptions = E2E_CATALOG): E2eCatalog {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const evidence: ProfileEvidence = {
    benchmarkVersion: options.benchmarkVersion,
    runSetDigest: keccak256(stringToHex(`${options.runSet} run set`)),
    fixtureProfileDigest: keccak256(stringToHex(`${options.runSet} fixture profile`)),
    model: options.model,
    measuredAt: iso(now.getTime() - day),
    staleAfter: iso(now.getTime() + 90 * day),
    runs: { control: 5, treatment: 5 },
    passed: { control: 1, treatment: 4 },
    controlMedianCostUsdc: "2500000",
    expectedRawSavingUsdc: "1000000",
    expectedTokenSaving: 420_000,
  };
  const bundle: PatchBundle = { schemaVersion: "1", files: [{ path: GATING_PATH, op: "add", baseDigest: null, content: GATING_SOURCE }], dependencies: {}, devDependencies: {} };
  const release: CapabilityRelease = {
    schemaVersion: "1",
    releaseId: options.releaseId,
    version: options.version,
    capability: CAPABILITY,
    title: options.title,
    supportedProfiles: [
      {
        languages: ["typescript"],
        nodeMajor: { min: nodeMajor, max: nodeMajor },
        packageManagers: ["npm"],
        moduleSystems: ["esm"],
        dependencies: { "@modelcontextprotocol/sdk": ">=1.30.0 <2" },
        frameworks: [],
        evidence,
      },
    ],
    provenance: options.provenance,
    payloadDigest: bundleDigest(bundle),
    acceptanceRecipe: { script: "test", args: [], timeoutSec: 120, env: [] },
    price: "250000",
    provider: { payTo },
    warranty: { claimWindowHours: options.claimWindowHours },
    publishedAt: iso(now.getTime() - day),
    expiresAt: iso(now.getTime() + 180 * day),
  };
  const releaseDir = join(dir, "releases", release.releaseId, release.version);
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, "manifest.json"), `${JSON.stringify(release, null, 2)}\n`);
  writeFileSync(join(releaseDir, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync(
    join(dir, "economics.json"),
    `${JSON.stringify({ schemaVersion: "1", status: "measured", chainCostAtomic: "0", priceFloorAtomic: "0", ethUsdMicro: "0", measuredAt: iso(now.getTime() - day), source: options.economicsSource }, null, 2)}\n`,
  );
  return { root: dir, release, releaseDigest: releaseDigest(release), ref: `${release.releaseId}@${release.version}`, evidence };
}

/**
 * A fixture repository the release fits (TypeScript, ESM, npm, the running
 * Node major, the MCP SDK), whose `test` script imports the file the release
 * adds. `pass` asserts what that file really does; `fail` asserts something
 * else, so its acceptance run exits 1 after the resolution is applied.
 */
export function writeWorkspace(dir: string, variant: "pass" | "fail"): string {
  const expected = variant === "pass" ? "eip155:421614" : "eip155:1";
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      { name: "lemma-e2e-app", private: true, type: "module", scripts: { test: "node --test test/gating.test.mjs" }, dependencies: { "@modelcontextprotocol/sdk": "^1.30.0" }, devDependencies: { typescript: "7.0.2" } },
      null,
      2,
    )}\n`,
    "package-lock.json": `${JSON.stringify({ name: "lemma-e2e-app", lockfileVersion: 3, requires: true, packages: { "": { name: "lemma-e2e-app" }, "node_modules/@modelcontextprotocol/sdk": { version: "1.30.1" } } }, null, 2)}\n`,
    ".nvmrc": `${process.versions.node.split(".")[0]}\n`,
    "test/gating.test.mjs": `import assert from "node:assert/strict";\nimport { test } from "node:test";\n\nimport { gate } from "../${GATING_PATH}";\n\ntest("the gate charges on Arbitrum Sepolia", () => {\n  assert.equal(gate("0.25").network, "${expected}");\n});\n`,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
