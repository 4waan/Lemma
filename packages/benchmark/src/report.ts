import { Hex32, ProfileEvidence, type RunRecord, runSetDigest } from "@lemma/core";
import { z } from "zod";

import { deriveEvidence, evaluateBenchmark, pairedRelease } from "./evidence.js";
import { nextAttempt, planMatrix } from "./matrix.js";
import type { Attempt } from "./records.js";

/**
 * The public aggregate of one benchmark version (benchmark-protocol.md
 * "Output"): counts, verdicts and evidence only. It holds no prompt, tool
 * output, path or environment value. Each evidence entry names the release the
 * paired treatments bought and its base, which is what the catalog binds
 * evidence to.
 */
export const BenchmarkReport = z.strictObject({
  schemaVersion: z.literal("1"),
  benchmarkVersion: z.string(),
  runSetDigest: Hex32,
  runs: z.int().min(0),
  excludedStartupFailures: z.int().min(0),
  passes: z.boolean(),
  tasks: z.array(
    z.strictObject({
      taskId: z.string(),
      kind: z.enum(["match", "no-match"]),
      pairs: z.int(),
      controlPassed: z.int(),
      treatmentPassed: z.int(),
      allInReductionBps: z.string(),
      tokenReductionBps: z.string(),
      treatmentSpentUsdc: z.string(),
      failures: z.array(z.string()),
    }),
  ),
  evidence: z.array(
    z.strictObject({
      taskId: z.string(),
      adoptedReleaseDigest: Hex32,
      baseReleaseDigest: Hex32,
      evidence: ProfileEvidence,
    }),
  ),
  evidenceErrors: z.array(z.strictObject({ taskId: z.string(), error: z.string() })),
});

export type BenchmarkReport = z.infer<typeof BenchmarkReport>;

/**
 * Builds the report from reconciled records and the attempt log (for bases and
 * excluded startup failures), against the frozen matrix: every frozen task and
 * every slot must have a result, or have used up its startup retries, or the
 * task fails. A task with no runs at all fails too, instead of dropping out.
 */
export function buildReport(
  records: readonly RunRecord[],
  attempts: readonly Attempt[],
  options: {
    readonly benchmarkVersion: string;
    readonly tasks: readonly string[];
    readonly repetitions: number;
    readonly noMatchTaskIds: readonly string[];
    readonly staleAfterDays: number;
  },
): BenchmarkReport {
  const runs = records.filter((r) => r.benchmarkVersion === options.benchmarkVersion);
  const mine = attempts.filter((a) => a.benchmarkVersion === options.benchmarkVersion);
  const verdict = evaluateBenchmark(runs, { noMatchTaskIds: options.noMatchTaskIds, taskIds: options.tasks });
  const missing = new Map<string, string[]>();
  for (const slot of planMatrix(options.tasks, options.repetitions)) {
    const done = runs.some((r) => r.taskId === slot.taskId && r.arm === slot.arm && r.repetition === slot.repetition);
    // A slot closed by two startup failures has no result by design; one never run, or still retryable, is missing.
    if (!done && nextAttempt(mine, slot) !== null) missing.set(slot.taskId, [...(missing.get(slot.taskId) ?? []), `${slot.arm} #${slot.repetition} has no result`]);
  }
  const tasks = verdict.tasks.map((t) => ({ ...t, failures: [...t.failures, ...(missing.get(t.taskId) ?? [])] }));
  const evidence: BenchmarkReport["evidence"] = [];
  const evidenceErrors: BenchmarkReport["evidenceErrors"] = [];
  for (const task of tasks.filter((t) => t.kind === "match")) {
    try {
      const derived = deriveEvidence(runs, { taskId: task.taskId, staleAfterDays: options.staleAfterDays });
      const { release: adopted, treatmentRunIds } = pairedRelease(runs, task.taskId);
      const bases = new Set(mine.filter((a) => treatmentRunIds.includes(a.runId)).map((a) => a.baseReleaseDigest));
      const base = bases.size === 1 ? [...bases][0] : null;
      if (adopted === null || base === null || base === undefined) throw new Error("the treatment's release and its base are unknown");
      evidence.push({ taskId: task.taskId, adoptedReleaseDigest: adopted, baseReleaseDigest: base, evidence: derived });
    } catch (error) {
      evidenceErrors.push({ taskId: task.taskId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return BenchmarkReport.parse({
    schemaVersion: "1",
    benchmarkVersion: options.benchmarkVersion,
    runSetDigest: runSetDigest(options.benchmarkVersion, runs),
    runs: runs.length,
    excludedStartupFailures: mine.filter((a) => a.startupFailure).length,
    passes: verdict.passes && tasks.every((t) => t.failures.length === 0),
    tasks: tasks.map((t) => ({
      ...t,
      allInReductionBps: t.allInReductionBps.toString(),
      tokenReductionBps: t.tokenReductionBps.toString(),
      treatmentSpentUsdc: t.treatmentSpentUsdc.toString(),
      failures: [...t.failures],
    })),
    evidence,
    evidenceErrors,
  });
}
