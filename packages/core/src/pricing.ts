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
 *
 * Rounds toward negative infinity, so the reported reduction never exceeds the
 * real one: a cost increase of a fraction of a basis point reads as -1, not 0.
 * With a zero control cost no ratio exists and it returns 0; `maxPriceFor` is
 * then 0 as well, so such a profile is never sold.
 */
export function allInReductionBps(evidence: SavingEvidence, priceAtomic: bigint, chainCostAtomic = 0n): bigint {
  const control = BigInt(evidence.controlMedianCostUsdc);
  if (control === 0n) return 0n;
  return floorDiv((BigInt(evidence.expectedRawSavingUsdc) - priceAtomic - chainCostAtomic) * 10_000n, control);
}

/** Integer division rounding toward negative infinity, for a positive divisor. */
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const q = numerator / denominator;
  return numerator < 0n && q * denominator !== numerator ? q - 1n : q;
}

/** The two evidence fields a price bound depends on, so rough probe numbers can be priced too. */
export type SavingEvidence = Pick<ProfileEvidence, "expectedRawSavingUsdc" | "controlMedianCostUsdc">;

/**
 * The highest price at which a profile is both sellable and still meets the
 * all-in target for the buyer once chain cost `g` is paid:
 * `min(floor(3S / 10), S - g - ceil(targetBps * C / 10^4))`, floored at 0.
 * `0` means preview-only, because `isSellable` refuses a zero price.
 *
 * Any price in `(0, maxPriceFor]` keeps `allInReductionBps(e, price, g)` at or
 * above `targetBps`. The stage-4 probe and `catalog:check` use it
 * (docs/economic-gates.md). `chainCostAtomic` has no default on purpose: gas
 * is part of the buyer's cost and must be stated.
 */
export function maxPriceFor(
  evidence: SavingEvidence,
  options: { chainCostAtomic: bigint; targetBps?: bigint },
): bigint {
  const saving = BigInt(evidence.expectedRawSavingUsdc);
  const control = BigInt(evidence.controlMedianCostUsdc);
  const gas = options.chainCostAtomic;
  const target = options.targetBps ?? BENCHMARK_TARGET_BPS;
  if (gas < 0n) throw new RangeError("chainCostAtomic must not be negative");
  if (target < 0n || target > 10_000n) throw new RangeError("targetBps must be within [0, 10000]");
  if (saving <= 0n || control <= 0n) return 0n;
  const saleCap = (saving * SALE_RULE.numerator) / SALE_RULE.denominator;
  const targetCap = saving - gas - ceilDiv(target * control, 10_000n);
  const cap = saleCap < targetCap ? saleCap : targetCap;
  return cap > 0n ? cap : 0n;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
