import { z } from "zod";

import { UsdcAtomic } from "./amounts.js";
import { digest } from "./canonical.js";
import { Hex32, IsoTimestamp, SchemaVersion } from "./primitives.js";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "expected a lowercase slug");
const Count = z.int().min(0).max(1_000_000_000);

export const RunArm = z.enum(["control", "treatment"]);

export type RunArm = z.infer<typeof RunArm>;

/**
 * One benchmark run (docs/benchmark-protocol.md): one arm, one task, one
 * repetition, from a fresh fixture copy. Every run is kept, including failures.
 *
 * Model cost is micro-USD as reported by the agent SDK, in the same integer
 * scale as atomic USDC. Token counts are an independent measure, because
 * provider cost is eventually consistent.
 */
export const RunRecord = z
  .strictObject({
    schemaVersion: SchemaVersion,
    runId: Hex32,
    benchmarkVersion: Slug,
    taskId: Slug,
    arm: RunArm,
    repetition: z.int().min(1).max(100),
    /** Digest of the fixture repository's RepositoryProfile. */
    fixtureProfileDigest: Hex32,
    /** The release the treatment adopted; null for control runs and for no-match tasks. */
    releaseDigest: Hex32.nullable(),
    model: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:/-]+$/),
    startedAt: IsoTimestamp,
    finishedAt: IsoTimestamp,
    tokens: z.strictObject({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count, reasoning: Count }),
    rawModelCostMicroUsd: UsdcAtomic,
    toolCalls: Count,
    retries: Count,
    filesChanged: Count,
    humanInterventions: Count,
    acceptance: z.strictObject({ passed: z.boolean(), exitCode: z.int().min(0).max(255).nullable() }),
    /** What the treatment paid for its resolution; null when nothing was bought. */
    payment: z
      .strictObject({
        amountUsdc: UsdcAtomic,
        gasCostMicroUsd: UsdcAtomic,
        transaction: Hex32.nullable(),
      })
      .nullable(),
  })
  .superRefine((r, ctx) => {
    if (Date.parse(r.finishedAt) < Date.parse(r.startedAt)) {
      ctx.addIssue({ code: "custom", path: ["finishedAt"], message: "finishedAt must not precede startedAt" });
    }
    if (r.arm === "control" && (r.releaseDigest !== null || r.payment !== null)) {
      ctx.addIssue({ code: "custom", path: ["arm"], message: "a control run adopts no release and pays nothing" });
    }
    if (r.payment !== null && r.releaseDigest === null) {
      ctx.addIssue({ code: "custom", path: ["payment"], message: "a payment must name the adopted release" });
    }
    if (r.acceptance.passed && r.acceptance.exitCode !== 0) {
      ctx.addIssue({ code: "custom", path: ["acceptance", "exitCode"], message: "a passing run exits with code 0" });
    }
  });

export type RunRecord = z.infer<typeof RunRecord>;

export function runRecordDigest(record: RunRecord): Hex32 {
  return digest("run-record", RunRecord.parse(record));
}

/**
 * Digest of a set of runs: the sorted, de-duplicated run digests under one
 * benchmark version. ProfileEvidence.runSetDigest references it, so every sold
 * saving points at the exact records that measured it.
 */
export function runSetDigest(benchmarkVersion: string, records: readonly RunRecord[]): Hex32 {
  const runs = [...new Set(records.map(runRecordDigest))].sort();
  return digest("run-set", { schemaVersion: "1", benchmarkVersion: Slug.parse(benchmarkVersion), runs });
}
