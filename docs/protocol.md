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

## Pricing and spending

The catalog enforces two bounds:

- The price cannot exceed 30 percent of the conservative expected raw model-cost saving.
- The price cannot exceed `maxPriceFor`, which also preserves the 25 percent all-in reduction target after chain cost.

The bridge independently checks the quoted scheme, network, asset, recipient, authorization lifetime, per-resolution limit, daily cap, and every field of the x402 challenge before signing. Model text cannot authorize payment.

## Delivery and application

The paid response pairs a resolution with the bundle named by its payload digest. The bridge verifies the manifest and bundle, checks the repository still fits the purchased profile, and computes a drift plan before writing.

Exact matches can be applied atomically. Drift produces an `adapt` result and an exported bundle for manual integration. Acceptance runs use the release's reviewed package script and safe arguments without a shell.

See [Bridge Runtime](bridge-runtime.md) for the filesystem and process guarantees.

## Payment and warranty boundary

The current implementation stops at the paid-tool registration and signer seams. The pending payment lane must add:

- x402 facilitator endpoints and the paid MCP tool.
- Spend reservation and EIP-3009 authorization handling.
- Settlement reconciliation and signed resolution delivery.
- Warranty voucher typed data and activation.
- Evaluator outcomes, expiry, and buyer withdrawal credit.

Those additions must preserve the existing identifiers, payment terms, recovery behavior, and adoption receipt digest. Any required schema change belongs in `@lemma/core` before paid records are persisted.
