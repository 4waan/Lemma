import { randomInt } from "node:crypto";

import { describeError } from "../errors.js";
import type { Logger } from "../log.js";

/**
 * Runs `tick` now and then every `intervalMs`, one run at a time (a run still
 * going when the next is due makes that one a no-op), on a timer that never
 * holds the process open. A run that throws is logged as `event` with the
 * error's name and code only, and the loop goes on. Returns a stop function.
 */
export function runEvery(intervalMs: number, tick: () => Promise<unknown>, logger: Logger, event: string): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      logger.log("warn", event, { error: describeError(error) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}

/** A uniformly random whole number in `[0, max]`, from `crypto.randomInt`. */
export type Jitter = (max: number) => number;

export const cryptoJitter: Jitter = (max) => (max <= 0 ? 0 : randomInt(0, Math.min(max, 2 ** 48 - 2) + 1));

/** Per-row retry delays: `baseMs * 2^(attempt-1)` up to `maxMs`, plus up to a fifth of that at random. */
export interface Backoff {
  readonly baseMs: number;
  readonly maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { baseMs: 30_000, maxMs: 3_600_000 };

/** The delay before attempt `attempt + 1` after attempt `attempt` (at least 1) failed, with jitter. */
export function backoffDelay(backoff: Backoff, attempt: number, jitter: Jitter): number {
  const base = Math.min(backoff.baseMs * 2 ** Math.min(Math.max(0, attempt - 1), 30), backoff.maxMs);
  return base + jitter(Math.floor(base / 5));
}
