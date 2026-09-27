# Protocol

This document explains the objects that cross Lemma's component boundaries. `@lemma/core` is the executable source of truth for their schemas and deterministic helpers.

## Objects

### Capability Release

A release describes one reusable integration capability. It includes supported repository profiles, immutable provenance, a patch bundle digest, an acceptance recipe, per-profile evidence, commercial terms, and warranty terms.

Evidence belongs to a supported profile rather than the release as a whole. A release may match several profiles while remaining sellable for only the profiles with fresh evidence and valid economics.

### Preview

A preview is the free result of resolving a typed capability request and repository profile against one catalog snapshot. Its decision is one of:

- `reuse`: a release matches exactly.
- `adapt`: local files have drifted, so the bridge exports the purchased resolution for manual integration.
- `build`: Lemma has no suitable release or the mismatch remains within the buyer's platform.
- `decline`: the repository is outside the supported platform boundary.

A no-match preview cannot contain an offer. A matching preview can still be preview-only when evidence, price, expiry, or economics prevents sale.

### Compatibility Resolution

A resolution binds the selected release and bundle to the preview, buyer, and exact x402 payment terms. Its identifier is derived from the secret preview id and buyer address, which makes recovery idempotent without exposing the recovery secret in public views.

### Adoption Receipt

The bridge creates a receipt after the release's acceptance command starts. The first receipt for a settled resolution wins. It records `passed`, `failed`, or `abandoned`, along with bounded execution evidence rather than raw command output.

Receipts are compatibility observations. They can update pass-rate estimates and support a warranty outcome, but they do not replace the paired benchmark as evidence of savings.

## Canonical data and identifiers

All signed or paid objects use strict versioned schemas. Unknown fields fail validation.

Content identifiers use Keccak-256 over RFC 8785 canonical JSON with a registered domain kind. Canonicalization rejects values that serialize ambiguously, including unsafe numbers, non-finite numbers, sparse arrays, lone surrogates, and custom `toJSON` behavior.

USDC values are decimal strings in six-decimal atomic units. Floating-point currency never crosses a protocol boundary.

The frozen digest vectors in `packages/core/test/vectors/digests.json` are the compatibility contract for other encoders, including Solidity typed-data code.

## Matching and evidence

The server resolves typed capability ids rather than model prose. The bridge sends only allowlisted repository metadata and dependencies from the catalog's interest set.

Matches use a published deterministic order. Sellable releases rank before preview-only releases, followed by expected net saving, semantic version, release id, digest, and profile index.

Benchmark evidence is bound to the exact run set and the base release that was measured. Adding evidence creates a new release version. Stale or missing evidence keeps a profile preview-only.

The catalog read model also carries a [compatibility confidence](../packages/confidence/README.md) per profile, built from the evidence and finalized outcomes rather than raw receipts. It is display only for now: matching, ranking, pricing, and sale decisions do not use it.

## Pricing and spending

The catalog enforces two bounds:

- The price cannot exceed 30 percent of the conservative expected raw model-cost saving.
- The price cannot exceed `maxPriceFor`, which also preserves the 25 percent all-in reduction target after chain cost.

The bridge independently checks the quoted scheme, network, asset, recipient, authorization lifetime, per-resolution limit, and daily cap before it asks for a signature. It signs the terms of the preview it checked and never pays an x402 challenge; a challenge whose terms differ is refused. The signer that holds the buyer key enforces the recipient, caps, and window again, with its own ledger. Model text cannot authorize payment.

## Delivery and application

The paid response pairs a resolution with the bundle named by its payload digest. The bridge stores it only when the resolution matches the offer it bought: preview id, release, profile digest, buyer, and terms. It verifies the manifest and bundle, checks the repository still fits the purchased profile, and computes a drift plan before writing.

Exact matches can be applied atomically. Drift produces an `adapt` result and an exported bundle for manual integration. Acceptance runs use the release's reviewed package script and safe arguments without a shell.

See [Bridge Runtime](bridge-runtime.md) for the filesystem and process guarantees.

## Payment and warranty boundary

The payment path is built for Arbitrum Sepolia USDC (testnet). `@lemma/core` fixes every value its two sides must agree on:

- **Payment nonce.** The EIP-3009 nonce for a resolution is `derivePaymentNonce(resolutionId, previewId)`, the `payment-nonce` digest of both ids. USDC refuses a second authorization with the same nonce, so a resolution is paid at most once on chain. The resolution id is public and USDC publishes the nonce next to the payer, but only the buyer's bridge and the server know the preview id, so nobody else can join the nonce to the resolution. The server refuses any other nonce before settling.
- **Requirements.** `paymentRequirementsFor(terms)` turns stored `PaymentTerms` into x402 v2 `PaymentRequirements`. The server's `accepts` and the bridge's `accepted` both come from it, so the bridge signs from the preview's terms without a challenge round trip. x402 2.27.0 compares the two by exact string equality and normalizes addresses with `getAddress` wherever it signs or verifies, so the requirements carry EIP-55 checksummed addresses, the form x402's own builder uses for this asset; core's own schemas stay lowercase. Only Arbitrum Sepolia USDC has a known EIP-712 domain, so any other asset is refused.
- **Paid tool input.** `BuyInput` is `{ previewId, claimHash }`. The payer, nonce, and authorization window come from the verified payment, never from tool arguments.
- **Warranty claim.** `warrantyClaimHash(resolutionId, claimSecret, refundTo)` equals Solidity `keccak256(abi.encode(bytes32, bytes32, address))`, which the warranty registry checks before paying a credit. Only the hash reaches the server and the chain. The bridge keeps the secret and the refund address as a `WarrantyClaim` (schema version 1), which is never sent.
- **Receipt signatures.** `adoptionReceiptTypedData(receipt, chainId)` is the EIP-712 typed data a buyer signs: domain `{ name: "Lemma", version: "1", chainId }` and type `AdoptionReceipt(bytes32 resolutionId,string outcome,bytes32 receiptDigest)`, where `receiptDigest` is `adoptionReceiptDigest(receipt)`, the receipt with its signature cleared. The server checks it against the resolution's buyer with viem `verifyTypedData` on a public client, so EOA, ERC-1271, and ERC-6492 signatures all verify.

The digest vectors pin a payment nonce, a claim hash, and a receipt's typed-data hash. The warranty work must still add:

- Provider-signed warranty vouchers: their typed data, signing after settlement, and activation.
- Evaluator outcomes, expiry, and buyer withdrawal credit.

Those additions must preserve the existing identifiers, payment terms, recovery behavior, and adoption receipt digest. Any required schema change belongs in `@lemma/core` before paid records are persisted.
