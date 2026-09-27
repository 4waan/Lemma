import { ADOPTION_FEEDBACK_TAG, type AgentId, type CapabilityId, type ReleaseReputation } from "@lemma/core";

import { describeError } from "../errors.js";
import type { Logger } from "../log.js";
import type { ChainSummary, ReputationChain } from "./chain.js";

/** What request handlers read: the cached record, never waiting on the chain. */
export interface ReputationReader {
  current(capability: CapabilityId): ReleaseReputation | null;
}

/** Summaries stay fresh this long. */
export const SUMMARY_TTL_MS = 5 * 60_000;
/**
 * How often the background job looks for records that are due. Much shorter
 * than the TTL: a check that finds a record a moment short of it (a read ends a
 * little after its timer fired) leaves it to the next check, not the next TTL.
 */
export const SUMMARY_CHECK_MS = 60_000;
/** After a failed read, the next try waits this long (the last value is served meanwhile). */
export const SUMMARY_RETRY_MS = 60_000;

/**
 * ERC-8004 `getSummary` values as a pass rate. Lemma posts 100 (passed) or 0
 * (failed) with 0 decimals, so the average is a percentage; the registry
 * reports it in the most common decimals of what it averaged, so any decimals
 * are handled. Null when nothing was counted.
 */
export function toReputation(summary: ChainSummary): ReleaseReputation | null {
  if (summary.count <= 0n) return null;
  const d = summary.decimals;
  const bps = d <= 2 ? summary.value * 10n ** BigInt(2 - d) : summary.value / 10n ** BigInt(d - 2);
  const passBps = bps < 0n ? 0 : bps > 10_000n ? 10_000 : Number(bps);
  const count = summary.count > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(summary.count);
  return { passBps, count };
}

interface Entry {
  value: ReleaseReputation | null;
  /** When the value was read; undefined until the first success. */
  readAt: number | undefined;
  /** No new read before this instant (after a failure). */
  retryAt: number;
  inflight: Promise<ReleaseReputation | null> | undefined;
}

/**
 * The provider agent's public adoption record per capability:
 * `getSummary(agentId, [attester], "lemma.adoption", capability)`, cached for
 * five minutes per capability. Request handlers call `current`, which never
 * waits: a stale or missing entry is refreshed in the background. A failed read
 * keeps serving the last value (or null) and is retried after a minute.
 */
export class ReputationSummaries implements ReputationReader {
  private readonly entries = new Map<CapabilityId, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly retryMs: number;

  constructor(
    private readonly chain: Pick<ReputationChain, "summary">,
    private readonly agentId: AgentId,
    private readonly logger: Logger,
    options: { readonly now?: () => number; readonly ttlMs?: number; readonly retryMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SUMMARY_TTL_MS;
    this.retryMs = options.retryMs ?? SUMMARY_RETRY_MS;
  }

  current(capability: CapabilityId): ReleaseReputation | null {
    const entry = this.entries.get(capability);
    if (this.due(entry)) void this.refresh(capability);
    return entry?.value ?? null;
  }

  /** Reads the chain now (one read per capability at a time); on failure, the last value or null. Never throws. */
  refresh(capability: CapabilityId): Promise<ReleaseReputation | null> {
    const entry = this.entries.get(capability) ?? { value: null, readAt: undefined, retryAt: 0, inflight: undefined };
    this.entries.set(capability, entry);
    entry.inflight ??= this.read(capability, entry).finally(() => {
      entry.inflight = undefined;
    });
    return entry.inflight;
  }

  /** Refreshes every capability whose entry is due, in the background job. */
  async refreshAll(capabilities: readonly CapabilityId[]): Promise<void> {
    await Promise.all(capabilities.filter((c) => this.due(this.entries.get(c))).map((c) => this.refresh(c)));
  }

  private due(entry: Entry | undefined): boolean {
    if (entry === undefined) return true;
    if (entry.inflight !== undefined) return false;
    const now = this.now();
    return now >= entry.retryAt && (entry.readAt === undefined || now - entry.readAt >= this.ttlMs);
  }

  private async read(capability: CapabilityId, entry: Entry): Promise<ReleaseReputation | null> {
    try {
      const summary = await this.chain.summary({ agentId: BigInt(this.agentId), tag1: ADOPTION_FEEDBACK_TAG, tag2: capability });
      entry.value = toReputation(summary);
      entry.readAt = this.now();
      entry.retryAt = 0;
    } catch (error) {
      entry.retryAt = this.now() + this.retryMs;
      this.logger.log("warn", "reputation.summary_failed", { capability, error: describeError(error) });
    }
    return entry.value;
  }
}
