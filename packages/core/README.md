# Lemma Core

`@lemma/core` is the shared protocol package. It keeps the bridge, server, catalog, benchmark, dashboard, and future contract bindings on one versioned definition of what was matched, paid for, delivered, and observed.

Core is deterministic and environment-independent. It performs no network, filesystem, database, or signing work.

## Domain modules

| Domain | Modules | Owns |
| --- | --- | --- |
| Identity | `primitives`, `canonical` | Schema version, addresses, timestamps, safe text, canonical JSON, typed digests. |
| Matching | `task`, `profile`, `reasons`, `preview` | Capability requests, repository profiles, decisions, and offers. |
| Releases | `release`, `bundle` | Supported profiles, evidence, provenance, acceptance recipes, patches, and drift planning. |
| Money | `amounts`, `payment`, `pricing`, `policy` | Atomic USDC, x402 terms, sellability, price bounds, and local spend checks. |
| Purchase | `purchase`, `signing` | Payment nonce, x402 requirements, paid-tool input, warranty claim commitment, and receipt typed data. |
| Outcomes | `receipt`, `run` | Resolutions, adoption receipts, benchmark run records, and derived identifiers. |
| Reputation | `reputation` | ERC-8004 agent ids, adoption evidence, and the public feedback files and their hash. |
| Interfaces | `tools`, `read` | MCP inputs and outputs plus public dashboard read models. |
| Safety | `redact` | Bounded credential redaction for structured and unstructured data. |

The package root re-exports the supported public surface:

```ts
import {
  Preview,
  RepositoryProfile,
  checkPurchase,
  deriveResolutionId,
  profileDigest,
} from "@lemma/core";
```

## Protocol invariants

- Every object schema is strict and carries `schemaVersion: "1"`.
- Digests use Keccak-256 over RFC 8785 canonical JSON with a registered domain kind.
- USDC amounts are decimal strings in six-decimal atomic units, never floating-point values.
- A no-match preview cannot contain an offer.
- Evidence is specific to one supported profile and bound to a benchmark run set.
- `ReleaseSummary.reputation` is a read-model value only: `{ passBps, count }` from the provider agent's ERC-8004 summary for the release's capability, counting only Lemma's attester, or null while none is known. No digest vector covers it.
- `ProfileSummary.compatibility` is a read-model value only: `{ confidenceBps, effectiveNMilli, outcomes, source }`, or null when a profile has neither evidence nor a finalized outcome (or the server could not read its outcomes). Its `source` must agree with both. The server computes it with `@lemma/confidence` and passes it to `summarizeRelease`. It is never signed, paid, or persisted, so no digest vector covers it.
- A sellable price must pass both the 30 percent saving rule and the all-in reduction bound.
- MCP matching accepts typed capability ids, not free-form task prose.
- Patch bundles cannot modify manifests, lockfiles, workspace policy files, dotfiles, or `node_modules`.
- Recovery requires the secret preview id and buyer. A public resolution id is insufficient.
- Signed and paid objects must be parsed before they are hashed or acted on.
- A resolution's EIP-3009 nonce is `derivePaymentNonce(resolutionId, previewId)`, never the public resolution id.

The full cross-component behavior is documented in [Protocol](../../docs/protocol.md). Frozen digest vectors live in `test/vectors/digests.json`.

## Payment pieces

Core holds no keys and signs nothing, but it fixes every value both sides of a payment must agree on. [Protocol](../../docs/protocol.md#payment-and-warranty-boundary) describes each one:

- `derivePaymentNonce`: the EIP-3009 nonce of a resolution.
- `paymentRequirementsFor`: the x402 v2 requirements for stored `PaymentTerms`.
- `BuyInput`: the paid tool's input.
- `warrantyClaimHash`: the warranty claim commitment.
- `WarrantyClaim`: the bridge's private record of a claim, refused unless its `claimHash` is the hash of its other fields.
- `adoptionReceiptTypedData`: the EIP-712 typed data a buyer signs for an Adoption Receipt, in `signing` with `ADOPTION_RECEIPT_TYPES` and the `Lemma` domain constants.

`PaymentTerms` mirrors x402 v2 without importing x402, because x402 pins zod 3 and core uses zod 4.

## Reputation pieces

Each ERC-8004 feedback Lemma's attester posts points at a public feedback file. Core fixes the bytes of those files, so anyone can check a `feedbackHash` on chain against them:

- `AgentId`: an ERC-8004 agent id, a decimal uint256 string with one spelling. `agentIdJson` writes it as ERC-8004's JSON files do: a number up to 2^53 - 1, its decimal string above.
- `AdoptionEvidence`: Lemma's evidence for one finalized outcome. It names the resolution, the release and profile, the capability, the recipe by `acceptanceRecipeDigest` (digest kind `acceptance-recipe`), the acceptance result, the verdict (`passed` needs exit code 0), the finalization time and the warranty registry.
- `adoptionFeedbackFile(evidence, parties)`: the file behind one feedback. Its ERC-8004 fields equal the `giveFeedback` call that points at it: `agentRegistry`, `agentId`, `clientAddress` (the attester, never the buyer), `createdAt`, `value` (100 for a pass, 0 for a failure), `valueDecimals` 0, `tag1` `lemma.adoption`, `tag2` the capability, and `endpoint` `""`. The evidence sits under `lemma`. The provider's feedback and an opted-in buyer agent's feedback on one outcome differ in `agentId`, so each has its own file and hash.
- `adoptionFeedbackFileBytes(file)` and `feedbackHashOf(bytes)`: the canonical JSON bytes served at the feedback URI (the file itself, without a `{ kind, value }` envelope) and their keccak256, ERC-8004's `feedbackHash`.
- `Caip10` and `caip10` name registries and clients as `eip155:<chainId>:<address>`. `REPUTATION_META_KEY` (`lemma/reputation`) is the `_meta` key of a preview result that carries the matched release's record.

Both schemas are strict and have no field for the buyer or payer, the preview id, the payment nonce, or the settlement, so a file cannot join a wallet to what it bought. For the same reason a file has no `proofOfPayment`, the optional field ERC-8004 suggests for x402: it would name the payer and its payment transaction.

## Development

```bash
npm run build -w @lemma/core
npm run test -w @lemma/core
```

Add a frozen vector when changing canonical data or derived identifiers. A schema change that affects persisted, paid, or signed data requires an explicit versioning decision before dependent components adopt it.

The vectors pin a payment nonce, a warranty claim hash, a receipt's typed-data hash, an acceptance-recipe digest, and an example feedback file's bytes and `feedbackHash` under `derived`. A fixed-input test pins the claim hash `0xefe737cca6b5574d334f88508fb3149002c12c771f7bdeec10267e5cf8fa21eb` for `resolutionId = 0x11…11`, `secret = 0x22…22` and `refundTo = 0x3333…33`, computed with viem and Foundry's `cast`. The warranty registry's Foundry tests must assert the same value.

Core does not define warranty vouchers or evaluator outcomes: their EIP-712 layouts belong to the warranty registry (`contracts/`). A structure the server persists or signs for them must still be added here first.
