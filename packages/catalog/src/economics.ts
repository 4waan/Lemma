import { IsoTimestamp, SafeText, SchemaVersion, UsdcAtomic } from "@lemma/core";
import { z } from "zod";

/**
 * Dated economic inputs that bound every manifest price (docs/economic-gates.md).
 * `chainCostAtomic` is the per-resolution chain cost `g` that `maxPriceFor`
 * subtracts, counting every on-chain action whoever pays it. `priceFloorAtomic`
 * is the smallest price worth selling, which must cover fees and gas.
 * `ethUsdMicro` converts gas paid in ETH to micro-USD for benchmark records.
 *
 * `status: "placeholder"` means the protocol lane has not set these values yet
 * (HANDOFF item 4). While it is a placeholder, no release may carry evidence,
 * because no price can be checked against it.
 */
export const Economics = z.strictObject({
  schemaVersion: SchemaVersion,
  status: z.enum(["placeholder", "measured"]),
  chainCostAtomic: UsdcAtomic,
  priceFloorAtomic: UsdcAtomic,
  ethUsdMicro: UsdcAtomic,
  measuredAt: IsoTimestamp,
  source: SafeText(400),
});

export type Economics = z.infer<typeof Economics>;
