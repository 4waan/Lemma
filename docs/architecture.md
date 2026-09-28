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

Free preview, recovery, and the x402 paid tool are implemented. The paid tool runs an in-process x402 facilitator with no public endpoints, a settlement reconciler, and a receipt signature verifier.

In the background, the server's warranty outcome pipeline activates each paid warranty as the provider, finalizes outcomes as the evaluator, expires warranties, relays buyers' credit withdrawals, and indexes the registry's events. Those events feed the catalog's compatibility confidence, the attester, and each resolution's warranty view (see [Server Runtime](server-runtime.md#warranty-outcome-pipeline)).

The server's attester posts each finalized outcome as ERC-8004 feedback on Arbitrum Sepolia, each feedback with its own public feedback file. The server caches the resulting public record for previews and the catalog. Both are off until configured.

### Curated catalog

The catalog contains immutable release manifests, patch bundles, supported profiles, fixtures, provenance, acceptance recipes, evidence, prices, and expiry. Catalog validation runs in tests and before the server listens.

The current releases are preview-only. `mcp-server-payment-gating@0.1.0` carries a real payload (x402 payment gating for a TypeScript MCP server) and `mcp-client-paying-client@0.1.0-skeleton` a placeholder. Neither has measured evidence, so neither is sold.

### Dashboard

The same-origin React dashboard renders validated public read models for catalog state, evidence, demand, resolutions with their warranties, and service status with the contracts the server works with. Explorer links go to the explorer the server names, and are off when it names none. It has no credentials or authorization role.

### Benchmark harness

The harness runs controlled agent experiments, reconciles provider usage, creates canonical run records, derives conservative evidence, and evaluates the product's correctness and cost targets.

### Compatibility confidence engine

An integer-only Rust crate (`contracts/stylus/lemma-confidence`) scores how likely a release is to pass its acceptance recipe on one supported profile. The server runs it as a committed wasm module ([`@lemma/confidence`](../packages/confidence/README.md)) to fill the catalog read model. The dashboard only displays the number.

A Stylus contract runs the same crate on Arbitrum, and the warranty registry records each finalized pass or failure into it. The server takes exactly the outcomes the engine recorded from the registry events it indexed, so the contract and the catalog compute the same number from the same prior, outcomes, and time. The catalog shows the distinct buyers behind those outcomes (see [Reputation and Confidence](reputation-and-confidence.md)). The contract is not deployed yet.

### Warranty registry

The Arbitrum Sepolia contract holds provider bond, activates signed warranty vouchers, records evaluator outcomes, and creates buyer withdrawal credit. It is written and tested but not deployed. It stores identifiers and accounting state rather than repository or patch content, and never a buyer or payer address: a failed warranty's credit goes to whoever proves the claim secret committed in the voucher. Anyone may relay its signed messages, so agents need no ETH. A finalized pass or failure is also passed to an optional compatibility engine (`ICompatibilityEngine.record`). See the [contracts guide](../contracts/README.md).

## Trust boundaries

- The coding agent chooses tools but cannot authorize payment from prose alone.
- The bridge trusts reviewed local code and configured endpoints, not model output.
- The bridge never holds a wallet secret. The signer holds the buyer key and signs only within its own policy.
- The server receives typed repository metadata, not source by default.
- The catalog is curated and validated before it can influence a preview.
- Provider, facilitator, evaluator, buyer, and deployer identities are separate roles. The server holds the provider and evaluator keys for the MVP, and each sends its own transactions. Neither is the facilitator or the attester, so no sender's transaction order joins a settlement to the warranty it paid for.
- The ERC-8004 attester key only publishes feedback: it holds gas and nothing else, and it is not the key that owns the provider's agent.
- The evaluator is trusted for MVP pass and failure attestations. The server finalizes only on a verified receipt, and holds failures for an operator's decision by default.
- The dashboard is informational and cannot mutate product or chain state.

## End-to-end flow

Every step is implemented and runs end to end on a local chain (`npm run e2e`). The contracts are not deployed on Arbitrum Sepolia yet.

