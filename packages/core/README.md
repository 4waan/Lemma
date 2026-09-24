# Lemma Core

## Purpose and economic role

Core defines the shared language that prevents the server, bridge, dashboard, benchmark, and contract bindings from disagreeing about what was sold. Stable schemas and canonical identifiers are required for payments, signatures, warranties, and reproducible evidence.

## Responsibilities

- Define versioned schemas for repository profiles, releases, previews, resolutions, vouchers, and receipts.
- Define decision, evidence, outcome, and warranty status enums.
- Canonicalize JSON and derive Keccak identifiers.
- Define pricing and spending-policy value types without floating-point currency.
- Provide shared validation and secret-redaction helpers.

## Outside this boundary

- Network requests.
- Database access.
- Filesystem scanning.
- Wallet signing.
- Matching against a concrete catalog.
- User-interface rendering.

## Public interface

Schema version `"1"`. Every object schema is strict at every level (unknown fields fail) and carries `schemaVersion: "1"`.

| Module | Exports |
| --- | --- |
| `primitives` | `LEMMA_SCHEMA_VERSION`, `LEMMA_DECISIONS`, `Hex32`, `Address`, `toAddress`, `SignatureBytes`, `Caip2`, `ARBITRUM_SEPOLIA`, `ARBITRUM_SEPOLIA_USDC`, `USDC_EIP712_DOMAIN`, `IsoTimestamp`, `isoNow`, `ExactVersion`, `PackageName`, `SafeText` |
| `canonical` | `canonicalize` (RFC 8785 JCS over I-JSON), `digest(kind, value)`, `digestOf(kind, schema, value)`, `DIGEST_KINDS` |
| `amounts` | `UsdcAtomic`, `MAX_ATOMIC`, `atomicOrNull`, `parseUsdc`, `formatUsdc`, `toAtomic`, `fromAtomic`, `USDC_DECIMALS` |
| `profile` | `RepositoryProfile`, `profileDigest`, enums `Language`, `PackageManager`, `ModuleSystem`, `Framework` |
| `task` | `TaskRequest`, `taskDigest`, `CapabilityId`, `CAPABILITY_IDS` |
| `release` | `CapabilityRelease`, `releaseDigest`, `catalogDigest`, `SupportedProfile`, `ProfileEvidence`, `Provenance`, `AcceptanceRecipe`, `acceptanceArgv`, `SafeArg`, `ACCEPTANCE_ENV`, `WarrantyTerms`, `MatchedRelease`, `SemverRange` |
| `bundle` | `PatchBundle`, `PatchFile`, `PatchPath`, `bundleDigest`, `fileDigest` |
| `payment` | `PaymentTerms` (the x402 v2 `PaymentRequirements` fields), `MAX_AUTHORIZATION_SECONDS` |
| `reasons` | `ReasonCode`, `REASON_CODES`, `Reasons`, `normalizeReasons` |
| `preview` | `Preview` (discriminated on `decision`), `Offer`, `MAX_OFFER_TTL_SECONDS` |
| `receipt` | `Resolution`, `deriveResolutionId`, `AdoptionReceipt`, `AdoptionOutcome`, `adoptionReceiptDigest` |
| `pricing` | `isSellable`, `saleBlocker`, `allInReductionBps`, `SALE_RULE`, `BENCHMARK_TARGET_BPS` |
| `policy` | `SpendingPolicy`, `checkSpend`, `checkPurchase` |
| `tools` | `LEMMA_TOOLS`, `toolResourceUrl`, `PreviewInput`, `PreviewResult` |
| `run` | `RunRecord`, `RunArm`, `runRecordDigest`, `runSetDigest` (benchmark run records; evidence cites the run set) |
| `redact` | `redact`, `redactString`, `REDACTED`, `CIRCULAR`, `TRUNCATED`, `MAX_REDACT_CHARS` |

### Rules the schemas enforce

