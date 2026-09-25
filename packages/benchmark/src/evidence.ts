import { RESERVED_BENCHMARK_PREFIXES } from "@lemma/catalog";
import { BENCHMARK_TARGET_BPS, ProfileEvidence, type RunRecord, RunRecord as RunRecordSchema, runSetDigest } from "@lemma/core";

/** Fewest complete control/treatment pairs a sold saving may rest on. */
export const MIN_PAIRS = 3;

export class BenchmarkError extends Error {
  override name = "BenchmarkError";
}

const sortBig = (values: readonly bigint[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Median in integer arithmetic; for an even count, the floor of the mean of the middle two. */
export function medianFloor(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new BenchmarkError("median of an empty set");
  const s = sortBig(values);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as bigint;
  const sum = (s[mid - 1] as bigint) + (s[mid] as bigint);
  // Floor division, also for negative sums.
  return sum >= 0n ? sum / 2n : -((-sum + 1n) / 2n);
}

/** Nearest-rank 25th percentile. With three pairs it is the minimum. */
export function lowerQuartile(values: readonly bigint[]): bigint {
  if (values.length === 0) throw new BenchmarkError("quartile of an empty set");
  const s = sortBig(values);
  return s[Math.max(0, Math.ceil(0.25 * s.length) - 1)] as bigint;
}

export function totalTokens(r: RunRecord): bigint {
  const t = r.tokens;
  return BigInt(t.input) + BigInt(t.output) + BigInt(t.cacheRead) + BigInt(t.cacheWrite) + BigInt(t.reasoning);
}

/** Raw model cost plus what the run paid Lemma plus chain gas, in micro-USD. */
export function allInCost(r: RunRecord): bigint {
  const paid = r.payment ? BigInt(r.payment.amountUsdc) + BigInt(r.payment.gasCostMicroUsd) : 0n;
  return BigInt(r.rawModelCostMicroUsd) + paid;
}

function only<T>(values: readonly T[], what: string): T {
  const distinct = [...new Set(values)];
  if (distinct.length !== 1) throw new BenchmarkError(`records disagree on ${what}: ${distinct.join(", ")}`);
  return distinct[0] as T;
}

interface Pair {
  readonly control: RunRecord;
  readonly treatment: RunRecord;
}

/** Validates the records of one task and pairs them by repetition. */
function pairsFor(records: readonly RunRecord[], taskId: string): { runs: RunRecord[]; pairs: Pair[] } {
  const runs = records.map((r) => RunRecordSchema.parse(r)).filter((r) => r.taskId === taskId);
  if (runs.length === 0) throw new BenchmarkError(`no runs for task ${taskId}`);
  only(runs.map((r) => r.benchmarkVersion), "benchmarkVersion");
  only(runs.map((r) => r.model), "model (the model is frozen before measured runs)");
  only(runs.map((r) => r.fixtureProfileDigest), "fixtureProfileDigest");

  const byArm = { control: new Map<number, RunRecord>(), treatment: new Map<number, RunRecord>() };
  for (const r of runs) {
    if (byArm[r.arm].has(r.repetition)) throw new BenchmarkError(`duplicate ${r.arm} repetition ${r.repetition} for ${taskId}`);
    byArm[r.arm].set(r.repetition, r);
  }
  const pairs: Pair[] = [];
  for (const [rep, control] of [...byArm.control.entries()].sort((a, b) => a[0] - b[0])) {
    const treatment = byArm.treatment.get(rep);
    if (treatment) pairs.push({ control, treatment });
  }
  return { runs, pairs };
}

/**
 * The release the paired treatments of a task adopted, the one
 * `deriveEvidence` verified, with those treatments' run ids. An unpaired
 * treatment never names the release its task's evidence is bound to.
 */
export function pairedRelease(records: readonly RunRecord[], taskId: string): { release: RunRecord["releaseDigest"]; treatmentRunIds: string[] } {
  const { pairs } = pairsFor(records, taskId);
  if (pairs.length === 0) throw new BenchmarkError(`no complete pairs for ${taskId}`);
  const treatments = pairs.map((p) => p.treatment);
  return { release: only(treatments.map((t) => t.releaseDigest), "the adopted release"), treatmentRunIds: treatments.map((t) => t.runId) };
}

export interface EvidenceOptions {
  readonly taskId: string;
  /** How long the evidence stays sellable after the last run finished. */
  readonly staleAfterDays: number;
}

/**
 * Turns the paired runs of one task into the ProfileEvidence a release profile
 * carries. The sold saving is conservative: the lower quartile of the paired
 * raw-cost savings (the minimum for three pairs), clamped to [0, control
 * median]. A failed control run counts at the cost it reached, which can only
 * understate the saving.
 */
export function deriveEvidence(records: readonly RunRecord[], options: EvidenceOptions): ProfileEvidence {
  const { runs, pairs } = pairsFor(records, options.taskId);
  const version = runs[0]?.benchmarkVersion ?? "";
  const reserved = RESERVED_BENCHMARK_PREFIXES.find((p) => version.startsWith(p));
  if (reserved !== undefined) {
    throw new BenchmarkError(`benchmark version ${version} is reserved (${reserved}): exploratory and provisional runs never become evidence`);
  }
  if (pairs.length < MIN_PAIRS) throw new BenchmarkError(`${pairs.length} complete pairs for ${options.taskId}; at least ${MIN_PAIRS} are required`);
  const treatments = pairs.map((p) => p.treatment);
  const release = only(treatments.map((t) => t.releaseDigest), "the adopted release");
  if (release === null) throw new BenchmarkError(`task ${options.taskId} adopted no release; a no-match task produces no evidence`);

  const controls = pairs.map((p) => p.control);
  const controlMedian = medianFloor(controls.map((r) => BigInt(r.rawModelCostMicroUsd)));
  const savings = pairs.map((p) => BigInt(p.control.rawModelCostMicroUsd) - BigInt(p.treatment.rawModelCostMicroUsd));
  const conservative = lowerQuartile(savings);
  const saving = conservative < 0n ? 0n : conservative > controlMedian ? controlMedian : conservative;
  const tokenSaving = medianFloor(pairs.map((p) => totalTokens(p.control) - totalTokens(p.treatment)));

  const measuredAt = new Date(Math.max(...runs.map((r) => Date.parse(r.finishedAt))));
  const staleAfter = new Date(measuredAt.getTime() + options.staleAfterDays * 86_400_000);

  return ProfileEvidence.parse({
    benchmarkVersion: runs[0]?.benchmarkVersion,
    runSetDigest: runSetDigest(runs[0]?.benchmarkVersion ?? "", runs),
    fixtureProfileDigest: runs[0]?.fixtureProfileDigest,
    model: runs[0]?.model,
    measuredAt: measuredAt.toISOString(),
    staleAfter: staleAfter.toISOString(),
    runs: { control: controls.length, treatment: treatments.length },
    passed: { control: controls.filter((r) => r.acceptance.passed).length, treatment: treatments.filter((r) => r.acceptance.passed).length },
    controlMedianCostUsdc: controlMedian.toString(),
    expectedRawSavingUsdc: saving.toString(),
    expectedTokenSaving: Number(tokenSaving < 0n ? 0n : tokenSaving),
  });
}

export interface TaskVerdict {
  readonly taskId: string;
  readonly kind: "match" | "no-match";
  readonly pairs: number;
  readonly controlPassed: number;
  readonly treatmentPassed: number;
  /** Median all-in cost reduction, basis points of the control median. */
  readonly allInReductionBps: bigint;
  /** Median total-token reduction, basis points of the control median. */
  readonly tokenReductionBps: bigint;
  readonly treatmentSpentUsdc: bigint;
  readonly failures: readonly string[];
}

export interface BenchmarkVerdict {
  readonly passes: boolean;
  readonly tasks: readonly TaskVerdict[];
}

/** Reduction in basis points of the control, rounded toward negative infinity so it never overstates. */
export function reductionBps(control: bigint, treatment: bigint): bigint {
  if (control === 0n) return 0n;
  const numerator = (control - treatment) * 10_000n;
  const q = numerator / control;
  return numerator < 0n && q * control !== numerator ? q - 1n : q;
}

/**
 * The success criteria of docs/benchmark-protocol.md, evaluated per task: both
 * arms reach the same acceptance result with no regression, treatment median
 * all-in cost and total tokens are at least 25 percent lower on matched tasks,
 * and the no-match task spends nothing. A missed target is reported with its
 * measured values, never rounded into a pass. `taskIds` names the frozen
 * tasks: one with no runs fails instead of dropping out. A benchmark passes
 * only with at least one matched task.
 */
export function evaluateBenchmark(records: readonly RunRecord[], options: { readonly noMatchTaskIds: readonly string[]; readonly taskIds?: readonly string[] }): BenchmarkVerdict {
  const parsed = records.map((r) => RunRecordSchema.parse(r));
  const recorded = new Set(parsed.map((r) => r.taskId));
  for (const id of options.noMatchTaskIds) {
    if (!recorded.has(id) && options.taskIds === undefined) throw new BenchmarkError(`no-match task ${id} has no runs`);
  }
  const taskIds = [...new Set([...recorded, ...(options.taskIds ?? [])])].sort();
  const tasks = taskIds.map((taskId): TaskVerdict => {
    const kind = options.noMatchTaskIds.includes(taskId) ? "no-match" : "match";
    if (!recorded.has(taskId)) {
      return { taskId, kind, pairs: 0, controlPassed: 0, treatmentPassed: 0, allInReductionBps: 0n, tokenReductionBps: 0n, treatmentSpentUsdc: 0n, failures: ["no runs"] };
    }
    const { pairs } = pairsFor(parsed, taskId);
    const failures: string[] = [];
    const controls = pairs.map((p) => p.control);
    const treatments = pairs.map((p) => p.treatment);
    const controlPassed = controls.filter((r) => r.acceptance.passed).length;
    const treatmentPassed = treatments.filter((r) => r.acceptance.passed).length;
    const spent = treatments.reduce((n, r) => n + (r.payment ? BigInt(r.payment.amountUsdc) : 0n), 0n);
    if (pairs.length < MIN_PAIRS) failures.push(`only ${pairs.length} complete pairs`);
    if (treatmentPassed < controlPassed) failures.push("correctness regression: fewer treatment runs passed");
    if (treatmentPassed !== pairs.length) failures.push("not every treatment run reached green");
    const allIn = pairs.length ? reductionBps(medianFloor(controls.map(allInCost)), medianFloor(treatments.map(allInCost))) : 0n;
    const tokens = pairs.length ? reductionBps(medianFloor(controls.map(totalTokens)), medianFloor(treatments.map(totalTokens))) : 0n;
    if (kind === "match") {
      if (allIn < BENCHMARK_TARGET_BPS) failures.push(`all-in cost reduction ${allIn} bps is below ${BENCHMARK_TARGET_BPS}`);
      if (tokens < BENCHMARK_TARGET_BPS) failures.push(`token reduction ${tokens} bps is below ${BENCHMARK_TARGET_BPS}`);
    } else if (spent !== 0n) {
      failures.push(`no-match treatment spent ${spent} atomic USDC`);
    }
    return { taskId, kind, pairs: pairs.length, controlPassed, treatmentPassed, allInReductionBps: allIn, tokenReductionBps: tokens, treatmentSpentUsdc: spent, failures };
  });
  return { passes: tasks.some((t) => t.kind === "match") && tasks.every((t) => t.failures.length === 0), tasks };
}
