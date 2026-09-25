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
- Path confinement and atomic patch application protect the workspace. The bridge never writes through a link, applies through one journal per repository kept outside the workspace (all or nothing, checked while held, rolled back after a crash), never replaces a file that changed after the plan was checked, and installs dependency changes with lifecycle scripts, pnpmfiles and yarn builds disabled, without wallet secrets or the bridge's settings in their environment. A recorded install is killed before a rollback only when it is verified to be the same process; otherwise the journal is kept rather than undone under it. A rollback never overwrites a bundle file edited after the apply; it keeps the original instead. package.json and the lockfiles are put back as they were before an interrupted install, and what they held is kept and reported. A journal that could not be fully undone is retried only for the steps that failed. Patches cannot touch package manifests, lockfiles, dotfiles or `node_modules` (core `PatchPath`), so a release cannot change the scripts its own acceptance recipe runs.
- Acceptance recipes run only when the run is evidence about the resolution (it is in place, the package still fits the profile it was bought for, and the recipe's script exists), without a shell, with only a minimal `PATH`, a fresh `HOME`, the user's corepack cache (`COREPACK_HOME`, with corepack's downloads off; the tests can write to it) and the variables the recipe lists, under the recipe's timeout, and with output capped and only digested; no acceptance output or recipe argument reaches the model. They are still the release's and the buyer's code running as the user: the network is on unless offline mode is used, writes are not confined to the package, and the user's real home and the bridge's start environment (`/proc`) are readable. The bridge therefore refuses to run them while a wallet secret is in its environment or the one it started with (the same names installs never get). A key file the user can read is readable by the tests as well, so the buyer key belongs with a signer running as another user, or on a hardware or remote signer.
- Settlement and recovery are idempotent.
- Typed signatures bind chain, contract, buyer, release, payload, amount, expiry, and nonce.
- Contract accounting reserves bond before a warranty becomes active.
- Browser rendering escapes untrusted values and restricts external destinations.
- Database operations are parameterized and resource access uses non-guessable identifiers.
- Logs and run records are scrubbed before persistence.
- Agent-facing answers are built from enums, numbers, codes and bundle paths. Paths are chosen by the release, so they are validated (core `PatchPath`) and shown only when short (at most 100 characters, segments of at most 40, 120 characters of paths per answer); a release can put no more than a few short file names in front of the model.
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
