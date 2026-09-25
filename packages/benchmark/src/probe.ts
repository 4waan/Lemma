import { type RunRecord, maxPriceFor } from "@lemma/core";

import { BenchmarkError, medianFloor, totalTokens } from "./evidence.js";
import type { Slot } from "./matrix.js";
import type { Attempt } from "./records.js";

/** Runs per candidate release in the stage-4 probe (docs/economic-gates.md). */
export const PROBE_CONTROL_RUNS = 3;
export const PROBE_TREATMENT_RUNS = 1;
/** Extra attempts per arm the probe may spend replacing runs that measured nothing. */
export const PROBE_EXTRA_ATTEMPTS = 2;

/**
 * Statuses that make a run a probe measurement. An agent error or an outside
 * cancel says nothing about the task: with the bundle pre-applied, a treatment
 * that errored at once would pass acceptance at almost no cost and fake a
 * saving. A timeout is a measurement: the agent spent its whole budget.
 */
const MEASURED: ReadonlySet<Attempt["status"]> = new Set(["finished", "timeout"]);

const measured = (a: Attempt) => !a.startupFailure && MEASURED.has(a.status);
const byStart = (a: Attempt, b: Attempt) => (a.startedAt === b.startedAt ? (a.runId < b.runId ? -1 : 1) : a.startedAt < b.startedAt ? -1 : 1);

/**
 * The next probe run, or null when the probe has its three measured controls
 * and one measured treatment. `benchmark probe` resumes from the attempt log
 * with this, so running it again only fills what is missing. It gives up after
 * PROBE_EXTRA_ATTEMPTS replacements per arm rather than keep spending.
 */
export function nextProbeSlot(attempts: readonly Attempt[], taskId: string): Slot | null {
  for (const [arm, needed] of [["control", PROBE_CONTROL_RUNS], ["treatment", PROBE_TREATMENT_RUNS]] as const) {
    const mine = attempts.filter((a) => a.taskId === taskId && a.arm === arm);
    const usable = mine.filter(measured).length;
    if (usable >= needed) continue;
    if (mine.length >= needed + PROBE_EXTRA_ATTEMPTS) {
      throw new BenchmarkError(`probe ${taskId}: ${mine.length} ${arm} attempts and only ${usable} measured; giving up rather than spending more`);
    }
    return { taskId, arm, repetition: mine.length + 1 };
  }
  return null;
}

export interface ProbeEconomics {
  /** Whether catalog economics are measured; a placeholder makes the verdict provisional. */
  readonly status: "placeholder" | "measured";
  readonly chainCostAtomic: bigint;
  readonly priceFloorAtomic: bigint;
}

/** The note a verdict carries when it was decided on placeholder economics. */
export const PLACEHOLDER_ECONOMICS_NOTE = "economics are a placeholder (chain cost and price floor not measured): this verdict is provisional";

export interface ProbeVerdict {
  readonly taskId: string;
  readonly controlRuns: number;
  /** Median raw model cost of the control runs, micro-USD: the probe's `C`. */
  readonly controlMedianMicroUsd: bigint;
  readonly treatmentMicroUsd: bigint;
  /** `C` minus the pre-applied treatment's cost, floored at 0: an optimistic `S`. */
  readonly savingMicroUsd: bigint;
  readonly controlMedianTokens: bigint;
  readonly treatmentTokens: bigint;
  /** `maxPriceFor(S, C, g)`: the price to pre-register when the verdict is go. */
  readonly maxPriceAtomic: bigint;
  readonly economicsStatus: ProbeEconomics["status"];
  /** The chain cost `g` the verdict used. */
  readonly chainCostAtomic: bigint;
  readonly priceFloorAtomic: bigint;
  readonly verdict: "go" | "kill";
  readonly notes: readonly string[];
}

