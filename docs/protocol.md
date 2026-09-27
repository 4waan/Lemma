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

A bridge that opted in sends its agent's ERC-8004 id beside the receipt, not inside it, so the receipt and its digest do not change.

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

The digest vectors pin a payment nonce, a claim hash, and a receipt's typed-data hash.

On chain, the warranty registry is written and tested but not deployed. Its state machine, roles, and limits are in the [contracts guide](../contracts/README.md). Each component's part in a warranty:

- Before paying, the buyer's bridge picks a random claim secret and a refund address, keeps both, and sends only their `claimHash`. After a FAILED outcome, only that secret unlocks the credit, and only to that address.
- After settlement, the release's provider signs a voucher that binds the resolution to an opaque payment reference (`paymentRef`) and to the buyer's `claimHash`. The registry never stores a buyer or payer address.
- The release's evaluator signs one outcome per resolution, from the buyer's verified receipt. Without one, the warranty expires after its claim deadline.
- The server holds both keys for the MVP. It sends vouchers, outcomes, expiries, and credit withdrawals, and pays the gas, so agents never hold ETH. Anyone else may relay them too.

### Vouchers and outcomes

Core's `warranty` module holds the registry's EIP-712 layouts and the objects signed with them. The layouts belong to the protocol owner: they are copied exactly from `contracts/src/ResolutionWarrantyRegistry.sol`, and a test reproduces the registry's own vectors (`contracts/test/Vectors.t.sol`), so a change on either side fails a test. Core holds no keys and signs nothing.

- **Domain.** `{ name: "Lemma Warranty Registry", version: "1", chainId, verifyingContract }`, with the registry's address as the verifying contract.
- **Voucher.** `Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)`, signed by the release's provider and kept as `WarrantyVoucher` (schema version 1). The server fills it from the settled resolution: its release digest and profile index; `amount`, the price paid (the warranty equals the price, in atomic USDC, above zero); `paymentRef`, 32 random bytes made once per resolution and never derived from the payer, the payment nonce, or the settlement; `claimHash`, the buyer's `warrantyClaimHash`; and `activateBy`, the last second the voucher may be submitted.
- **Outcome.** `Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)`, signed by the release's evaluator and kept as `WarrantyOutcome` (schema version 1), whose verdict is `passed`, `failed`, or `void`. `verdictCode` and `verdictOf` convert to and from the registry's numbers.
- **Evidence hash.** `evidenceHash` is `adoptionReceiptDigest(receipt)` of the buyer's verified receipt, the receipt with its signature cleared. The ERC-8004 feedback file cannot be hashed before finalization, because it names the finalization time.
- **Signing windows.** The provider signs `activateBy` as the chain's clock plus 900 seconds. The evaluator signs `validUntil` as the earlier of the chain's clock plus 3600 seconds and the claim deadline in force. Each is signed again once it is within three minutes of passing; a voucher keeps its payment reference.

| Verified receipt | Verdict | Code | In the registry | Weight |
| --- | --- | --- | --- | --- |
| `passed` | PASSED | 1 | The bond returns to the release, and the engine records a pass. | 10000, or 0 under the damper |
| `failed` | FAILED | 2 | The reserved amount becomes the buyer's credit, and the engine records a failure. | 10000, or 0 under the damper |
| `abandoned` | VOID | 3 | The bond returns to the release, and nothing is recorded. | 0 |

A failed receipt becomes FAILED on its own only with `EVALUATOR_FAILURES=auto`; by default an operator decides FAILED or VOID. An unverified or missing receipt is never finalized, and its warranty expires. The registry calls the engine's `record` only for a PASSED or FAILED verdict with a weight above zero while an engine is set, so a zero weight keeps an outcome out of every record without changing its warranty. The damper gives a payer's outcomes weight 0 beyond three weighted ones per release digest and profile index in 30 days (see [the damper](reputation-and-confidence.md#the-damper)).

### Outbox and relay objects

- **Outbox payloads.** Each of the server's warranty actions carries a `WarrantyVoucher` (activate), a `WarrantyOutcome` (finalize), a `WarrantyWithdrawal` (withdraw: `{ resolutionId, claimSecret, to }`, held only until the relay is over), or a `WarrantyActionRef` (`{ resolutionId }`: an expiry, and a closed withdrawal). Kinds are `WarrantyActionKind` and states `WarrantyActionState`; `isFinalActionState` names the three that never change.
- **Credit relay.** `WarrantyWithdrawalRequest` is the relay route's body. `WarrantyWithdrawalAnswer` is its 202 answer, `{ resolutionId, state }` with `state` `queued`, `sent`, `done`, or `abandoned`. `WarrantyWithdrawalRefusal` is `{ error }`, one of `WARRANTY_WITHDRAWAL_REFUSALS`. [Server Runtime](server-runtime.md#credit-relay-route) gives each code's status and meaning.

The digest vectors also pin the registry's example voucher and outcome typed-data hashes (`warrantyVoucherTypedDataHash`, `warrantyOutcomeTypedDataHash`), computed on chain 421614 with the registry at `0x4c454D4D41000000000000000000000000000001`.

A public resolution view shows its warranty's state, amount, claim deadline, and transactions, never the buyer, the payer, the claim hash or secret, the refund address, or the payment reference. A warranted resolution's id is public on chain, so the view also gives only the day the resolution was created, never the time; the precise time stays in the signed `Resolution` the buyer holds. The [core guide](../packages/core/README.md) lists these read models.

Changes to these objects must preserve the existing identifiers, payment terms, recovery behavior, and adoption receipt digest. Any schema change belongs in `@lemma/core` before anything persists or signs it.

## Public adoption record

Finalized outcomes are mirrored as a public record on the ERC-8004 registries on Arbitrum Sepolia (testnet). Matching, pricing, sale decisions, bonds, and refunds never depend on it.

- **Feedback.** For each finalized `passed` or `failed` outcome with a weight above zero, Lemma's attester posts `giveFeedback(agentId, value, 0, "lemma.adoption", capability, "", feedbackURI, feedbackHash)` to the provider's agent, with value 100 for a pass and 0 for a failure. Void outcomes, and outcomes the damper weighed at 0, are never posted. A buyer whose bridge opted in with its own agent id gets the same feedback, but only when the address that paid owns that agent or is its agent wallet.
- **Feedback file.** `feedbackURI` serves that feedback's own file, and `feedbackHash` is the keccak256 of its bytes: the RFC 8785 canonical JSON of core `AdoptionFeedbackFile`. Its ERC-8004 fields equal the call, and Lemma's evidence sits under `lemma`: resolution, release and profile, capability, recipe digest (digest kind `acceptance-recipe`), acceptance result, verdict, finalization time, and warranty registry. Anyone can fetch the file and check it against the hash on chain.
- **What it never says.** A file has no field for the buyer or payer, the preview id, the payment nonce, or the settlement, and no `proofOfPayment`. Only a buyer that opts in is linked to its adoptions, through its own agent.
- **Summary.** The pass rate and count a preview or the catalog shows come from `getSummary(providerAgentId, [attester], "lemma.adoption", capability)`, which counts only Lemma's attester. The catalog adds the distinct buyers behind the outcomes fed to the attester, from three up. The bridge receives the pass rate and count as `_meta["lemma/reputation"]` on the preview result; `PreviewResult` does not change.

The digest vectors pin an example feedback file's bytes and hash. See [Server Runtime](server-runtime.md#erc-8004-reputation) for how the attester posts, and [Security Model](security-model.md#reputation-threat-model) for what the record reveals.
