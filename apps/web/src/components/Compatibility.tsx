import { MIN_PUBLISHED_BUYERS, type ProfileCompatibility, type ProfileSummary } from "@lemma/core";

import { percent, thousandths } from "../format.js";

/** The one-line explanation shown wherever a compatibility confidence appears. */
export const COMPATIBILITY_EXPLAINED =
  "Compatibility confidence is the 90% lower bound on how often a release's acceptance tests pass on a profile, with the benchmark's treatment runs as the prior and finalized adoption outcomes added on top, each losing half its weight every 30 days.";

/** What the distinct-buyer counts next to outcome counts and pass rates mean. */
export const BUYERS_EXPLAINED = `Outcome counts and pass rates come with the number of distinct buyers behind them, shown only from ${MIN_PUBLISHED_BUYERS} up, so a record that one or two buyers made reads as such.`;

const outcomesText = (n: number) => `${n} outcome${n === 1 ? "" : "s"}`;

/**
 * Distinct buyers as a read model publishes them (core `DistinctBuyers`): the
 * count from three up, and "fewer than 3 buyers" below that, when it is null.
 */
export function buyersText(buyers: number | null): string {
  return buyers === null ? `fewer than ${MIN_PUBLISHED_BUYERS} buyers` : `${buyers} buyers`;
}

/**
 * What a confidence rests on, in words, with the distinct buyers behind its
 * outcomes. A prior taken from provisional evidence comes from a testnet-only
 * probe, not the frozen benchmark, and says so.
 */
export function compatibilityBasis(c: ProfileCompatibility, label: ProfileSummary["label"]): string {
  const prior = label === "provisional" ? "provisional probe prior" : "benchmark prior";
  switch (c.source) {
    case "benchmark":
      return `${prior}, no outcomes yet`;
    case "benchmark+outcomes":
      return `${prior} and ${outcomesText(c.outcomes)} from ${buyersText(c.buyers)}`;
    case "outcomes":
      return `${outcomesText(c.outcomes)} from ${buyersText(c.buyers)}, no benchmark`;
  }
}

/** A profile's confidence as a percentage with its basis and effective sample size underneath, or a dash. */
export function ConfidenceCell({ profile }: { profile: ProfileSummary }) {
  const c = profile.compatibility;
  if (c === null) return <span className="muted">–</span>;
  return (
    <>
      {percent(BigInt(c.confidenceBps))}
      <div className="platform-deps">
        {compatibilityBasis(c, profile.label)}; effective n {thousandths(c.effectiveNMilli)}
      </div>
    </>
  );
}
