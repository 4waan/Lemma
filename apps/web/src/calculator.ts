import { BENCHMARK_TARGET_BPS, allInReductionBps, isSellable, maxPriceFor, parseUsdc } from "@lemma/core";

/**
 * The pricing rule as an interactive check. Every number comes from core's
 * pricing functions, so the page and the catalog check can never disagree.
 * Inputs are decimal USDC strings as typed; nothing here is floating point.
 */
export interface PricingInput {
  /** C: the control arm's median raw model cost to reach green. */
  readonly control: string;
  /** S: the conservative raw model-cost saving a frozen benchmark measured. */
  readonly saving: string;
  /** P: the resolution price. */
  readonly price: string;
  /** g: chain cost per resolution. */
  readonly gas: string;
}

export type PricingField = keyof PricingInput;

/** The worked example in docs/economic-gates.md: illustrative assumptions, not measurements. */
export const WORKED_EXAMPLE: PricingInput = { control: "2.50", saving: "1.30", price: "0.39", gas: "0.01" };

/** Why a price is or is not acceptable, in the order the checks apply. */
export type PricingVerdict = "ok" | "zero-price" | "breaks-sale-rule" | "misses-target";

export type PricingResult =
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<PricingField, string>>> }
  | {
      readonly ok: true;
      readonly control: bigint;
      readonly saving: bigint;
      readonly price: bigint;
      readonly gas: bigint;
      /** Model cost the buyer still pays with Lemma: C - S. */
      readonly residual: bigint;
      /** The buyer's all-in cost with Lemma: C - S + P + g. */
      readonly withLemma: bigint;
      /** `maxPriceFor`: the highest price that is sellable and keeps the 25% target; 0 means preview-only. */
      readonly maxPrice: bigint;
      /** `allInReductionBps` at this price. */
      readonly reductionBps: bigint;
      readonly verdict: PricingVerdict;
    };

const FIELDS: readonly PricingField[] = ["control", "saving", "price", "gas"];

export function evaluatePricing(input: PricingInput): PricingResult {
  const errors: Partial<Record<PricingField, string>> = {};
  const amounts: Partial<Record<PricingField, bigint>> = {};
  for (const field of FIELDS) {
    try {
      amounts[field] = parseUsdc(input[field].trim());
    } catch {
      errors[field] = "Enter an amount such as 1.25, with at most 6 decimals.";
    }
  }
  const { control, saving, price, gas } = amounts;
  if (control !== undefined && control === 0n) errors.control = "The control cost must be above zero.";
  if (control !== undefined && saving !== undefined && saving > control) errors.saving = "The saving cannot exceed the control cost.";
  if (control === undefined || saving === undefined || price === undefined || gas === undefined || Object.keys(errors).length > 0) return { ok: false, errors };

  const evidence = { controlMedianCostUsdc: control.toString(), expectedRawSavingUsdc: saving.toString() };
  const reductionBps = allInReductionBps(evidence, price, gas);
  const verdict: PricingVerdict = price === 0n ? "zero-price" : !isSellable(price, saving) ? "breaks-sale-rule" : reductionBps < BENCHMARK_TARGET_BPS ? "misses-target" : "ok";
  return {
    ok: true,
    control,
    saving,
    price,
    gas,
    residual: control - saving,
    withLemma: control - saving + price + gas,
    maxPrice: maxPriceFor(evidence, { chainCostAtomic: gas }),
    reductionBps,
    verdict,
  };
}

export const VERDICT_TEXT: Readonly<Record<PricingVerdict, string>> = {
  ok: "Sellable. The price is within 30% of the saving, and the buyer still spends at least 25% less after price and gas.",
  "zero-price": "Not sold. A zero price is never offered.",
  "breaks-sale-rule": "Not sellable. The price is above 30% of the measured saving.",
  "misses-target": "Refused by the catalog check. The 30% rule holds, but the buyer would save less than 25% after price and gas.",
};
