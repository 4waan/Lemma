import type { RunArm } from "@lemma/core";

import type { Attempt } from "./records.js";

export interface Slot {
  readonly taskId: string;
  readonly arm: RunArm;
  readonly repetition: number;
}

/**
 * The run order for a frozen matrix. Arms interleave, alternating which goes
 * first per repetition (control-first on odd repetitions, treatment-first on
 * even ones), so time-of-day drift and provider load hit both arms alike.
 */
export function planMatrix(taskIds: readonly string[], repetitions: number): Slot[] {
  const tasks = [...new Set(taskIds)].sort();
  const slots: Slot[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const arms: RunArm[] = repetition % 2 === 1 ? ["control", "treatment"] : ["treatment", "control"];
    for (const taskId of tasks) for (const arm of arms) slots.push({ taskId, arm, repetition });
  }
  return slots;
}

/**
 * The attempt number to run next for a slot, or null when the slot is done: it
 * has a real result, or two startup failures. `benchmark run` resumes from the
 * attempt log with this, so running it again after an interruption finishes
 * the matrix without repeating a slot.
 */
export function nextAttempt(attempts: readonly Attempt[], slot: Slot): 1 | 2 | null {
  const mine = attempts.filter((a) => a.taskId === slot.taskId && a.arm === slot.arm && a.repetition === slot.repetition);
  if (mine.some((a) => !a.startupFailure) || mine.length >= 2) return null;
  return mine.length === 0 ? 1 : 2;
}
