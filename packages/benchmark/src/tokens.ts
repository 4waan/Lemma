import type { RunRecord } from "@lemma/core";

/** Token counts as the Cursor SDK reports them (`TokenUsage`). */
export interface ReportedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  /** A subset of `outputTokens`, when reported. */
  readonly reasoningTokens?: number | undefined;
}

export class UsageError extends Error {
  override name = "UsageError";
}

const count = (n: number | undefined, what: string): number => {
  const v = n ?? 0;
  if (!Number.isSafeInteger(v) || v < 0) throw new UsageError(`${what} must be a non-negative integer, got ${n}`);
  return v;
};

/**
 * Maps SDK usage to a RunRecord's five disjoint token counts. The SDK documents
 * reasoning as a subset of output that `totalTokens` leaves out, so reasoning
 * is subtracted from output and no token is counted twice (`totalTokens` in
 * evidence.ts sums all five). Usage that contradicts that contract (more
 * reasoning than output) is refused rather than mapped. Billed usage does not
 * split reasoning out, so records built from it carry reasoning inside output.
 */
export function toRunTokens(usage: ReportedUsage): RunRecord["tokens"] {
  const output = count(usage.outputTokens, "outputTokens");
  const reasoning = count(usage.reasoningTokens, "reasoningTokens");
  if (reasoning > output) throw new UsageError(`reasoningTokens (${reasoning}) exceed outputTokens (${output})`);
  return {
    input: count(usage.inputTokens, "inputTokens"),
    output: output - reasoning,
    cacheRead: count(usage.cacheReadTokens, "cacheReadTokens"),
    cacheWrite: count(usage.cacheWriteTokens, "cacheWriteTokens"),
    reasoning,
  };
}

/**
 * Float cents (the SDK's `rawCostCents`) to integer micro-USD, the RunRecord
 * cost unit: one cent is 10,000 micro-USD, rounded to the nearest unit.
 */
export function centsToMicroUsd(cents: number): bigint {
  if (!Number.isFinite(cents) || cents < 0) throw new UsageError(`cost must be a non-negative finite number of cents, got ${cents}`);
  return BigInt(Math.round(cents * 10_000));
}
