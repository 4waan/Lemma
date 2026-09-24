import { z } from "zod";

import { UsdcAtomic, atomicOrNull } from "./amounts.js";
import { PaymentTerms } from "./payment.js";
import { isSellable } from "./pricing.js";
import { Hex32, IsoTimestamp, SchemaVersion } from "./primitives.js";
import { Reasons } from "./reasons.js";
import { MatchedRelease } from "./release.js";

/** Longest time a quote may stay open after its preview is created. */
export const MAX_OFFER_TTL_SECONDS = 3600;

/**
 * A purchasable quote. `terms` are the exact x402 payment terms the server will
 * ask for, and `terms.amount` is the price. The sale rule is part of the schema,
 * so an offer that breaks it cannot parse.
 */
export const Offer = z
  .strictObject({
    terms: PaymentTerms,
    expectedRawSavingUsdc: UsdcAtomic,
    expectedTokenSaving: z.int().min(0),
    claimWindowHours: z.int().min(1).max(720),
    validUntil: IsoTimestamp,
  })
  .refine(
    (o) => {
      const price = atomicOrNull(o.terms?.amount);
      const saving = atomicOrNull(o.expectedRawSavingUsdc);
      return price !== null && saving !== null && isSellable(price, saving);
    },
    { message: "price exceeds 30 percent of the expected raw saving" },
  );

export type Offer = z.infer<typeof Offer>;

const base = {
  schemaVersion: SchemaVersion,
  previewId: Hex32,
  taskDigest: Hex32,
  profileDigest: Hex32,
  /** Digest of the catalog snapshot the resolver matched against, so the decision can be reproduced. */
  catalogDigest: Hex32,
  createdAt: IsoTimestamp,
};

function offerWindowOk(createdAt: string, validUntil: string): boolean {
  const created = Date.parse(createdAt);
  const until = Date.parse(validUntil);
  return until > created && until - created <= MAX_OFFER_TTL_SECONDS * 1000;
}

/**
 * A matched release. `offer` is null when the match cannot be sold (the matched
 * profile has no or stale evidence, or the sale rule fails), and then `reasons`
 * says why.
 */
function matched<D extends "reuse" | "adapt">(decision: D) {
  return z
    .strictObject({
      ...base,
      decision: z.literal(decision),
      release: MatchedRelease,
      offer: Offer.nullable(),
      reasons: Reasons,
    })
    .superRefine((p, ctx) => {
      if ((p.offer === null) !== (p.reasons.length > 0)) {
        ctx.addIssue({ code: "custom", path: ["reasons"], message: "an unsellable match must give reasons, and a sellable one must not" });
      }
      if (p.offer !== null && !offerWindowOk(p.createdAt, p.offer.validUntil)) {
        ctx.addIssue({ code: "custom", path: ["offer", "validUntil"], message: `validUntil must be after createdAt and within ${MAX_OFFER_TTL_SECONDS}s` });
      }
    });
}

/**
 * No release fits. `build` means the agent should do the work itself; `decline`
 * means Lemma will not resolve this task for this profile. Neither branch has
 * a release or an offer field, so a no-match can never carry a price.
 */
function unmatched<D extends "build" | "decline">(decision: D) {
  return z.strictObject({
    ...base,
    decision: z.literal(decision),
    reasons: Reasons.refine((r) => r.length > 0, "a no-match must give reasons"),
  });
}

/** The free answer to `lemma_preview`. */
export const Preview = z.discriminatedUnion("decision", [
  matched("reuse"),
  matched("adapt"),
  unmatched("build"),
  unmatched("decline"),
]);

export type Preview = z.infer<typeof Preview>;
