import { z } from "zod";

import { UsdcAtomic } from "./amounts.js";
import { Address, Caip2 } from "./primitives.js";

/** Upper bound on how long a signed payment authorization may stay valid. */
export const MAX_AUTHORIZATION_SECONDS = 600;

/**
 * What a buyer pays for one resolution, field for field the x402 v2
 * `PaymentRequirements` shape (`{ scheme, network, asset, amount, payTo,
 * maxTimeoutSeconds }`), with core's stricter formats: CAIP-2 network, lowercase
 * addresses, atomic amount. The server builds `accepts` from these terms, and the
 * bridge checks a payment challenge against them with `checkPurchase`, so both
 * sides share one definition of what was sold. Core does not import x402.
 */
export const PaymentTerms = z.strictObject({
  scheme: z.literal("exact"),
  network: Caip2,
  asset: Address,
  amount: UsdcAtomic,
  payTo: Address,
  maxTimeoutSeconds: z.int().min(1).max(MAX_AUTHORIZATION_SECONDS),
});

export type PaymentTerms = z.infer<typeof PaymentTerms>;
