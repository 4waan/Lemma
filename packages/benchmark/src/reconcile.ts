import type { AgentAdapter } from "./adapter.js";
import { type RunLog, finalize, observe, settledBilling } from "./records.js";

export interface ReconcileResult {
  readonly reconciled: number;
  /** Attempts still without a settled cost, including those whose lookup failed. */
  readonly pending: number;
  /** Usage lookups that failed this time; their attempts stay pending. */
  readonly errors: ReadonlyArray<{ readonly agentId: string; readonly error: string }>;
}

/**
 * Reads billed usage for every completed attempt that has no RunRecord yet,
 * logs the read, and turns the attempt into a RunRecord once its billing has
 * settled (`settledBilling`). Cost that is unreported or still landing leaves
 * the attempt pending for the next reconcile; it is never estimated. A lookup
 * that fails leaves that attempt pending and the rest are still read.
 */
export async function reconcile(log: RunLog, adapter: AgentAdapter, clock: () => Date = () => new Date()): Promise<ReconcileResult> {
  let reconciled = 0;
  let pending = 0;
  const errors: Array<{ agentId: string; error: string }> = [];
  for (const attempt of log.pending()) {
    let billed = null;
    if (attempt.agentId !== null) {
      try {
        billed = await adapter.usage(attempt.agentId);
      } catch (error) {
        errors.push({ agentId: attempt.agentId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const now = clock();
    if (billed !== null) log.appendObservation(observe(attempt.runId, billed, now));
    const settled = settledBilling(attempt, log.observations(), now);
    const record = settled === null ? null : finalize(attempt, settled);
    if (record === null) {
      pending++;
      continue;
    }
    if (log.appendRecord(record)) reconciled++;
  }
  return { reconciled, pending, errors };
}
