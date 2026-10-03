import { MIN_PUBLISHED_BUYERS, type ProfileCompatibility, type ProfileSummary } from "@lemma/core";

import { percent, thousandths } from "../format.js";

/** The one-line explanation shown wherever a score (compatibility confidence) appears. */
export const COMPATIBILITY_EXPLAINED =
  "The score is a cautious estimate (the 90% lower bound) of how often a release's tests pass on a project like yours. It starts from the benchmark and moves with each final test result. A result counts half as much every 30 days.";

/** What the distinct-buyer counts next to outcome counts and pass rates mean. */
export const BUYERS_EXPLAINED = `Buyer counts show from ${MIN_PUBLISHED_BUYERS} buyers up, so a record one or two buyers made reads as such.`;

const outcomesText = (n: number) => `${n} result${n === 1 ? "" : "s"}`;

/**
 * Distinct buyers as a read model publishes them (core `DistinctBuyers`): the
 * count from three up, and "fewer than 3 buyers" below that, when it is null.
 */
export function buyersText(buyers: number | null): string {
  return buyers === null ? `fewer than ${MIN_PUBLISHED_BUYERS} buyers` : `${buyers} buyers`;
}

/**
 * What a score rests on, in words, with the distinct buyers behind its
 * results. A starting point taken from provisional evidence is an early
 * estimate from a short probe, not the frozen benchmark, and says so.
 */
export function compatibilityBasis(c: ProfileCompatibility, label: ProfileSummary["label"]): string {
  const prior = label === "provisional" ? "early estimate" : "benchmark";
  switch (c.source) {
    case "benchmark":
      return `from the ${prior}`;
    case "benchmark+outcomes":
      return `${prior} and ${outcomesText(c.outcomes)} from ${buyersText(c.buyers)}`;
    case "outcomes":
      return `${outcomesText(c.outcomes)} from ${buyersText(c.buyers)}`;
  }
}

/** A profile's score as a percentage with its basis and sample size underneath, or a dash. */
export function ConfidenceCell({ profile }: { profile: ProfileSummary }) {
  const c = profile.compatibility;
  if (c === null) return <span className="muted">–</span>;
  return (
    <>
      {percent(BigInt(c.confidenceBps))}
      <div className="platform-deps">
        {compatibilityBasis(c, profile.label)}; sample size {thousandths(c.effectiveNMilli)}
      </div>
    </>
  );
}
