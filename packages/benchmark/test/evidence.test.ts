import {
  type CapabilityRelease,
  CapabilityRelease as CapabilityReleaseSchema,
  type RunRecord,
  allInReductionBps,
  isSellable,
  runRecordDigest,
  runSetDigest,
  saleBlocker,
} from "@lemma/core";
import { describe, expect, it } from "vitest";

import { BenchmarkError, deriveEvidence, evaluateBenchmark, lowerQuartile, medianFloor } from "../src/index.js";

const hex32 = (byte: string) => `0x${byte.repeat(32)}`;
const RELEASE = hex32("5e");
const FIXTURE = hex32("f1");

function run(arm: "control" | "treatment", repetition: number, costMicroUsd: number, tokens: number, patch: Partial<RunRecord> = {}): RunRecord {
  const treatment = arm === "treatment";
  return {
    schemaVersion: "1",
    runId: hex32(`${arm === "control" ? "c" : "d"}${repetition}`),
    benchmarkVersion: "bench-1",
    taskId: "mcp-server-gating",
    arm,
    repetition,
    fixtureProfileDigest: FIXTURE,
    releaseDigest: treatment ? RELEASE : null,
    model: "example-model-1",
    startedAt: `2026-09-2${repetition}T10:00:00.000Z`,
    finishedAt: `2026-09-2${repetition}T10:30:00.000Z`,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    rawModelCostMicroUsd: String(costMicroUsd),
    toolCalls: 10,
    retries: 0,
    filesChanged: 3,
    humanInterventions: 0,
    acceptance: { passed: true, exitCode: 0 },
    payment: treatment ? { amountUsdc: "250000", gasCostMicroUsd: "10000", transaction: null } : null,
    ...patch,
  };
}

// Control: 2.40, 2.50, 2.80 USD. Treatment: 0.90, 1.20, 1.00 USD. Paired savings: 1.50, 1.30, 1.80.
const RECORDS = [
  run("control", 1, 2_400_000, 900_000),
  run("control", 2, 2_500_000, 1_000_000),
  run("control", 3, 2_800_000, 1_100_000),
  run("treatment", 1, 900_000, 400_000),
  run("treatment", 2, 1_200_000, 500_000),
  run("treatment", 3, 1_000_000, 450_000),
];

describe("statistics", () => {
  it("computes integer medians and a conservative quartile", () => {
    expect(medianFloor([3n, 1n, 2n])).toBe(2n);
    expect(medianFloor([1n, 2n])).toBe(1n);
    expect(medianFloor([-3n, 0n])).toBe(-2n);
    expect(lowerQuartile([5n, 1n, 3n])).toBe(1n);
    expect(lowerQuartile([8n, 1n, 2n, 3n, 4n, 5n, 6n, 7n])).toBe(2n);
    expect(() => medianFloor([])).toThrow(BenchmarkError);
  });
});

describe("deriveEvidence", () => {
  const evidence = deriveEvidence(RECORDS, { taskId: "mcp-server-gating", staleAfterDays: 90 });

  it("prices off the most conservative paired saving, not the average", () => {
    expect(evidence.controlMedianCostUsdc).toBe("2500000");
    expect(evidence.expectedRawSavingUsdc).toBe("1300000");
    expect(evidence.expectedTokenSaving).toBe(500_000);
    expect(evidence.runs).toEqual({ control: 3, treatment: 3 });
    expect(evidence.passed).toEqual({ control: 3, treatment: 3 });
  });

  it("binds the evidence to the exact runs and fixture that measured it", () => {
    expect(evidence.runSetDigest).toBe(runSetDigest("bench-1", RECORDS));
    expect(evidence.fixtureProfileDigest).toBe(FIXTURE);
    expect(evidence.model).toBe("example-model-1");
    expect(evidence.measuredAt).toBe("2026-09-23T10:30:00.000Z");
    expect(evidence.staleAfter).toBe("2026-12-22T10:30:00.000Z");
  });

  it("changes the run-set digest when any run changes", () => {
    const tampered = RECORDS.map((r, i) => (i === 0 ? { ...r, rawModelCostMicroUsd: "2400001" } : r));
    expect(runSetDigest("bench-1", tampered)).not.toBe(evidence.runSetDigest);
    expect(runRecordDigest(RECORDS[0] as RunRecord)).not.toBe(runRecordDigest(tampered[0] as RunRecord));
  });

  it("clamps a negative saving to zero, which is never sellable", () => {
    const worse = RECORDS.map((r) => (r.arm === "treatment" ? { ...r, rawModelCostMicroUsd: "3000000" } : r));
    const e = deriveEvidence(worse, { taskId: "mcp-server-gating", staleAfterDays: 90 });
    expect(e.expectedRawSavingUsdc).toBe("0");
    expect(e.expectedTokenSaving).toBe(500_000);
  });

  it("refuses evidence the protocol does not allow", () => {
    const opts = { taskId: "mcp-server-gating", staleAfterDays: 90 };
    expect(() => deriveEvidence(RECORDS.slice(0, 5), opts)).toThrow(/at least 3/);
    expect(() => deriveEvidence(RECORDS.map((r, i) => (i === 1 ? { ...r, model: "other-model" } : r)), opts)).toThrow(/model/);
    expect(() => deriveEvidence([...RECORDS, run("control", 1, 1, 1, { runId: hex32("99") })], opts)).toThrow(/duplicate/);
    const noMatch = RECORDS.map((r) => (r.arm === "treatment" ? { ...r, releaseDigest: null, payment: null } : r));
    expect(() => deriveEvidence(noMatch, opts)).toThrow(/no-match/);
    expect(() => deriveEvidence(RECORDS, { ...opts, taskId: "other" })).toThrow(/no runs/);
  });
});

