import { z } from "zod";

import { digest } from "./canonical.js";
import { PaymentTerms } from "./payment.js";
import { Address, Hex32, IsoTimestamp, SchemaVersion, SignatureBytes } from "./primitives.js";
import { MatchedRelease } from "./release.js";

/**
 * The resolution id for one buyer and one preview. It is deterministic, so a
 * retry after a lost paid response names the same resolution instead of buying
 * again. The payment work can also use it as the EIP-3009 authorization nonce,
 * which lets USDC itself refuse a second payment for the same resolution.
 */
export function deriveResolutionId(previewId: Hex32, buyer: Address): Hex32 {
  return digest("resolution-id", { previewId: Hex32.parse(previewId), buyer: Address.parse(buyer) });
}

/**
 * The paid object. `terms` are the payment terms that were settled. The
 * settlement record and the provider's warranty voucher belong to the payment and
 * contract work and reference `resolutionId`.
 */
export const Resolution = z
  .strictObject({
    schemaVersion: SchemaVersion,
    resolutionId: Hex32,
    previewId: Hex32,
    release: MatchedRelease,
    profileDigest: Hex32,
    payloadDigest: Hex32,
    buyer: Address,
    terms: PaymentTerms,
    createdAt: IsoTimestamp,
  })
  .refine((r) => !Hex32.safeParse(r.previewId).success || !Address.safeParse(r.buyer).success || r.resolutionId === deriveResolutionId(r.previewId, r.buyer), {
    path: ["resolutionId"],
    message: "resolutionId must equal deriveResolutionId(previewId, buyer)",
  });

export type Resolution = z.infer<typeof Resolution>;

export const AdoptionOutcome = z.enum(["passed", "failed", "abandoned"]);

/**
 * What happened when the buyer ran the acceptance recipe. `exitCode` is null
 * when the run did not finish (timeout or abandonment).
 */
export const AcceptanceResult = z.strictObject({
  exitCode: z.int().min(0).max(255).nullable(),
  durationMs: z.int().min(0).max(24 * 3600 * 1000),
  outputDigest: Hex32.nullable(),
});

/**
 * The buyer's signed outcome for one resolution. `signature` stays null until
 * the buyer signs `adoptionReceiptDigest(receipt)` with the typed-data layout
 * defined by the contract work. Smart-account signatures are accepted.
 */
export const AdoptionReceipt = z
  .strictObject({
    schemaVersion: SchemaVersion,
    resolutionId: Hex32,
    outcome: AdoptionOutcome,
    acceptance: AcceptanceResult,
    recordedAt: IsoTimestamp,
    signature: SignatureBytes.nullable(),
  })
  .superRefine((r, ctx) => {
    const code = r.acceptance.exitCode;
    const consistent =
      (r.outcome === "passed" && code === 0) ||
      (r.outcome === "failed" && code !== 0) ||
      (r.outcome === "abandoned" && code === null);
    if (!consistent) {
      ctx.addIssue({ code: "custom", path: ["acceptance", "exitCode"], message: `exit code ${code} contradicts outcome ${r.outcome}` });
    }
  });

export type AdoptionReceipt = z.infer<typeof AdoptionReceipt>;

/** The digest a buyer signs: the receipt with its signature field cleared. */
export function adoptionReceiptDigest(receipt: AdoptionReceipt): Hex32 {
  return digest("adoption-receipt", { ...AdoptionReceipt.parse(receipt), signature: null });
}
