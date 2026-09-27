import { type Hex, encodeAbiParameters, getAddress, keccak256 } from "viem";
import { z } from "zod";

import { digest } from "./canonical.js";
import { PaymentTerms } from "./payment.js";
import { ARBITRUM_SEPOLIA, ARBITRUM_SEPOLIA_USDC, Address, Hex32, USDC_EIP712_DOMAIN } from "./primitives.js";

/**
 * The EIP-3009 nonce the bridge signs for a resolution: USDC then refuses a
 * second payment for it on chain, and nobody without the preview id can join
 * the nonce to the resolution id.
 *
 * `digest("payment-nonce", { resolutionId, previewId })`. The resolution id is
 * public and the nonce is published by USDC next to the payer, so the nonce
 * must not be the resolution id itself (see `deriveResolutionId`); mixing in
 * the preview id, which only the buyer's bridge and the server know, keeps the
 * two unlinkable while staying deterministic, so a retry signs the same nonce.
 */
export function derivePaymentNonce(resolutionId: Hex32, previewId: Hex32): Hex32 {
  return digest("payment-nonce", { resolutionId: Hex32.parse(resolutionId), previewId: Hex32.parse(previewId) });
}

/**
 * x402 v2 `PaymentRequirements` for the exact EVM scheme, as Lemma sends them.
 * Declared here rather than imported, because core does not depend on x402
 * (x402 pins zod 3; core uses zod 4). The fields are the x402 wire fields.
 */
export interface ExactPaymentRequirements {
  readonly scheme: "exact";
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly name: "USD Coin"; readonly version: "2" };
}

/**
 * x402 v2 PaymentRequirements for stored terms. Server `accepts` and the
 * bridge's `accepted` both come from here, so they are deep-equal by
 * construction: the bridge signs from the preview's terms without asking the
 * server for a challenge first.
 *
 * Address casing: x402 2.27.0 treats `asset` and `payTo` as opaque strings in
 * requirements, and matches a client's `accepted` against the server's
 * `accepts` with an exact, case-sensitive deep equality
 * (`paymentRequirementsMatchAccepted` in @x402/core), while everything that
 * signs or verifies normalizes with viem `getAddress`. So any casing works as
 * long as both sides use this function. We emit EIP-55 checksummed addresses:
 * x402's own requirement builder produces its default asset for eip155:421614
 * in that form (`DEFAULT_ASSETS`), and its clients write `authorization.to` as
 * `getAddress(payTo)`, so the wire form matches what stock x402 code produces.
 * Core's own schemas keep lowercase; compare against them with `toAddress`.
 *
 * `extra` is the token's EIP-712 domain, which the exact scheme needs to sign
 * and verify. Only Arbitrum Sepolia USDC has a known domain here, so any other
 * network or asset is refused rather than signed with a guessed domain.
 */
export function paymentRequirementsFor(terms: PaymentTerms): ExactPaymentRequirements {
  const t = PaymentTerms.parse(terms);
  if (t.network !== ARBITRUM_SEPOLIA || t.asset !== ARBITRUM_SEPOLIA_USDC) {
    throw new TypeError(`no known EIP-712 domain for asset ${t.asset} on ${t.network}; only Arbitrum Sepolia USDC is supported`);
  }
  return {
    scheme: t.scheme,
    network: t.network,
    asset: getAddress(t.asset),
    amount: t.amount,
    payTo: getAddress(t.payTo),
    maxTimeoutSeconds: t.maxTimeoutSeconds,
    extra: { name: USDC_EIP712_DOMAIN.name, version: USDC_EIP712_DOMAIN.version },
  };
}

/**
 * Input of the server's paid tool `lemma_buy_resolution`. The payer, nonce
 * and authorization window come from the verified x402 payment, never from
 * these arguments. `claimHash` is the buyer's warranty credit commitment
 * (`warrantyClaimHash`); the server stores it with the resolution and never
 * learns the secret or the refund address behind it.
 */
export const BuyInput = z.strictObject({ previewId: Hex32, claimHash: Hex32 });

export type BuyInput = z.infer<typeof BuyInput>;

const CLAIM_PARAMETERS = [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }] as const;

/**
 * Warranty credit commitment. Equals Solidity
 * `keccak256(abi.encode(bytes32 resolutionId, bytes32 claimSecret, address refundTo))`,
 * which the warranty registry checks before it pays a credit. The buyer keeps
 * the secret and the refund address; only this hash goes to the server and on
 * chain, so the registry never stores who bought what.
 */
export function warrantyClaimHash(resolutionId: Hex32, claimSecret: Hex32, refundTo: Address): Hex32 {
  const encoded = encodeAbiParameters(CLAIM_PARAMETERS, [Hex32.parse(resolutionId) as Hex, Hex32.parse(claimSecret) as Hex, getAddress(Address.parse(refundTo))]);
  return keccak256(encoded);
}

/**
 * The buyer's warranty claim for one resolution, kept by the bridge and never
 * sent: the random secret and the refund address whose `warrantyClaimHash`
 * went to the server with the purchase. Whoever holds the secret can only
 * have a credit paid to `refundTo`. The bridge persists it and the warranty
 * withdrawal reads it, so it is strict and versioned, and `claimHash` must be
 * the hash of the other fields.
 */
export const WarrantyClaim = z
  .strictObject({ schemaVersion: z.literal("1"), resolutionId: Hex32, claimSecret: Hex32, refundTo: Address, claimHash: Hex32 })
  .refine((c) => matchesClaimHash(c), { message: "claimHash must be warrantyClaimHash(resolutionId, claimSecret, refundTo)", path: ["claimHash"] });

export type WarrantyClaim = z.infer<typeof WarrantyClaim>;

function matchesClaimHash(c: { resolutionId: string; claimSecret: string; refundTo: string; claimHash: string }): boolean {
  try {
    return warrantyClaimHash(c.resolutionId as Hex32, c.claimSecret as Hex32, c.refundTo as Address) === c.claimHash;
  } catch {
    return false;
  }
}