/**
 * The stage-4 kill test. With three control runs and one treatment run that
 * starts from the pre-applied bundle, `S = C - treatment`. The release family
 * goes on only if `maxPriceFor(S, C, g)` reaches the price floor: some price
 * then satisfies the sale rule, the 25% all-in target after chain cost, and the
 * floor. The pre-applied treatment leaves out Lemma's own overhead (tool
 * definitions, preview, apply and acceptance steps), so `S` is optimistic: a
 * go is permission to continue, never evidence to sell on.
 *
 * Only measured runs count (see MEASURED), and the earliest ones: the first
 * three controls and the first treatment, so re-running cannot pick a
 * favourable result. The treatment must also have finished on its own. A
 * verdict on placeholder economics records that, with a note: it is not a
 * stage-4 pass until it is decided again on measured ones.
 */
export function probeVerdict(records: readonly RunRecord[], attempts: readonly Attempt[], taskId: string, economics: ProbeEconomics): ProbeVerdict {
  const recordOf = new Map(records.map((r) => [r.runId, r]));
  const mine = attempts.filter((a) => a.taskId === taskId);
  const usable = mine.filter(measured).sort(byStart);
  const controlAttempts = usable.filter((a) => a.arm === "control").slice(0, PROBE_CONTROL_RUNS);
  const treatmentAttempt = usable.find((a) => a.arm === "treatment");
  if (controlAttempts.length < PROBE_CONTROL_RUNS) throw new BenchmarkError(`probe ${taskId}: ${controlAttempts.length} measured control runs, ${PROBE_CONTROL_RUNS} needed`);
  if (treatmentAttempt === undefined) throw new BenchmarkError(`probe ${taskId}: no measured treatment run`);
  const recordFor = (a: Attempt): RunRecord => {
    const r = recordOf.get(a.runId);
    if (r === undefined) throw new BenchmarkError(`probe ${taskId}: run ${a.runId} has no settled cost yet`);
    return r;
  };
  const controls = controlAttempts.map(recordFor);
  const treatment = recordFor(treatmentAttempt);
  const notes: string[] = [];
  const unmeasured = mine.filter((a) => !measured(a)).length;
  if (unmeasured > 0) notes.push(`${unmeasured} attempts measured nothing (startup failure, agent error or cancel) and were replaced`);
  if (usable.length > PROBE_CONTROL_RUNS + PROBE_TREATMENT_RUNS) notes.push("later runs beyond the first three controls and first treatment were ignored");
  if (treatmentAttempt.status !== "finished") notes.push(`the pre-applied treatment ended with status ${treatmentAttempt.status}`);
  if (!treatment.acceptance.passed) notes.push("the pre-applied treatment did not reach green");
  if (controls.some((r) => !r.acceptance.passed)) notes.push("some control runs did not reach green; their cost still counts");
  if (economics.status !== "measured") notes.push(PLACEHOLDER_ECONOMICS_NOTE);

  const control = medianFloor(controls.map((r) => BigInt(r.rawModelCostMicroUsd)));
  const treated = BigInt(treatment.rawModelCostMicroUsd);
  const raw = control - treated;
  const saving = raw < 0n ? 0n : raw;
  const maxPrice = maxPriceFor(
    { controlMedianCostUsdc: control.toString(), expectedRawSavingUsdc: saving.toString() },
    { chainCostAtomic: economics.chainCostAtomic },
  );
  const go = treatmentAttempt.status === "finished" && treatment.acceptance.passed && maxPrice > 0n && maxPrice >= economics.priceFloorAtomic;
  return {
    taskId,
    controlRuns: controls.length,
    controlMedianMicroUsd: control,
    treatmentMicroUsd: treated,
    savingMicroUsd: saving,
    controlMedianTokens: medianFloor(controls.map(totalTokens)),
    treatmentTokens: totalTokens(treatment),
    maxPriceAtomic: maxPrice,
    economicsStatus: economics.status,
    chainCostAtomic: economics.chainCostAtomic,
    priceFloorAtomic: economics.priceFloorAtomic,
    verdict: go ? "go" : "kill",
    notes,
  };
}
