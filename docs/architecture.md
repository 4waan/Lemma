# Architecture

Lemma resolves a typed integration task and privacy-safe repository profile against a curated catalog of verified releases. The system separates local repository authority, hosted coordination, economic settlement, and public evidence.

## Components

### Local bridge

The stdio MCP bridge runs beside the coding agent. It constructs the repository profile, requests previews, buys resolutions within a local spending policy, tracks local purchases, checks drift, applies patches, runs acceptance recipes, and manages adoption receipts.

Repository source and buyer authority stay local. The bridge keeps its own spend ledger but never holds the buyer key.

### Buyer signer

`lemma-signer` is a separate local process that holds the buyer key and signs over a Unix socket: USDC transfer authorizations and Adoption Receipts. Every process of the user can reach its socket, so it enforces the spending policy itself, with its own ledger. The bridge reaches it through a `Signer` interface.

### Hosted server

The Hono server hosts the stateless MCP endpoint, deterministic resolver, durable resolution state, read APIs, demand aggregation, and dashboard assets.

Free preview, recovery, and the x402 paid tool are implemented. The paid tool runs an in-process x402 facilitator with no public endpoints, a settlement reconciler, and a receipt signature verifier. The provider voucher signer remains pending with the warranty work.

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
- The bridge never holds a wallet secret. The signer holds the buyer key and signs only within its own policy.
- The server receives typed repository metadata, not source by default.
- The catalog is curated and validated before it can influence a preview.
- Provider, facilitator, evaluator, buyer, and deployer identities are separate roles.
- The evaluator is trusted for MVP pass and failure attestations.
- The dashboard is informational and cannot mutate product or chain state.

## End-to-end flow

Every step is implemented except the warranty voucher in step 7 and the onchain outcome in step 10, which require the warranty work.

1. The agent calls the bridge's `lemma_preview` tool with a typed capability.
2. The bridge reads allowlisted package metadata and asks the server for a free preview.
3. The resolver checks the frozen catalog snapshot and returns `reuse`, `build`, or `decline`. The bridge may later return `adapt` after local drift checks.
4. The agent calls `lemma_buy_resolution`. The bridge checks the open offer with core `checkPurchase` against its spend ledger (quote expiry, scheme, chain, token, recipient, authorization lifetime, per-purchase and daily caps), reserves the amount, and marks the purchase pending.
5. The bridge derives the EIP-3009 nonce and the x402 requirements from the preview's own terms and asks the signer for the authorization in Arbitrum Sepolia USDC. The signer checks its own policy and signs.
6. One paid MCP call carries the payment. The server's in-process facilitator verifies it, the paid tool's handler prepares the resolution, and the facilitator settles USDC to the provider. A refusal by the handler cancels settlement.
7. The server commits the resolution and signs a warranty voucher. A settlement the call could not confirm is committed later by the reconciler from USDC's log; one that never happened expires.
8. The bridge stores the delivery after checking it against the offer, or recovers a lost paid response for free; it never pays twice. It verifies the manifest and bundle, and previews or applies it.
9. The bridge runs the reviewed acceptance recipe and creates an Adoption Receipt, which the signer signs.
10. The server records the receipt and checks its signature against the buyer. The evaluator can later finalize the onchain warranty outcome.

Nothing on an agent's tool call reads or writes the chain except the payment itself, and the agent never holds ETH: the facilitator pays gas. See [Server Runtime](server-runtime.md) and [Bridge Runtime](bridge-runtime.md) for the paid path's details.

## Hosted interfaces

The MCP endpoint uses stateless Streamable HTTP with one JSON-RPC message per request. `GET`, `DELETE`, batches, browser origins, oversized input, and invalid schemas are rejected.

The bridge is the intended MCP client. Agents receive the bridge's small text tools rather than the remote server tools. Interest sets and base probes are cached so a warm preview normally requires one hosted request.

The server also exposes typed, read-only HTTP APIs for releases, catalog state, demand, resolutions, service status, and health. See the [Server guide](../apps/server/README.md) for the route list.

## Data model

All components import strict versioned schemas from `@lemma/core`. Content objects use typed Keccak-256 digests over canonical JSON. USDC travels as atomic-unit decimal strings. Frozen vectors keep other encoders compatible.

See [Protocol](protocol.md) for identifiers, evidence binding, pricing, and receipt rules.

## Persistence

Postgres stores immutable releases and bundles, catalog snapshots, offer-bearing previews, prepared and settled resolutions with the buyer's warranty claim hash, adoption receipts with their signature verdict, and privacy-thresholded demand data.

`ResolutionService` is the payment integration seam. Conditional transitions prevent duplicate preparation, payment reuse, and duplicate settlement. Settlement is keyed by the payment authorization, not the transaction, since one transaction can carry several authorizations. The reconciler commits or expires a row only by the authorization it checked.

Later migrations will add signed warranty vouchers and chain indexer cursors. Chain projections must be idempotent by chain id, transaction hash, and log index.

## Failure behavior

- No match produces no payment offer.
- A local policy failure produces no payment signature, in the bridge and again in the signer.
- Catalog, configuration, or migration failure prevents server startup.
- Settlement uncertainty is resolved by the reconciler from the chain, not by paying again.
- Lost paid responses are recovered with the preview secret and buyer.
- Patch drift stops direct application and returns an adaptation path.
- An interrupted apply is recovered from its local journal.
- Missing evaluator confirmation leaves a warranty active until expiry.
- Expiry releases reserved bond without asserting software success.
