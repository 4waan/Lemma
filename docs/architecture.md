# Architecture

Lemma resolves a typed integration task and privacy-safe repository profile against a curated catalog of verified releases. The system separates local repository authority, hosted coordination, economic settlement, and public evidence.

## Components

### Local bridge

The stdio MCP bridge runs beside the coding agent. It constructs the repository profile, requests previews, tracks local purchases, checks drift, applies patches, runs acceptance recipes, and manages adoption receipts.

Repository source and buyer authority stay local. The payment lane will attach a buyer signer and spending ledger through existing bridge hooks.

### Hosted server

The Hono server hosts the stateless MCP endpoint, deterministic resolver, durable resolution state, read APIs, demand aggregation, and dashboard assets.

Free preview and recovery are implemented. The x402 facilitator, paid tool registrar, settlement reconciler, and provider voucher signer remain pending.

### Curated catalog

The catalog contains immutable release manifests, patch bundles, supported profiles, fixtures, provenance, acceptance recipes, evidence, prices, and expiry. Catalog validation runs in tests and before the server listens.

The current releases are preview-only skeletons. They exercise matching and catalog integrity but carry no sellable payload or measured evidence.

### Dashboard

The same-origin React dashboard renders validated public read models for catalog state, evidence, demand, resolutions, and service status. It has no credentials or authorization role.

### Benchmark harness

The harness runs controlled agent experiments, reconciles provider usage, creates canonical run records, derives conservative evidence, and evaluates the product's correctness and cost targets.

### Warranty registry

The planned Arbitrum Sepolia contract holds provider bond, activates signed warranty vouchers, records evaluator outcomes, and creates buyer withdrawal credit. It stores identifiers and accounting state rather than repository or patch content.

## Trust boundaries

- The coding agent chooses tools but cannot authorize payment from prose alone.
- The bridge trusts reviewed local code and configured endpoints, not model output.
- The server receives typed repository metadata, not source by default.
- The catalog is curated and validated before it can influence a preview.
- Provider, facilitator, evaluator, buyer, and deployer identities are separate roles.
- The evaluator is trusted for MVP pass and failure attestations.
- The dashboard is informational and cannot mutate product or chain state.

## End-to-end flow

Steps 1 through 3 and 8 through 10 are implemented. Steps 4 through 7 require the payment and warranty work.

1. The agent calls the bridge's `lemma_preview` tool with a typed capability.
2. The bridge reads allowlisted package metadata and asks the server for a free preview.
3. The resolver checks the frozen catalog snapshot and returns `reuse`, `build`, or `decline`. The bridge may later return `adapt` after local drift checks.
4. The bridge validates expected saving, price, chain, token, recipient, authorization lifetime, and local budgets.
5. The bridge authorizes x402 payment in Arbitrum Sepolia USDC.
6. The facilitator verifies and settles payment to the provider.
7. The server commits the resolution and signs a warranty voucher.
8. The bridge recovers a lost paid response, verifies the manifest and bundle, and previews or applies it.
9. The bridge runs the reviewed acceptance recipe and creates an Adoption Receipt.
10. The server records the receipt. The evaluator can later finalize the onchain warranty outcome.

## Hosted interfaces

The MCP endpoint uses stateless Streamable HTTP with one JSON-RPC message per request. `GET`, `DELETE`, batches, browser origins, oversized input, and invalid schemas are rejected.

The bridge is the intended MCP client. Agents receive the bridge's small text tools rather than the remote server tools. Interest sets and base probes are cached so a warm preview normally requires one hosted request.

The server also exposes typed, read-only HTTP APIs for releases, catalog state, demand, resolutions, service status, and health. See the [Server guide](../apps/server/README.md) for the route list.

## Data model

All components import strict versioned schemas from `@lemma/core`. Content objects use typed Keccak-256 digests over canonical JSON. USDC travels as atomic-unit decimal strings. Frozen vectors keep other encoders compatible.

See [Protocol](protocol.md) for identifiers, evidence binding, pricing, and receipt rules.

## Persistence

Postgres stores immutable releases and bundles, catalog snapshots, offer-bearing previews, prepared and settled resolutions, adoption receipts, and privacy-thresholded demand data.

`ResolutionService` is the payment integration seam. Conditional transitions prevent duplicate preparation, payment reuse, and duplicate settlement. A reconciler can inspect unsettled rows and expire only the authorization it previously observed.

Later migrations will add signed warranty vouchers, settlement details, and chain indexer cursors. Chain projections must be idempotent by chain id, transaction hash, and log index.

## Failure behavior

- No match produces no payment offer.
- A local policy failure produces no payment signature.
- Catalog, configuration, or migration failure prevents server startup.
- Settlement uncertainty remains pending for reconciliation.
- Lost paid responses are recovered with the preview secret and buyer.
- Patch drift stops direct application and returns an adaptation path.
- An interrupted apply is recovered from its local journal.
- Missing evaluator confirmation leaves a warranty active until expiry.
- Expiry releases reserved bond without asserting software success.
