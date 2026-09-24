# Architecture

## Objective

Lemma reduces repeated coding-agent work by resolving a task and safe repository profile against a curated set of verified integration capabilities.

The architecture intentionally separates local authority, hosted coordination, economic settlement, and public evidence.

## Components

### Local bridge

The local MCP bridge has the buyer wallet and limited repository access. It constructs a safe profile, enforces spending policy, verifies delivered payloads, applies patches, runs approved tests, and signs buyer receipts.

### Hosted server

The server matches profiles, serves the paid resolution tool, operates the x402 facilitator, stores recoverable resolution records, signs provider vouchers, receives receipts, and exposes read-only data.

### Curated catalog

The catalog contains versioned manifests, supported profiles, deterministic payloads, fixtures, acceptance recipes, licenses, provenance, evidence, pricing, and expiry.

### Warranty registry

The Arbitrum Sepolia contract holds provider bonds and records activated warranties and evaluator outcomes. It stores hashes rather than buyer source or patch content.

### Dashboard

The dashboard explains releases, payments, warranties, outcomes, and benchmarks. It has no signing authority.

## Trust boundaries

- The coding agent can request tools but cannot read wallet secrets.
- The bridge trusts reviewed local code and configured endpoints, not model prose.
- The server receives structured profiles, not repository source by default.
- The provider signer and evaluator signer are separate roles.
- The contract trusts the registered evaluator for pass and failure attestations.
- The public dashboard is informational and cannot authorize state changes.

## Planned sequence

1. The agent calls `lemma_preview` with a typed task.
2. The bridge reads allowlisted repository metadata and sends a validated profile.
3. The resolver hard-filters the catalog and returns a free decision.
4. The bridge checks expected savings, price, network, token, recipient, and budgets.
5. The bridge creates an x402 payment and retries the paid MCP call.
6. The facilitator settles USDC to the provider.
7. The server persists the settlement and resolution and signs a warranty voucher.
8. The bridge recovers any missing response, verifies the payload, and activates the voucher onchain.
9. The bridge previews or applies the patch and runs the acceptance recipe.
10. The buyer signs an Adoption Receipt. The evaluator may finalize an onchain outcome.

## Persistence

Postgres will store previews, resolution preparation, settlement receipts, signed vouchers, adoption receipts, and indexer cursors. Catalog assets remain version-controlled. Chain events are projected idempotently by chain ID, transaction hash, and log index.

## Failure behavior

- No match means no payment offer.
- Local budget failure means no payment signature.
- Settlement uncertainty enters reconciliation, not an immediate retry.
- Lost paid responses are recovered by resolution ID.
- Patch drift stops application before mutation.
- Missing evaluator confirmation leaves the warranty active until its claim deadline.
- Expiry releases unresolved bond without claiming software success.