describe("the money path: runs → evidence → sale rule", () => {
  const evidence = deriveEvidence(RECORDS, { taskId: "mcp-server-gating", staleAfterDays: 90 });
  const now = new Date("2026-10-01T00:00:00.000Z");

  it("sells at most 30 percent of the conservative saving", () => {
    expect(saleBlocker(390_000n, evidence, now)).toBeNull();
    expect(saleBlocker(390_001n, evidence, now)).toBe("PRICE_EXCEEDS_SAVING_RULE");
    expect(isSellable(390_000n, BigInt(evidence.expectedRawSavingUsdc))).toBe(true);
  });

  it("drops to preview-only when the evidence goes stale", () => {
    expect(saleBlocker(250_000n, evidence, new Date(evidence.staleAfter))).toBe("EVIDENCE_STALE");
  });

  it("fits into a release profile as its evidence", () => {
    const release: CapabilityRelease = {
      schemaVersion: "1",
      releaseId: "mcp-server-payment-gating",
      version: "0.1.0",
      capability: "mcp-server.add-payment-gating",
      title: "Payment gating for a TypeScript MCP server",
      supportedProfiles: [
        {
          languages: ["typescript"],
          nodeMajor: { min: 22, max: 24 },
          packageManagers: ["npm"],
          moduleSystems: ["esm"],
          dependencies: { hono: "^4.10.0" },
          frameworks: ["hono"],
          evidence,
        },
      ],
      provenance: { repository: "https://github.com/example/gating", commit: "0123456789abcdef0123456789abcdef01234567", spdxLicense: "MIT" },
      payloadDigest: hex32("11"),
      acceptanceRecipe: { script: "test", args: [], timeoutSec: 300, env: ["CI"] },
      price: "250000",
      provider: { payTo: "0x00000000000000000000000000000000000000a1" },
      warranty: { claimWindowHours: 72 },
      publishedAt: "2026-09-24T00:00:00.000Z",
      expiresAt: "2026-12-31T00:00:00.000Z",
    };
    expect(CapabilityReleaseSchema.safeParse(release).success).toBe(true);
    // Buyer keeps (1.30 - 0.25 - 0.01) / 2.50 = 41.6% of the control cost.
    expect(allInReductionBps(evidence, 250_000n, 10_000n)).toBe(4160n);
  });
});

describe("evaluateBenchmark", () => {
  const noMatch = [
    run("control", 1, 500_000, 200_000, { taskId: "unsupported" }),
    run("control", 2, 520_000, 210_000, { taskId: "unsupported" }),
    run("control", 3, 510_000, 205_000, { taskId: "unsupported" }),
    run("treatment", 1, 505_000, 201_000, { taskId: "unsupported", releaseDigest: null, payment: null }),
    run("treatment", 2, 515_000, 206_000, { taskId: "unsupported", releaseDigest: null, payment: null }),
    run("treatment", 3, 512_000, 204_000, { taskId: "unsupported", releaseDigest: null, payment: null }),
  ];

  it("passes when matched tasks clear 25 percent and the no-match task spends nothing", () => {
    const verdict = evaluateBenchmark([...RECORDS, ...noMatch], { noMatchTaskIds: ["unsupported"] });
    expect(verdict.passes).toBe(true);
    const matched = verdict.tasks.find((t) => t.taskId === "mcp-server-gating");
    // All-in: control median 2.50 vs treatment median 1.00 + 0.25 + 0.01 = 1.26 → 49.6%.
    expect(matched?.allInReductionBps).toBe(4960n);
    expect(matched?.tokenReductionBps).toBe(5500n);
  });

  it("fails a no-match task that paid", () => {
    const paid = noMatch.map((r, i) => (i === 3 ? { ...r, releaseDigest: RELEASE, payment: { amountUsdc: "1", gasCostMicroUsd: "0", transaction: null } } : r));
    const verdict = evaluateBenchmark([...RECORDS, ...paid], { noMatchTaskIds: ["unsupported"] });
    expect(verdict.passes).toBe(false);
    expect(verdict.tasks.find((t) => t.taskId === "unsupported")?.failures).toContain("no-match treatment spent 1 atomic USDC");
  });

  it("reports a missed target with the measured value instead of passing it", () => {
    const small = RECORDS.map((r) => (r.arm === "treatment" ? { ...r, rawModelCostMicroUsd: "1800000", tokens: { ...r.tokens, input: 900_000 } } : r));
    const verdict = evaluateBenchmark(small, { noMatchTaskIds: [] });
    expect(verdict.passes).toBe(false);
    expect(verdict.tasks[0]?.failures.join(" ")).toMatch(/all-in cost reduction 1760 bps is below 2500/);
  });

  it("fails a correctness regression", () => {
    const regressed = RECORDS.map((r, i) => (i === 4 ? { ...r, acceptance: { passed: false, exitCode: 1 } } : r));
    const verdict = evaluateBenchmark(regressed, { noMatchTaskIds: [] });
    expect(verdict.tasks[0]?.failures).toContain("correctness regression: fewer treatment runs passed");
  });
});
