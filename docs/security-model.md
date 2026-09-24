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

## Accepted MVP trust

The evaluator is a separate team-operated key, not decentralized arbitration. External pilots use public repositories so the evaluator can inspect evidence without receiving private source. The server and provider remain first-party infrastructure.

These assumptions must be visible in the dashboard and submission. The MVP demonstrates an economic mechanism, not trustless software correctness.

## Deferred controls

- Independent evaluator markets.
- Hardware-backed or threshold provider signing.
- Sandboxed reproduction of arbitrary private repositories.
- Formal contract verification.
- Production incident response and key rotation automation.
