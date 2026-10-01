import { NO_PRIOR, type Outcome, type Stats, confidence, fold, priorFromEvidence, unixSeconds } from "@lemma/confidence";
import { type CapabilityRelease, type Hex32, ProfileCompatibility, type ProfileEvidence, publishedBuyers } from "@lemma/core";

import { describeError } from "./errors.js";
import { type Logger, silentLogger } from "./log.js";

/**
 * Finalized adoption outcomes per (release digest, profile index), the key the
 * warranty registry records into the Stylus engine under. The catalog's confidence
 * equals the contract's `confidence(releaseDigest, profileIndex)` only when the list
 * holds exactly the outcomes the contract recorded for that key (one per
 * `OutcomeRecorded` event: the registry records only PASSED and FAILED outcomes with
 * a weight above zero, so never a VOID verdict, never a zero-weight outcome and never
 * an outcome whose engine call failed), each with `at` set to the timestamp of the
 * block that recorded it, the contract's prior was set from the same evidence, and
 * both score at the same time. Decay floors after every record, so an `at` a few
 * seconds off, or a record missing or extra (even one of weight zero, which still
 * decays the sums), changes the sums and can change the score.
 *
 * The catalog route reads it for every profile on every request, so it must answer
 * from memory: an implementation keeps its own snapshot, refreshed in the
 * background, and never waits on a database or a chain here. Return a frozen array
 * of frozen outcomes (`Object.freeze` on both), the same one while nothing changed
 * and a new one when an outcome arrives: the route folds it once and reuses the
 * sums. Any other array is folded again on every read. An outcome the engine cannot
 * represent, or a call that throws, costs only that profile its confidence (null,
 * logged as `catalog.compatibility_failed`), never the catalog.
 *
 * `buyersFor`, when a source implements it, answers from memory too: how many
 * distinct buyers are behind `outcomesFor(releaseDigest, profileIndex)`, as a raw
 * count (the read model publishes it from three up). A source without it leaves
 * every count null.
 */
export interface OutcomeSource {
  outcomesFor(releaseDigest: Hex32, profileIndex: number): readonly Outcome[];
  buyersFor?(releaseDigest: Hex32, profileIndex: number): number;
}

const NONE: readonly Outcome[] = Object.freeze([]);

/** No outcomes yet: every profile with evidence shows its benchmark prior alone. */
export const NO_OUTCOMES: OutcomeSource = { outcomesFor: () => NONE };

/**
 * Computes `ProfileSummary.compatibility` for the catalog. Folding outcomes into
 * decayed sums does not depend on the time it is read, so a frozen outcome array,
 * which cannot change, is folded once and remembered by identity; each request then
 * only scores the sums at its own clock.
 */
export class CompatibilityReader {
  private readonly folded = new WeakMap<readonly Outcome[], Stats>();

  constructor(
    private readonly source: OutcomeSource,
    private readonly logger: Logger = silentLogger,
  ) {}

  /**
   * Profile index to confidence for one release, leaving out profiles with neither
   * evidence nor outcomes, and profiles whose outcomes could not be read (logged).
   */
  forRelease(release: CapabilityRelease, releaseDigest: Hex32, now: Date): Map<number, ProfileCompatibility> {
    const map = new Map<number, ProfileCompatibility>();
    release.supportedProfiles.forEach((profile, profileIndex) => {
      try {
        const value = this.forProfile(profile.evidence, this.source.outcomesFor(releaseDigest, profileIndex), now, this.source.buyersFor?.(releaseDigest, profileIndex) ?? 0);
        if (value !== null) map.set(profileIndex, value);
      } catch (error) {
        this.logger.log("error", "catalog.compatibility_failed", { releaseDigest, profileIndex, error: describeError(error) });
      }
    });
    return map;
  }

  /**
   * One profile's confidence, with `buyers` distinct buyers behind its outcomes (a
   * raw count, published from three up). Parsed here, so a count the outcomes
   * cannot have costs this profile its confidence and never the whole catalog.
   */
  forProfile(evidence: ProfileEvidence | null, outcomes: readonly Outcome[], now: Date, buyers = 0): ProfileCompatibility | null {
    if (evidence === null && outcomes.length === 0) return null;
    const score = confidence(evidence === null ? NO_PRIOR : priorFromEvidence(evidence), this.stats(outcomes), unixSeconds(now));
    return ProfileCompatibility.parse({
      confidenceBps: score.confidenceBps,
      effectiveNMilli: score.effectiveNMilli.toString(),
      outcomes: outcomes.length,
      source: evidence === null ? "outcomes" : outcomes.length === 0 ? "benchmark" : "benchmark+outcomes",
      buyers: publishedBuyers(buyers),
    });
  }

  /** The folded sums, remembered only for an array that can never change: frozen, of frozen outcomes. */
  private stats(outcomes: readonly Outcome[]): Stats {
    const remembered = this.folded.get(outcomes);
    if (remembered !== undefined) return remembered;
    const { stats } = fold(NO_PRIOR, outcomes, 0n);
    if (Object.isFrozen(outcomes) && outcomes.every((outcome) => Object.isFrozen(outcome))) this.folded.set(outcomes, stats);
    return stats;
  }
}