1. The agent calls the bridge's `lemma_preview` tool with a typed capability.
2. The bridge reads allowlisted package metadata and asks the server for a free preview.
3. The resolver checks the frozen catalog snapshot and returns `reuse`, `build`, or `decline`. The bridge may later return `adapt` after local drift checks.
4. The agent calls `lemma_buy_resolution`. The bridge checks the open offer with core `checkPurchase` against its spend ledger (quote expiry, scheme, chain, token, recipient, authorization lifetime, per-purchase and daily caps), reserves the amount, and marks the purchase pending.
5. The bridge derives the EIP-3009 nonce and the x402 requirements from the preview's own terms and asks the signer for the authorization in Arbitrum Sepolia USDC. The signer checks its own policy and signs.
6. One paid MCP call carries the payment. The server's in-process facilitator verifies it, the paid tool's handler prepares the resolution, and the facilitator settles USDC to the provider. A refusal by the handler cancels settlement.
7. The server commits the resolution. A settlement the call could not confirm is committed later by the reconciler from USDC's log; one that never happened expires. After a random delay, the server activates the warranty on chain as the provider: its signed voucher reserves bond equal to the price.
8. The bridge stores the delivery after checking it against the offer, or recovers a lost paid response for free; it never pays twice. It verifies the manifest and bundle, and previews or applies it.
9. The bridge runs the reviewed acceptance recipe and creates an Adoption Receipt, which the signer signs.
10. The server records the receipt and checks its signature against the buyer. For a verified receipt, it finalizes the outcome on chain as the evaluator (a failure after an operator's decision by default), and the registry records a pass or failure into the compatibility engine. A warranty without a verified receipt expires at its claim deadline, and the bond returns to the provider.
11. The server's indexer reads the registry's events. The catalog's confidence counts the outcomes the engine recorded, and Lemma's attester posts each finalized pass or failure with a weight above zero as ERC-8004 feedback to the provider's agent, and to the buyer's agent if it opted in and the paying address controls it. Previews and the catalog show the cached pass rate and count.
12. A FAILED outcome leaves the buyer a credit. The bridge's `lemma_claim_refund` posts the claim to the server, which relays `withdrawCredit` as the evaluator, and the credit reaches the refund address the buyer committed to.

Nothing on an agent's tool call reads or writes the chain except the payment itself; a preview's reputation record and a resolution's warranty come from the server. The agent never holds ETH: the facilitator pays settlement gas, and the provider and evaluator pay the warranty's. See [Server Runtime](server-runtime.md) and [Bridge Runtime](bridge-runtime.md) for the paid path's details.

## Hosted interfaces

The MCP endpoint uses stateless Streamable HTTP with one JSON-RPC message per request. `GET`, `DELETE`, batches, browser origins, oversized input, and invalid schemas are rejected.

The bridge is the intended MCP client. Agents receive the bridge's small text tools rather than the remote server tools. Interest sets and base probes are cached so a warm preview normally requires one hosted request.

The server also exposes typed, read-only HTTP APIs for releases, catalog state, demand, resolutions, service status, and health. See the [Server guide](../apps/server/README.md) for the route list.

## Data model

All components import strict versioned schemas from `@lemma/core`. Content objects use typed Keccak-256 digests over canonical JSON. USDC travels as atomic-unit decimal strings. Frozen vectors keep other encoders compatible.

See [Protocol](protocol.md) for identifiers, evidence binding, pricing, and receipt rules.

## Persistence

Postgres stores immutable releases and bundles, catalog snapshots, offer-bearing previews, prepared and settled resolutions with the buyer's warranty claim hash, adoption receipts with their signature verdict and the buyer's opted-in ERC-8004 agent id, the ERC-8004 attester's ledger (one feedback per finalized outcome and target, with its feedback file's bytes), the warranty outbox (one action per resolution and kind, with the signed voucher or outcome it sends), the warranty registry's indexed events and the indexer's cursor, and privacy-thresholded demand data.

`ResolutionService` is the payment integration seam. Conditional transitions prevent duplicate preparation, payment reuse, and duplicate settlement. Settlement is keyed by the payment authorization, not the transaction, since one transaction can carry several authorizations. The reconciler commits or expires a row only by the authorization it checked, and commits it only when that authorization's transaction paid the quoted amount to the quoted payee.

Registry events are stored idempotently, keyed by transaction hash and log index, and the indexer's cursor moves in the same step as the rows it read.

## Failure behavior

- No match produces no payment offer.
- A local policy failure produces no payment signature, in the bridge and again in the signer.
- Catalog, configuration, or migration failure prevents server startup.
- Settlement uncertainty is resolved by the reconciler from the chain, not by paying again.
- Lost paid responses are recovered with the preview secret and buyer.
- Patch drift stops direct application and returns an adaptation path.
- An interrupted apply is recovered from its local journal.
- Missing evaluator confirmation leaves a warranty active until expiry. A registry pause also stops the claim clock (see [Pause and the claim clock](../contracts/README.md#pause-and-the-claim-clock)).
- Expiry releases reserved bond without asserting software success.
- A warranty job that fails backs off and retries. A crash between a send and its record never sends twice, because the next attempt reads the transaction's receipt, the sender's nonces, and the registry's state first. A release whose bond runs short is retried for a day, then abandoned with an alert.
