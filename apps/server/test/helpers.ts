import { type CatalogIndex, type LoadedCatalog, buildIndex, loadCatalog } from "@lemma/catalog";
import { type CapabilityRelease, type Hex32, type PatchBundle, type RepositoryProfile, bundleDigest, releaseDigest } from "@lemma/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Hono } from "hono";

import { type AppDeps, MemoryStore, ResolutionService, type ServerConfig, createApp, loadConfig, silentLogger } from "../src/index.js";

export const NOW = new Date("2026-10-01T00:00:00.000Z");

export function config(env: Record<string, string> = {}): ServerConfig {
  return loadConfig({ NODE_ENV: "test", ...env });
}

export function committedIndex(): CatalogIndex {
  return buildIndex(loadCatalog({ includeProvisional: false }));
}

let counter = 0;
export const nextPreviewId = () => `0x${(++counter).toString(16).padStart(64, "0")}` as Hex32;

export function deps(over: Partial<AppDeps> = {}): AppDeps {
  const clock = over.clock ?? (() => NOW);
  const store = over.store ?? new MemoryStore();
  return {
    config: config(),
    index: committedIndex(),
    store,
    service: new ResolutionService(store, clock, silentLogger),
    clock,
    newPreviewId: nextPreviewId,
    logger: silentLogger,
    ...over,
  };
}

export const PROVIDER = "0x00000000000000000000000000000000000000a1";
export const BUYER = "0x00000000000000000000000000000000000000b1";

export const sellableBundle: PatchBundle = { schemaVersion: "1", files: [{ path: "src/x.ts", op: "add", baseDigest: null, content: "export {};\n" }], dependencies: {}, devDependencies: {} };

/** A catalog with one sellable release (evidence, price 0.25, provider payTo). */
export function sellableIndex(): CatalogIndex {
  const release: CapabilityRelease = {
    schemaVersion: "1",
    releaseId: "gating",
    version: "1.0.0+bench-1",
    capability: "mcp-server.add-payment-gating",
    title: "Sellable test release",
    supportedProfiles: [
      {
        languages: ["typescript"],
        nodeMajor: { min: 22, max: 24 },
        packageManagers: ["npm"],
        moduleSystems: ["esm"],
        dependencies: { "@modelcontextprotocol/sdk": ">=1.30.0 <2" },
        frameworks: [],
        evidence: {
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
        },
      },
    ],
    provenance: { repository: "https://github.com/coinbase/x402", commit: "dd927a26cfefc98c24b3ec38b3a8f204dad0c60d", spdxLicense: "Apache-2.0" },
    payloadDigest: bundleDigest(sellableBundle),
    acceptanceRecipe: { script: "test", args: [], timeoutSec: 300, env: ["CI"] },
    price: "250000",
    provider: { payTo: PROVIDER },
    warranty: { claimWindowHours: 72 },
    publishedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2027-03-31T00:00:00.000Z",
  };
  const catalog: LoadedCatalog = {
    root: "/nonexistent",
    economics: { schemaVersion: "1", status: "measured", chainCostAtomic: "0", priceFloorAtomic: "0", ethUsdMicro: "0", measuredAt: "2026-09-01T00:00:00.000Z", source: "test" },
    releases: [{ release, releaseDigest: releaseDigest(release), bundle: sellableBundle, source: "public", dir: "releases/gating/1.0.0+bench-1" }],
  };
  return buildIndex(catalog);
}

export const matchingProfile: RepositoryProfile = {
  schemaVersion: "1",
  language: "typescript",
  runtime: { name: "node", major: 22 },
  packageManager: { name: "npm", lockfile: "package-lock.json" },
  moduleSystem: "esm",
  dependencies: { "@modelcontextprotocol/sdk": "1.30.1" },
  frameworks: [],
};
export const gatingTask = { schemaVersion: "1" as const, capability: "mcp-server.add-payment-gating" as const };

/** A real MCP client whose HTTP requests go straight into the Hono app. */
export async function mcpClient(app: Hono, headers: Record<string, string> = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://lemma.test/mcp"), {
    fetch: async (input, init) => app.request(String(input), init),
    requestInit: { headers },
  });
  const client = new Client({ name: "lemma-bridge-test", version: "0.0.0" });
  // The SDK's transport class declares optional properties without `| undefined`,
  // which exactOptionalPropertyTypes rejects; the runtime object is a Transport.
  await client.connect(transport as unknown as Transport);
  return client;
}

export const app = (over: Partial<AppDeps> = {}) => createApp(deps(over));
