import type { ProfileCompatibility, ProfileSummary } from "@lemma/core";

import { percent, thousandths } from "../format.js";

/** The one-line explanation shown wherever a compatibility confidence appears. */
export const COMPATIBILITY_EXPLAINED =
  "Compatibility confidence is the 90% lower bound on how often a release's acceptance tests pass on a profile, with the benchmark's treatment runs as the prior and finalized adoption outcomes added on top, each losing half its weight every 30 days.";

const outcomesText = (n: number) => `${n} outcome${n === 1 ? "" : "s"}`;

/**
 * What a confidence rests on, in words. A prior taken from provisional evidence
 * comes from a testnet-only probe, not the frozen benchmark, and says so.
 */
export function compatibilityBasis(c: ProfileCompatibility, label: ProfileSummary["label"]): string {
  const prior = label === "provisional" ? "provisional probe prior" : "benchmark prior";
  switch (c.source) {
    case "benchmark":
      return `${prior}, no outcomes yet`;
    case "benchmark+outcomes":
      return `${prior} and ${outcomesText(c.outcomes)}`;
    case "outcomes":
      return `${outcomesText(c.outcomes)}, no benchmark`;
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
