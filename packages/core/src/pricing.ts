import type { ReasonCode } from "./reasons.js";
import type { ProfileEvidence } from "./release.js";

/**
 * The MVP sale rule from docs/economics.md: a resolution may be offered only
 * when its price is at most 30 percent of the measured expected raw
 * model-cost saving. Integer math on atomic units; no floating point.
 */
export const SALE_RULE = { numerator: 3n, denominator: 10n } as const;

/** The paired benchmark's success target: at least 25 percent lower median all-in cost. */
export const BENCHMARK_TARGET_BPS = 2500n;

/** `null` saving means no frozen benchmark supports the profile: preview only, never sold. */
export function isSellable(priceAtomic: bigint, expectedRawSavingAtomic: bigint | null): boolean {
  if (expectedRawSavingAtomic === null) return false;
  if (priceAtomic <= 0n || expectedRawSavingAtomic <= 0n) return false;
  return priceAtomic * SALE_RULE.denominator <= expectedRawSavingAtomic * SALE_RULE.numerator;
}

/**
 * Why a matched profile cannot be sold at `priceAtomic` right now, or null when
 * it can. Evidence must exist, be fresh, and support the price under the sale rule.
 */
export function saleBlocker(priceAtomic: bigint, evidence: ProfileEvidence | null, now: Date): ReasonCode | null {
  if (evidence === null) return "PROFILE_NOT_BENCHMARKED";
  if (now.getTime() >= Date.parse(evidence.staleAfter)) return "EVIDENCE_STALE";
  if (!isSellable(priceAtomic, BigInt(evidence.expectedRawSavingUsdc))) return "PRICE_EXCEEDS_SAVING_RULE";
  return null;
}

/**
 * The buyer's expected all-in cost reduction in basis points of the control
 * cost `C`: `(S - price - chainCost) / C`, where `S` is the evidence's raw saving.
 * The sale rule alone does not guarantee the benchmark target: at the 30% price
 * cap, the target of 2500 bps holds only when `S >= 0.357 C` (docs/economic-gates.md).
 */
export function allInReductionBps(evidence: ProfileEvidence, priceAtomic: bigint, chainCostAtomic = 0n): bigint {
  const control = BigInt(evidence.controlMedianCostUsdc);
  if (control === 0n) return 0n;
  return ((BigInt(evidence.expectedRawSavingUsdc) - priceAtomic - chainCostAtomic) * 10_000n) / control;
}
