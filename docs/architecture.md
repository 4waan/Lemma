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

The dashboard explains releases, payments, warranties, outcomes, and benchmarks. It has no signing authority. The server serves it from the same origin as its read API, so the page's CSP allows nothing but that origin, and every view renders a core read model (`packages/core/src/read.ts`) that the page validates before showing it. Views are addressed by URL fragment: overview and setup, catalog, benchmark evidence, unmet demand (what to build next), resolution detail and status.

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

## Hosted MCP endpoint

The server's MCP endpoint is stateless Streamable HTTP with JSON responses. Every request builds a new MCP server and transport, because the SDK refuses to reuse a stateless transport. `GET` and `DELETE` return 405, so no idle SSE stream is held. Each request carries one JSON-RPC message; batches are refused, so a request costs one rate-limit token. The endpoint itself keeps no session, but offers and rate limits live in one process until they move to shared storage, so the MVP runs one replica.

The bridge is the only intended client. It calls `lemma_preview` with a typed task and a profile that holds only the dependencies in the catalog's published interest set, and it calls `lemma_recover_resolution` on its own after a lost paid response. Agents never see these server tools directly: the bridge exposes its own small, text-only tools.

## Schemas

Every component imports its data shapes from `@lemma/core` (see [packages/core/README.md](../packages/core/README.md)), and no application redefines them. Content objects (profiles, tasks, releases, catalog snapshots, patch bundles) are identified by `keccak256` over the RFC 8785 canonical JSON of `{ kind, value }`. A preview id is random. A resolution id is derived from the preview id and the buyer, so a recovered purchase names the same resolution. USDC amounts travel as atomic-unit integer strings, and payment terms use x402 v2's `PaymentRequirements` fields. Any other encoder, including the contract tests, checks itself against the shared vectors in `packages/core/test/vectors/digests.json`.

## Persistence

Postgres stores:

- immutable copies of every served release and bundle
- catalog snapshots
- offer-bearing previews
- resolution preparation and settlement state
- adoption receipts
- daily demand counts

Later it will also store signed vouchers and indexer cursors. Catalog assets remain version-controlled, and the database copies are keyed by digest, so a redeploy never strands an offer or a recovery. Chain events are projected idempotently by chain ID, transaction hash, and log index.

The paid path meets the payment work at `ResolutionService` (`apps/server/src/service.ts`):

- `prepare` writes one row per resolution with a single conditional insert. A duplicate payment is answered with `IN_FLIGHT` or `ALREADY_SETTLED`, and an authorization already backing another resolution with `PAYMENT_REUSED`; the paid tool returns `isError`, so x402 cancels that settlement.
- `commit` records settlement for the authorization that settled and never throws.
- Unsettled rows are listed for the settlement reconciler, which expires a row by the nonce it checked.

## Failure behavior

- No match means no payment offer.
- Local budget failure means no payment signature.
- Settlement uncertainty enters reconciliation, not an immediate retry.
- Lost paid responses are recovered by preview ID and buyer, which derive the resolution ID. The preview ID is the bearer secret: only the bridge that asked for the preview receives it, and it is never published or logged. A resolution ID can be shown publicly without exposing the paid payload.
- Patch drift stops application before mutation.
- Missing evaluator confirmation leaves the warranty active until its claim deadline.
- Expiry releases unresolved bond without claiming software success.
