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
- A sellable price must pass both the 30 percent saving rule and the all-in reduction bound.
- MCP matching accepts typed capability ids, not free-form task prose.
- Patch bundles cannot modify manifests, lockfiles, workspace policy files, dotfiles, or `node_modules`.
- Recovery requires the secret preview id and buyer. A public resolution id is insufficient.
- Signed and paid objects must be parsed before they are hashed or acted on.
- A resolution's EIP-3009 nonce is `derivePaymentNonce(resolutionId, previewId)`, never the public resolution id.

The full cross-component behavior is documented in [Protocol](../../docs/protocol.md). Frozen digest vectors live in `test/vectors/digests.json`.

## Payment pieces

Core holds no keys and signs nothing, but it fixes every value both sides of a payment must agree on:

- `derivePaymentNonce(resolutionId, previewId)`: the EIP-3009 nonce the buyer signs (digest kind `payment-nonce`).
- `paymentRequirementsFor(terms)`: the x402 v2 requirements for stored `PaymentTerms`, with EIP-55 checksummed addresses and USDC's EIP-712 domain in `extra`. The server's `accepts` and the bridge's `accepted` both come from it. Only Arbitrum Sepolia USDC is supported.
- `BuyInput`: the paid tool's input, `{ previewId, claimHash }`.
- `warrantyClaimHash(resolutionId, claimSecret, refundTo)`: equals Solidity `keccak256(abi.encode(bytes32, bytes32, address))`. `WarrantyClaim` (schema version 1) is the bridge's private record of a claim, refused unless its `claimHash` is the hash of the other fields.
- `adoptionReceiptTypedData(receipt, chainId)`: the EIP-712 typed data a buyer signs for an Adoption Receipt (`signing`, with `ADOPTION_RECEIPT_TYPES` and the `Lemma` domain constants).

`PaymentTerms` mirrors x402 v2 without importing x402, because x402 pins zod 3 and core uses zod 4.

## Development

```bash
npm run build -w @lemma/core
npm run test -w @lemma/core
```

Add a frozen vector when changing canonical data or derived identifiers. A schema change that affects persisted, paid, or signed data requires an explicit versioning decision before dependent components adopt it.

The vectors pin a payment nonce, a warranty claim hash and a receipt's typed-data hash under `derived`. A fixed-input test pins the claim hash `0xefe737cca6b5574d334f88508fb3149002c12c771f7bdeec10267e5cf8fa21eb` for `resolutionId = 0x11…11`, `secret = 0x22…22` and `refundTo = 0x3333…33`, computed with viem and Foundry's `cast`; the warranty registry's Foundry test asserts the same value.

Core does not define warranty vouchers or evaluator outcomes: their EIP-712 layouts belong to the warranty registry (`contracts/`). A structure the server persists or signs for them must still be added here first.
