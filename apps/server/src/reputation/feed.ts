import { AcceptanceResult, Address, AdoptionVerdict, AgentId, CapabilityId, ExactVersion, Hex32, IsoTimestamp, MatchedRelease, ReleaseId } from "@lemma/core";
import { z } from "zod";

/**
 * One finalized outcome, as the outcome pipeline hands it to the attester:
 * what the evidence file needs, plus the buyer agent that opted in (from the
 * receipt), if any. It carries no buyer or payer address, preview id, nonce or
 * settlement reference, so the evidence built from it cannot either. Only
 * PASSED and FAILED outcomes are fed: void or abandoned ones are never posted.
 */
export const FinalizedOutcome = z.object({
  resolutionId: Hex32,
  releaseDigest: Hex32,
  releaseId: ReleaseId,
  version: ExactVersion,
  profileIndex: MatchedRelease.shape.profileIndex,
  capability: CapabilityId,
  verdict: AdoptionVerdict,
  /** core `acceptanceRecipeDigest` of the release's recipe. */
  acceptanceRecipeDigest: Hex32,
  acceptance: AcceptanceResult,
  /** The warranty registry that finalized the outcome. */
  registry: z.strictObject({ chainId: z.int().min(1).max(2 ** 53 - 1), address: Address }),
  /** The buyer's ERC-8004 agent, when its bridge opted in; stored with the receipt. */
  buyerAgentId: AgentId.nullable(),
  finalizedAt: IsoTimestamp,
});

export type FinalizedOutcome = z.infer<typeof FinalizedOutcome>;

export interface OutcomePage {
  readonly outcomes: readonly unknown[];
  /** Where to continue next time; the same cursor when nothing is new. */
  readonly cursor: string | null;
}

/**
 * Finalized outcomes, implemented by the outcome pipeline (evaluator and
 * warranty registry). The attester pages through it from its last cursor, or
 * from the start (null) after a restart: queueing is idempotent, so reading an
 * outcome twice posts nothing twice. Entries are validated by the attester, so
 * a malformed one is skipped rather than posted.
 */
export interface OutcomeFeed {
  read(cursor: string | null, limit: number): Promise<OutcomePage>;
}

/**
 * How many distinct buyers are behind the outcomes fed to the attester for a
 * capability, as a raw count (the catalog publishes it from three up, next to
 * the capability's reputation). Answers from memory: the catalog reads it on
 * every request. The outcome pipeline implements it; only the server, which
 * holds each resolution's payer, can count.
 */
export interface FedBuyers {
  buyersFor(capability: CapabilityId): number;
}

/** No outcomes: the feed until the outcome pipeline supplies one. */
export const noOutcomes: OutcomeFeed = {
  async read(cursor) {
    return { outcomes: [], cursor };
  },
};

/** An in-memory feed for tests and local runs: outcomes in the order added, the cursor is an index. */
export class MemoryOutcomeFeed implements OutcomeFeed {
  private readonly outcomes: unknown[] = [];

  add(...outcomes: unknown[]): void {
    this.outcomes.push(...outcomes);
  }

  async read(cursor: string | null, limit: number): Promise<OutcomePage> {
    const start = cursor === null ? 0 : Number(cursor);
    const page = this.outcomes.slice(start, start + limit);
    return { outcomes: page, cursor: String(start + page.length) };
  }
}
