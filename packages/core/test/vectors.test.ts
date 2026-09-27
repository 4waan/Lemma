import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { hashTypedData } from "viem";

import {
  type DigestKind,
  acceptanceRecipeDigest,
  adoptionFeedbackFileBytes,
  adoptionReceiptDigest,
  adoptionReceiptTypedData,
  baseReleaseDigest,
  canonicalize,
  catalogDigest,
  derivePaymentNonce,
  deriveResolutionId,
  digest,
  feedbackHashOf,
  warrantyClaimHash,
  warrantyOutcomeTypedData,
  warrantyVoucherTypedData,
} from "../src/index.js";
import * as ex from "./examples.js";

/**
 * Frozen canonical-form and digest vectors. Other components (the contract
 * tests, the payment path, any non-TypeScript client) check their encoders
 * against this file. Regenerate only for a deliberate schema change:
 *   LEMMA_WRITE_VECTORS=1 npx vitest run packages/core/test/vectors.test.ts
 */
const FILE = fileURLToPath(new URL("./vectors/digests.json", import.meta.url));

const inputs: ReadonlyArray<{ name: string; kind: DigestKind; value: unknown }> = [
  { name: "repository-profile", kind: "repository-profile", value: ex.profile },
  { name: "task-request", kind: "task-request", value: ex.task },
  { name: "capability-release", kind: "capability-release", value: ex.release },
  { name: "preview-offer", kind: "preview", value: ex.offerPreview },
  { name: "preview-decline", kind: "preview", value: ex.declinePreview },
  { name: "resolution", kind: "resolution", value: ex.resolution },
  { name: "resolution-id", kind: "resolution-id", value: { previewId: ex.resolution.previewId, buyer: ex.resolution.buyer } },
  { name: "adoption-receipt", kind: "adoption-receipt", value: ex.receipt },
  { name: "patch-bundle", kind: "patch-bundle", value: ex.bundle },
  { name: "run-record", kind: "run-record", value: ex.runRecord },
  { name: "payment-nonce", kind: "payment-nonce", value: { resolutionId: ex.resolution.resolutionId, previewId: ex.resolution.previewId } },
  { name: "acceptance-recipe", kind: "acceptance-recipe", value: ex.release.acceptanceRecipe },
];

const computed = inputs.map(({ name, kind, value }) => ({
  name,
  kind,
  value,
  canonical: canonicalize({ kind, value }),
  digest: digest(kind, value),
}));

const derived = {
  resolutionId: deriveResolutionId(ex.resolution.previewId, ex.resolution.buyer),
  adoptionReceiptDigest: adoptionReceiptDigest(ex.receipt),
  catalogDigest: catalogDigest([ex.release]),
  baseReleaseDigest: baseReleaseDigest(ex.release),
  paymentNonce: derivePaymentNonce(ex.resolution.resolutionId, ex.resolution.previewId),
  /** keccak256(abi.encode(bytes32 resolutionId, bytes32 claimSecret, address refundTo)), checked by the warranty registry. */
  warrantyClaimHash: warrantyClaimHash(ex.resolution.resolutionId, ex.hex32("77"), ex.BUYER),
  /** The EIP-712 hash the buyer signs for the example receipt on Arbitrum Sepolia. */
  adoptionReceiptTypedDataHash: hashTypedData(adoptionReceiptTypedData(ex.receipt, 421614)),
  acceptanceRecipeDigest: acceptanceRecipeDigest(ex.release.acceptanceRecipe),
  // ERC-8004 feedbackHash: keccak256 of a feedback file's bytes as served (JCS of the file itself, no kind envelope).
  adoptionFeedbackFileBytes: adoptionFeedbackFileBytes(ex.adoptionFeedbackFile),
  adoptionFeedbackHash: feedbackHashOf(adoptionFeedbackFileBytes(ex.adoptionFeedbackFile)),
  /** The EIP-712 hash a provider signs for the warranty registry's vector voucher; the registry's `hashVoucher` gives the same. */
  warrantyVoucherTypedDataHash: hashTypedData(warrantyVoucherTypedData(ex.warrantyVectorVoucher, ex.WARRANTY_VECTOR_REGISTRY)),
  /** The EIP-712 hash an evaluator signs for the registry's vector outcome; the registry's `hashOutcome` gives the same. */
  warrantyOutcomeTypedDataHash: hashTypedData(warrantyOutcomeTypedData(ex.warrantyVectorOutcome, ex.WARRANTY_VECTOR_REGISTRY)),
};

if (process.env.LEMMA_WRITE_VECTORS === "1") {
  writeFileSync(FILE, `${JSON.stringify({ algorithm: "keccak256(utf8(JCS({kind, value})))", vectors: computed, derived }, null, 2)}\n`);
}

describe("digest vectors", () => {
  const frozen = JSON.parse(readFileSync(FILE, "utf8")) as { vectors: typeof computed; derived: typeof derived };

  it("covers every example", () => {
    expect(frozen.vectors.map((v) => v.name)).toEqual(computed.map((v) => v.name));
  });

  for (const vector of computed) {
    it(`${vector.name} matches the frozen vector`, () => {
      const expected = frozen.vectors.find((v) => v.name === vector.name);
      expect(expected?.value).toEqual(vector.value);
      expect(expected?.canonical).toBe(vector.canonical);
      expect(expected?.digest).toBe(vector.digest);
    });
  }

  it("pins the derived identifiers the payment and contract work sign or store", () => {
    expect(frozen.derived).toEqual(derived);
    expect(derived.resolutionId).toBe(computed.find((v) => v.name === "resolution-id")?.digest);
    expect(derived.paymentNonce).toBe(computed.find((v) => v.name === "payment-nonce")?.digest);
    expect(derived.acceptanceRecipeDigest).toBe(computed.find((v) => v.name === "acceptance-recipe")?.digest);
    // The warranty registry's own vectors (contracts/test/Vectors.t.sol).
    expect(derived.warrantyVoucherTypedDataHash).toBe("0x2770a4591ffeb5922cf0d77e5f159ea23e24297c9164f970a1cf74d85a1a2473");
    expect(derived.warrantyOutcomeTypedDataHash).toBe("0xc4f2af8ca4c3b7a3a512cf4621f3ebf6de602412ed19545450663cf604c8b590");
  });
});
