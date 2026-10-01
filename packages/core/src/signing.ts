import { AdoptionReceipt, adoptionReceiptDigest } from "./receipt.js";

/**
 * EIP-712 typed data the buyer signs for an Adoption Receipt. Typed data only:
 * core holds no keys and signs nothing. The bridge's signer signs it, and the
 * server checks the signature against the resolution's buyer with viem
 * `verifyTypedData` on a public client, so EOA, ERC-1271 and ERC-6492
 * signatures all verify.
 *
 * The message commits to the whole receipt through `receiptDigest`
 * (`adoptionReceiptDigest`, the receipt with its signature cleared) and shows
 * the resolution id and outcome in the clear, so a wallet displays what it is
 * signing.
 */
export const LEMMA_RECEIPT_DOMAIN_NAME = "Lemma";
export const LEMMA_RECEIPT_DOMAIN_VERSION = "1";

export const ADOPTION_RECEIPT_TYPES = {
  AdoptionReceipt: [
    { name: "resolutionId", type: "bytes32" },
    { name: "outcome", type: "string" },
    { name: "receiptDigest", type: "bytes32" },
  ],
} as const;

/** viem-ready typed data: domain { name: "Lemma", version: "1", chainId }, message { resolutionId, outcome, receiptDigest }. */
export function adoptionReceiptTypedData(receipt: AdoptionReceipt, chainId: number) {
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new RangeError(`invalid chain id: ${String(chainId)}`);
  const parsed = AdoptionReceipt.parse(receipt);
  return {
    domain: { name: LEMMA_RECEIPT_DOMAIN_NAME, version: LEMMA_RECEIPT_DOMAIN_VERSION, chainId },
    types: ADOPTION_RECEIPT_TYPES,
    primaryType: "AdoptionReceipt" as const,
    message: {
      resolutionId: parsed.resolutionId as `0x${string}`,
      outcome: parsed.outcome,
      receiptDigest: adoptionReceiptDigest(parsed) as `0x${string}`,
    },
  };
}

export type AdoptionReceiptTypedData = ReturnType<typeof adoptionReceiptTypedData>;
