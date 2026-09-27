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
- Buyer signer (`lemma-signer`).
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
- A local process abusing the buyer signer (bounded by the signer's policy; see below).
- A server changing the price or recipient after the quote (the bridge signs only the terms of the preview it checked and never pays a challenge; the signer signs only to allowlisted payees within its caps).
- Forged provider vouchers or evaluator outcomes.
- Provider withdrawal of bond backing an active resolution.
- Buyer fabrication of failure evidence.
- Server-side request forgery through provenance or icon URLs.
- Cross-site scripting through catalog or chain metadata.
- SQL injection, mass assignment, and direct-object access bugs.
- Secrets in logs, benchmark records, source maps, or container layers.

## Required controls

- Spending policy is enforced in code before signing, twice: by the bridge against its ledger, and by the signer against its own.
- Every paid and signed object uses strict versioned schemas.
- The bridge sends allowlisted metadata rather than source by default.
- Path confinement and atomic patch application protect the workspace. The bridge never writes through a link, applies through one journal per repository kept outside the workspace (all or nothing, checked while held, rolled back after a crash), never replaces a file that changed after the plan was checked, and installs dependency changes with lifecycle scripts, pnpmfiles and yarn builds disabled, without wallet secrets or the bridge's settings in their environment. A recorded install is killed before a rollback only when it is verified to be the same process; otherwise the journal is kept rather than undone under it. A rollback never overwrites a bundle file edited after the apply; it keeps the original instead. package.json and the lockfiles are put back as they were before an interrupted install, and what they held is kept and reported. A journal that could not be fully undone is retried only for the steps that failed. Patches cannot touch package manifests, lockfiles, dotfiles or `node_modules` (core `PatchPath`), so a release cannot change the scripts its own acceptance recipe runs.
- Acceptance recipes run only when the run is evidence about the resolution (it is in place, the package still fits the profile it was bought for, and the recipe's script exists), without a shell, with only a minimal `PATH`, a fresh `HOME`, the user's corepack cache (`COREPACK_HOME`, with corepack's downloads off; the tests can write to it) and the variables the recipe lists, under the recipe's timeout, and with output capped and only digested; no acceptance output or recipe argument reaches the model. They are still the release's and the buyer's code running as the user: the network is on unless offline mode is used, writes are not confined to the package, and the user's real home and the bridge's start environment (`/proc`) are readable. The bridge therefore refuses to run them while a wallet secret is in its environment or the one it started with (the same names installs never get). The bridge never holds the buyer key: `lemma-signer` does (see the signer threat model below). A key file the user can read is readable by the tests as well, so for real isolation the signer runs as another user, or is replaced by a hardware or remote signer behind the same interface.
- Settlement and recovery are idempotent.
- Typed signatures bind chain, contract, buyer, release, payload, amount, expiry, and nonce.
- Contract accounting reserves bond before a warranty becomes active.
- Browser rendering escapes untrusted values and restricts external destinations.
- Database operations are parameterized and resource access uses non-guessable identifiers.
- Logs and run records are scrubbed before persistence.
- Agent-facing answers are built from enums, numbers, codes and bundle paths. Paths are chosen by the release, so they are validated (core `PatchPath`) and shown only when short (at most 100 characters, segments of at most 40, 120 characters of paths per answer); a release can put no more than a few short file names in front of the model.
- Preview IDs are bearer secrets for recovery. They are random, returned only to the requesting bridge, never logged, and never exposed by a read API. Recovery needs the preview ID and the buyer, so a published resolution ID recovers nothing.
- Adoption receipts are accepted only from the buyer (the holder of the preview id), only for settled resolutions, and once each. They count for nothing until the receipt verifier has checked their signature against the resolution's buyer (viem `verifyTypedData` on a public client, so smart accounts verify too); an unsigned receipt or another signer's stays unverified.
- One payment authorization backs one resolution and settles it once, and the reconciler's decisions are bound to the authorization it checked. Settlement is keyed by the authorization, not the transaction: anyone may submit EIP-3009 authorizations, so one transaction can use several, each a payment for its own resolution, and each of those resolutions settles. The EIP-3009 nonce is derived from the resolution and the preview id (core `derivePaymentNonce`), so USDC itself refuses a second payment for a resolution, and the public nonce cannot be joined to the public resolution id without the preview id. The server refuses any other nonce before settling.
- The paid handler takes the payer, nonce and window only from the x402-verified payment, never from tool arguments, and any refusal cancels settlement. Only a payload that is exactly an EIP-3009 authorization and its signature is verified at all: x402's exact EVM facilitator picks its verify and settle path from the payload's shape, so a Permit2 payload is refused before verification (and again by the handler), rather than having its permit verified while an unverified `authorization` beside it names the payer. No-match previews are never stored, so nothing can be bought from them.
- Warranty credits are claimed with a per-purchase secret. Only `warrantyClaimHash(resolutionId, secret, refundTo)` reaches the server and the registry; the secret and the refund address stay in the buyer's inbox (`claims/`, mode 0600). Withdrawing a credit does show the refund address next to the public resolution id on chain, so it is the buyer's address only by default: `LEMMA_REFUND_TO` names another address the user controls, and the bridge says so on stderr while it is unset.
- The facilitator runs in process and has no public endpoint, so its key pays gas only for Lemma's own settlements. Its key and the RPC URL (which usually carries a provider API key) are held as secrets that print as placeholders; config errors never repeat them, and every RPC error is scrubbed of URLs before x402 or viem can print it. What the facilitator hands back to x402 keeps reason codes only: failure messages are dropped and thrown errors lose every long hex string, so the server's output never pairs a payer, nonce or signature with a resolution id.
- The server logs and returns database errors by name and code (SQLSTATE, or a connection code such as ECONNREFUSED) only, never their text, which carries SQL parameters or the connection string. Every store call is wrapped, so the paid path that calls the ResolutionService receives the same code-only error.
- Demand is counted as distinct profile digests, salted with a daily secret, and distinct client addresses, keyed with a secret held outside the database and then salted, so neither the database nor a backup of it can recover an address by trying every IPv4 value. Both are collapsed to counts when the day closes, and published only for buckets with at least five of each. A caller can make up profiles freely, so the address count is what makes a single prober's bucket stay hidden; a prober with many addresses can still inflate a count, so demand is a roadmap signal, not a metric to pay on. Buckets carry a coarse repository class, never dependency names or versions.
- The hosted MCP endpoint refuses browser-originated requests (any `Origin` header), limits bodies to 256 KB, and rate-limits per client address taken from the trusted proxy hop.

## Signer threat model

`lemma-signer` holds the buyer key so the bridge, and the installs and acceptance tests it starts, never have it in their environment or memory.

- **Who can reach it.** Any process of the same user can connect to the signer's Unix socket (mode 0600 in a 0700 directory), including the release's acceptance tests, the dependency installs, and anything else the user runs. The socket is not an authentication boundary. Its directory must not be writable by anyone else (the signer refuses one its user does not own or its group or others can write to, such as `/tmp`, and the bridge refuses one its group or others can write to), so no other user can listen at the path first and answer as the signer.
- **So the signer enforces the policy.** It signs only USDC `TransferWithAuthorization` on Arbitrum Sepolia (chain, token and EIP-712 domain are its own constants), only to an allowlisted payee (`LEMMA_ALLOWED_PAY_TO`), only within the per-purchase cap, the rolling 24-hour cap over its own ledger, and a window of 10 to 600 seconds; and Lemma Adoption Receipt typed data. A nonce signed again counts once, since USDC executes at most one authorization per nonce.
- **Worst case.** A hostile local process can make the signer sign purchases within the caps to the allowlisted payee, and no more. Funds can only reach the payee, so it cannot take money for itself; it can waste up to the daily cap, or use the cap up so that real purchases are refused for a day. It can also have receipts signed for this buyer's resolutions, so a receipt proves the buyer's signer signed it, not that the buyer's tests passed; the evaluator's finalization is what the warranty trusts.
- **The key file.** The signer reads the key from the file `LEMMA_SIGNER_KEY_FILE` names (default `<state>/signer/key`); the key itself is never in the environment or an argument. It refuses a link, a file others can read, or one another user owns, and opens the file without following links. A file the user can read is still readable by the user's other processes: run the signer as a separate user (socket mode 0660 with a shared group) for isolation from acceptance tests, or use a hardware or remote signer.
- **What it never does.** It never returns or logs the key, never signs arbitrary typed data or transactions, and never reads the chain.

## Accepted MVP trust

The evaluator is a separate team-operated key, not decentralized arbitration. External pilots use public repositories so the evaluator can inspect evidence without receiving private source. The server and provider remain first-party infrastructure.

These assumptions must be visible in the dashboard and submission. The MVP demonstrates an economic mechanism, not trustless software correctness.

## Deferred controls

- Independent evaluator markets.
- Hardware-backed or threshold provider signing.
- Sandboxed reproduction of arbitrary private repositories.
- Formal contract verification.
- Production incident response and key rotation automation.