- **Digests.** `digest(kind, value) = keccak256(utf8(JCS({ kind, value })))`. `kind` separates domains and must be registered in `DIGEST_KINDS`, and the value carries its own `schemaVersion`. `canonicalize` rejects anything that would serialize ambiguously: bigint, `undefined`, non-finite or unsafe-integer numbers, sparse arrays, lone surrogates, `toJSON` keys and non-plain objects. Hash only parsed values; the typed helpers (`profileDigest`, `releaseDigest`, `bundleDigest`, and so on) parse first. Frozen vectors, including the derived ids, live in `test/vectors/digests.json`.
- **Identifiers.** Content objects are identified by their digest (profile, task, release, catalog, bundle). `previewId` is a random 32-byte value chosen by the server. `resolutionId = deriveResolutionId(previewId, buyer)`, so a retry after a lost response names the same resolution, and the payment path can use it as the EIP-3009 nonce.
- **Timestamps.** Exactly millisecond precision with `Z` (`Date.toISOString()`), so one instant has one string.
- **Amounts.** USDC is always atomic units in a decimal-integer string within uint256 (`"250000"` is 0.25 USDC), the same form as x402's `amount`. Floats, signs, exponents and more than six decimals are rejected.
- **No match, no offer.** A `build` or `decline` preview has no `release` or `offer` field. A matched preview has `offer: null` plus reasons when it cannot be sold. Reasons are a sorted set of known codes.
- **Evidence per profile.** Savings evidence lives on each `SupportedProfile`, with its benchmark version, run-set digest, fixture profile, model, measurement date, `staleAfter`, run counts, control cost, conservative saving and token saving. A profile without fresh evidence is preview-only (`saleBlocker` returns `PROFILE_NOT_BENCHMARKED` or `EVIDENCE_STALE`).
- **Sale rule.** An `Offer` only parses when `terms.amount <= 30%` of the expected raw saving. `allInReductionBps` shows the buyer's all-in reduction, because the 30% cap alone does not guarantee the benchmark's 25% target.
- **What is paid.** `Offer.terms` and `Resolution.terms` are exactly the x402 v2 payment requirements. `checkPurchase` refuses a challenge that differs from the quote in any field, an expired quote, or a payment for a no-match, and then applies `checkSpend` (network, asset, allowed recipients, authorization lifetime, per-resolution limit and daily cap over committed spend).
- **No free text in matching.** `TaskRequest` is a capability id only. `RepositoryProfile` holds allowlisted metadata only. `PreviewInput` is strict, so extra tool arguments are rejected, not dropped.
- **Acceptance recipes.** A release names a package.json script and safe arguments. The bridge builds argv with the buyer's package manager (`acceptanceArgv`), without a shell, forwarding only `ACCEPTANCE_ENV`. The bridge must still sandbox the run.
- **Patch bundles.** Relative POSIX paths only, with no dotfiles, manifests, lockfiles or `node_modules`. Each modify or delete carries the base file digest for drift detection, and dependency changes are declared, not edited.
- **Provenance.** Releases require a GitHub repository, a full 40-hex commit and an SPDX license expression.
- **Canonical hex.** Addresses, digests and signatures are lowercase. Normalize external addresses with `toAddress`.

### Left to the payment and contract work

Core does not define the warranty voucher, its EIP-712 typed-data layout, the settlement record, or signing. What core provides for them:

- `PaymentTerms` mirrors x402 v2 `PaymentRequirements` without importing x402 (x402 pins zod 3; core uses zod 4).
- `deriveResolutionId` is the idempotency key and a candidate EIP-3009 nonce.
- `adoptionReceiptDigest` is the value a buyer signs.
- `checkPurchase` and `checkSpend` are the pure checks before signing. The caller reserves spend before signing, under a lock.
- Digest kinds for vouchers and settlements should be added to `DIGEST_KINDS`.
- Paid MCP tools must not declare an `outputSchema`, because x402 returns its challenge in `structuredContent`.

## Workspace dependencies

- Zod for runtime validation.
- `json-canonicalize` for deterministic serialization.
- viem utilities for Ethereum-compatible hashes and values.

## Environment variables

None. Core must remain deterministic and environment-independent.

## Development and tests

- `npm run build -w @lemma/core`
- `npm run test -w @lemma/core`

## Security constraints

- Parse untrusted values rather than casting them.
- Reject unknown fields on signed and paid payloads.
- Represent USDC amounts as integers in atomic units.
- Version every signed structure.
- Keep canonicalization test vectors shared with Solidity encoding tests.

## Later completion criteria

Core is complete when every application imports one canonical schema set, cross-language digest vectors match, invalid paid payloads fail closed, and schema migration rules are documented.
