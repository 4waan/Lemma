# Security Model

## Protected assets

- Buyer, provider, facilitator, evaluator, and deployer private keys.
- Buyer spending authority and daily budget.
- Provider bond and buyer refund credits.
- Resolution payload integrity.
- Repository confidentiality and workspace integrity.
- Payment, warranty, and outcome idempotency.
- Benchmark evidence and public claims.

## Actors

- Buyer and buyer coding agent.
- Local MCP bridge.
- Lemma server and database.
- Capability provider.
- x402 facilitator.
- Outcome evaluator.
- Arbitrum Sepolia contracts and RPC providers.
- Public dashboard visitor.

## Principal threats

- Prompt injection persuading the agent to pay or expose secrets.
- A malicious or corrupted release writing outside the workspace.
- Duplicate settlement after a timeout or lost response.
- Forged provider vouchers or evaluator outcomes.
- Provider withdrawal of bond backing an active resolution.
- Buyer fabrication of failure evidence.
- Server-side request forgery through provenance or icon URLs.
- Cross-site scripting through catalog or chain metadata.
- SQL injection, mass assignment, and direct-object access bugs.
- Secrets in logs, benchmark records, source maps, or container layers.

## Required controls

- Spending policy is enforced in code before signing.
- Every paid and signed object uses strict versioned schemas.
- The bridge sends allowlisted metadata rather than source by default.
- Path confinement and atomic patch application protect the workspace.
- Settlement and recovery are idempotent.
- Typed signatures bind chain, contract, buyer, release, payload, amount, expiry, and nonce.
- Contract accounting reserves bond before a warranty becomes active.
- Browser rendering escapes untrusted values and restricts external destinations.
- Database operations are parameterized and resource access uses non-guessable identifiers.
- Logs and run records are scrubbed before persistence.
- Preview IDs are bearer secrets for recovery. They are random, returned only to the requesting bridge, never logged, and never exposed by a read API. Recovery needs the preview ID and the buyer, so a published resolution ID recovers nothing.
- Adoption receipts are accepted only from the buyer (the holder of the preview id), only for settled resolutions, and once each. They count for nothing until their signature is verified.
- One payment authorization backs one resolution, one settlement settles one resolution, and the reconciler's decisions are bound to the authorization it checked.
- The server logs and returns database errors by name and code (SQLSTATE, or a connection code such as ECONNREFUSED) only, never their text, which carries SQL parameters or the connection string. Every store call is wrapped, so the payment work that calls the ResolutionService receives the same code-only error.
- Demand is counted as distinct profile digests, salted with a daily secret, and distinct client addresses, keyed with a secret held outside the database and then salted, so neither the database nor a backup of it can recover an address by trying every IPv4 value. Both are collapsed to counts when the day closes, and published only for buckets with at least five of each. A caller can make up profiles freely, so the address count is what makes a single prober's bucket stay hidden; a prober with many addresses can still inflate a count, so demand is a roadmap signal, not a metric to pay on. Buckets carry a coarse repository class, never dependency names or versions.
- The hosted MCP endpoint refuses browser-originated requests (any `Origin` header), limits bodies to 256 KB, and rate-limits per client address taken from the trusted proxy hop.

## Accepted MVP trust

The evaluator is a separate team-operated key, not decentralized arbitration. External pilots use public repositories so the evaluator can inspect evidence without receiving private source. The server and provider remain first-party infrastructure.

These assumptions must be visible in the dashboard and submission. The MVP demonstrates an economic mechanism, not trustless software correctness.

## Deferred controls

- Independent evaluator markets.
- Hardware-backed or threshold provider signing.
- Sandboxed reproduction of arbitrary private repositories.
- Formal contract verification.
- Production incident response and key rotation automation.
