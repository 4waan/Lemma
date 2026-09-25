/**
 * An in-memory token bucket per client key: `perMinute` requests per minute,
 * refilled continuously, with bursts up to `perMinute`. The MVP runs one
 * replica (server README), so memory is shared state enough. The key table is
 * bounded: the least recently seen keys are dropped first.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Takes one token for `key`; returns the seconds to wait, or 0 when allowed. */
  take(key: string, now: number): number {
    const capacity = this.perMinute;
    const rate = capacity / 60_000;
    const current = this.buckets.get(key);
    const tokens = current === undefined ? capacity : Math.min(capacity, current.tokens + (now - current.at) * rate);
    this.buckets.delete(key);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now });
      return Math.ceil((1 - tokens) / rate / 1000);
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return 0;
  }

  get size(): number {
    return this.buckets.size;
  }
}
