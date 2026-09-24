import {
  ARBITRUM_SEPOLIA,
  ARBITRUM_SEPOLIA_USDC,
  type AdoptionReceipt,
  type CapabilityRelease,
  type PatchBundle,
  type Preview,
  type ProfileEvidence,
  type RepositoryProfile,
  type Resolution,
  type RunRecord,
  type SpendingPolicy,
  type TaskRequest,
  deriveResolutionId,
} from "../src/index.js";

export const hex32 = (byte: string) => `0x${byte.repeat(32)}`;

export const PROVIDER = "0x00000000000000000000000000000000000000a1";
export const BUYER = "0x00000000000000000000000000000000000000b1";

export const profile: RepositoryProfile = {
  schemaVersion: "1",
  language: "typescript",
  runtime: { name: "node", major: 22 },
  packageManager: { name: "npm", lockfile: "package-lock.json" },
  moduleSystem: "esm",
  dependencies: {
    "@modelcontextprotocol/sdk": "1.30.1",
    hono: "4.13.9",
    zod: "4.6.5",
  },
  frameworks: ["hono"],
};

export const task: TaskRequest = {
  schemaVersion: "1",
  capability: "mcp-server.add-payment-gating",
};

export const evidence: ProfileEvidence = {
  benchmarkVersion: "bench-1",
  runSetDigest: hex32("12"),
  fixtureProfileDigest: hex32("13"),
  model: "example-model-1",
  measuredAt: "2026-09-20T00:00:00.000Z",
  staleAfter: "2026-12-20T00:00:00.000Z",
  runs: { control: 3, treatment: 3 },
  passed: { control: 3, treatment: 3 },
  controlMedianCostUsdc: "2500000",
  expectedRawSavingUsdc: "1000000",
  expectedTokenSaving: 420000,
};

export const release: CapabilityRelease = {
  schemaVersion: "1",
  releaseId: "mcp-server-payment-gating",
  version: "0.1.0",
  capability: "mcp-server.add-payment-gating",
  title: "Payment gating for a TypeScript MCP server",
  supportedProfiles: [
    {
      languages: ["typescript"],
      nodeMajor: { min: 22, max: 24 },
      packageManagers: ["npm", "pnpm"],
      moduleSystems: ["esm"],
      dependencies: { "@modelcontextprotocol/sdk": "^1.30.0", hono: ">=4.10 <5" },
      frameworks: ["hono"],
      evidence,
    },
  ],
  provenance: {
    repository: "https://github.com/example/mcp-payment-gating",
    commit: "0123456789abcdef0123456789abcdef01234567",
    spdxLicense: "MIT",
  },
  payloadDigest: hex32("11"),
  acceptanceRecipe: { script: "test", args: ["--run"], timeoutSec: 300, env: ["CI", "NODE_ENV"] },
  price: "250000",
  provider: { payTo: PROVIDER },
  warranty: { claimWindowHours: 72 },
  publishedAt: "2026-09-24T00:00:00.000Z",
  expiresAt: "2026-12-31T00:00:00.000Z",
};

export const terms = {
  scheme: "exact" as const,
  network: ARBITRUM_SEPOLIA,
  asset: ARBITRUM_SEPOLIA_USDC,
  amount: "250000",
  payTo: PROVIDER,
  maxTimeoutSeconds: 300,
};

export const matched = { releaseId: "mcp-server-payment-gating", version: "0.1.0", releaseDigest: hex32("55"), profileIndex: 0 };

export const offerPreview: Preview = {
  schemaVersion: "1",
  previewId: hex32("22"),
  taskDigest: hex32("33"),
  profileDigest: hex32("44"),
  catalogDigest: hex32("45"),
  createdAt: "2026-09-24T12:00:00.000Z",
  decision: "reuse",
  release: matched,
  offer: { terms, expectedRawSavingUsdc: "1000000", expectedTokenSaving: 420000, claimWindowHours: 72, validUntil: "2026-09-24T12:15:00.000Z" },
  reasons: [],
};

export const declinePreview: Preview = {
  schemaVersion: "1",
  previewId: hex32("66"),
  taskDigest: hex32("33"),
  profileDigest: hex32("44"),
  catalogDigest: hex32("45"),
  createdAt: "2026-09-24T12:00:00.000Z",
  decision: "decline",
  reasons: ["UNSUPPORTED_RUNTIME"],
};

export const resolution: Resolution = {
  schemaVersion: "1",
  resolutionId: deriveResolutionId(hex32("22"), BUYER),
  previewId: hex32("22"),
  release: matched,
  profileDigest: hex32("44"),
  payloadDigest: hex32("11"),
  buyer: BUYER,
  terms,
  createdAt: "2026-09-24T12:01:00.000Z",
};

export const receipt: AdoptionReceipt = {
  schemaVersion: "1",
  resolutionId: resolution.resolutionId,
  outcome: "passed",
  acceptance: { exitCode: 0, durationMs: 41250, outputDigest: hex32("88") },
  recordedAt: "2026-09-24T12:05:00.000Z",
  signature: null,
};

export const policy: SpendingPolicy = {
  schemaVersion: "1",
  network: ARBITRUM_SEPOLIA,
  asset: ARBITRUM_SEPOLIA_USDC,
  allowedPayTo: [PROVIDER],
  maxPerResolutionUsdc: "500000",
  dailyCapUsdc: "1000000",
  maxAuthorizationSeconds: 300,
};

export const bundle: PatchBundle = {
  schemaVersion: "1",
  files: [
    { path: "src/payments.ts", op: "add", baseDigest: null, content: "export const paid = true;\n" },
    { path: "src/server.ts", op: "modify", baseDigest: hex32("99"), content: "import { paid } from './payments.js';\n" },
  ],
  dependencies: { "@x402/mcp": "^2.27.0" },
  devDependencies: {},
};

export const runRecord: RunRecord = {
  schemaVersion: "1",
  runId: hex32("c1"),
  benchmarkVersion: "bench-1",
  taskId: "mcp-server-gating",
  arm: "treatment",
  repetition: 1,
  fixtureProfileDigest: hex32("13"),
  releaseDigest: hex32("55"),
  model: "example-model-1",
  startedAt: "2026-09-21T10:00:00.000Z",
  finishedAt: "2026-09-21T10:30:00.000Z",
  tokens: { input: 400000, output: 20000, cacheRead: 150000, cacheWrite: 10000, reasoning: 5000 },
  rawModelCostMicroUsd: "900000",
  toolCalls: 12,
  retries: 1,
  filesChanged: 3,
  humanInterventions: 0,
  acceptance: { passed: true, exitCode: 0 },
  payment: { amountUsdc: "250000", gasCostMicroUsd: "10000", transaction: hex32("7a") },
};
