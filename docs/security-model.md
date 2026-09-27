# Security Model

## Protected assets

- Buyer, provider, facilitator, evaluator, and deployer private keys.
- The ERC-8004 attester key (Lemma's public reviewer identity) and the provider agent's owner key.
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
- The ERC-8004 identity and reputation registries (Draft, and upgradeable by their maintainers), and whoever reads Lemma's feedback there.
- Public dashboard visitor.

## Principal threats

- Prompt injection persuading the agent to pay or expose secrets.
- A malicious or corrupted release writing outside the workspace.
- Duplicate settlement after a timeout or lost response.
- A local process abusing the buyer signer (bounded by the signer's policy; see below).
- A server changing the price or recipient after the quote (the bridge signs only the terms of the preview it checked and never pays a challenge; the signer signs only to allowlisted payees within its caps).
- Forged provider vouchers or evaluator outcomes.
- Provider withdrawal of bond backing an active resolution.
- A registry pause that lets a buyer's claim window run out.
- A leaked resolution ID or payment reference activated first on another release.
- Buyer fabrication of failure evidence.
- Server-side request forgery through provenance or icon URLs.
- Cross-site scripting through catalog or chain metadata.
- SQL injection, mass assignment, and direct-object access bugs.
- Secrets in logs, benchmark records, source maps, or container layers.
- Wash adoption: a provider, or anyone paid by one, buying its own release to inflate its public pass rate.
- A buyer directing Lemma's attestations at an agent it does not control, to praise or smear it.
- Theft of the attester key, which would let a thief post feedback as Lemma's reviewer identity.
- A public record that joins a wallet to what it bought.
- A warranty activation that can be joined to the payment behind it, by a derived payment reference, the sender's transaction order, a published time, or the amount and timing on chain (only partly addressed; see activation timing below).
- A release's acceptance tests posting a passing receipt the buyer never saw (see the known gap below).
- Theft of the provider key, which receives every settled payment and can withdraw every unreserved bond, or of the evaluator key, which decides outcomes and so refunds.

## Required controls

- Spending policy is enforced in code before signing, twice: by the bridge against its ledger, and by the signer against its own.
- Every paid and signed object uses strict versioned schemas.
- The bridge sends allowlisted metadata rather than source by default.
- Path confinement and atomic patch application protect the workspace. The bridge never writes through a link, applies through one journal per repository kept outside the workspace (all or nothing, checked while held, rolled back after a crash), never replaces a file that changed after the plan was checked, and installs dependency changes with lifecycle scripts, pnpmfiles and yarn builds disabled, without wallet secrets or the bridge's settings in their environment. A recorded install is killed before a rollback only when it is verified to be the same process; otherwise the journal is kept rather than undone under it. A rollback never overwrites a bundle file edited after the apply; it keeps the original instead. package.json and the lockfiles are put back as they were before an interrupted install, and what they held is kept and reported. A journal that could not be fully undone is retried only for the steps that failed. Patches cannot touch package manifests, lockfiles, dotfiles or `node_modules` (core `PatchPath`), so a release cannot change the scripts its own acceptance recipe runs.
- Acceptance recipes run only when the run is evidence about the resolution (it is in place, the package still fits the profile it was bought for, and the recipe's script exists), without a shell, with only a minimal `PATH`, a fresh `HOME`, the user's corepack cache (`COREPACK_HOME`, with corepack's downloads off; the tests can write to it) and the variables the recipe lists, under the recipe's timeout, and with output capped and only digested; no acceptance output or recipe argument reaches the model. They are still the release's and the buyer's code running as the user: the network is on unless offline mode is used, writes are not confined to the package, and the user's real home and the bridge's start environment (`/proc`) are readable. The bridge therefore refuses to run them while a wallet secret is in its environment or the one it started with (the same names installs never get). The bridge never holds the buyer key: `lemma-signer` does (see the signer threat model below). A key file the user can read is readable by the tests as well, so for real isolation the signer runs as another user, or is replaced by a hardware or remote signer behind the same interface.
- Settlement and recovery are idempotent.
- Typed signatures bind chain, contract, buyer, release, payload, amount, expiry, and nonce.
- The warranty registry reserves bond before a warranty becomes active, never lets a provider withdraw reserved bond, stores no buyer or payer address, and pays a failure credit only to the refund address committed in the claim hash. A pause also stops the claim clock. Unit, fuzz, and invariant tests cover it; see the [contracts guide](../contracts/README.md#invariants).
- Browser rendering escapes untrusted values and restricts external destinations.
- Database operations are parameterized and resource access uses non-guessable identifiers.
- Logs and run records are scrubbed before persistence.
- Agent-facing answers are built from enums, numbers, codes and bundle paths. Paths are chosen by the release, so they are validated (core `PatchPath`) and shown only when short (at most 100 characters, segments of at most 40, 120 characters of paths per answer); a release can put no more than a few short file names in front of the model.
- Preview IDs are bearer secrets for recovery. They are random, returned only to the requesting bridge, never logged, and never exposed by a read API. Recovery needs the preview ID and the buyer, so a published resolution ID recovers nothing. Still, keep a resolution ID and its payment reference private until the warranty is active on chain: the registry keys warranties by those values alone, so a provider of another release that learned one first could activate it on its own release and block the real warranty. The activator never takes such an activation for its own: unless the registry holds the voucher's release, profile and amount, it closes the action as `FOREIGN_ACTIVATION` and logs `warranty.foreign_activation` at error level.
- Adoption receipts are accepted only from the buyer (the holder of the preview id), only for settled resolutions, and once each. They count for nothing until the receipt verifier has checked their signature against the resolution's buyer (viem `verifyTypedData` on a public client, so smart accounts verify too); an unsigned receipt or another signer's stays unverified.
- One payment authorization backs one resolution and settles it once, and the reconciler's decisions are bound to the authorization it checked. Settlement is keyed by the authorization, not the transaction: anyone may submit EIP-3009 authorizations, so one transaction can use several, each a payment for its own resolution, and each of those resolutions settles. The EIP-3009 nonce is derived from the resolution and the preview id (core `derivePaymentNonce`), so USDC itself refuses a second payment for a resolution, and the public nonce cannot be joined to the public resolution id without the preview id. The server refuses any other nonce before settling.
- The reconciler settles a row only when the transaction that used its authorization paid the quoted terms: the log right after USDC's `AuthorizationUsed` must be USDC's `Transfer` of exactly the quoted amount from the buyer to the quoted payee. EIP-3009 nonces are the signer's to choose, so a buyer can spend the derived nonce on a transfer of their own before the settlement lands; such a row expires, and recovery never delivers it.
- The paid handler takes the payer, nonce and window only from the x402-verified payment, never from tool arguments, and any refusal cancels settlement. Only a payload that is exactly an EIP-3009 authorization and its signature is verified at all: x402's exact EVM facilitator picks its verify and settle path from the payload's shape, so a Permit2 payload is refused before verification (and again by the handler), rather than having its permit verified while an unverified `authorization` beside it names the payer. No-match previews are never stored, so nothing can be bought from them.
- Warranty credits are claimed with a per-purchase secret. Only `warrantyClaimHash(resolutionId, secret, refundTo)` reaches the server and the registry; the secret and the refund address stay in the buyer's inbox (`claims/`, mode 0600). Withdrawing a credit does show the refund address next to the public resolution id on chain, so it is the buyer's address only by default: `LEMMA_REFUND_TO` names another address the user controls, the bridge says so on stderr while it is unset, and `lemma_claim_refund` says so in its answer when a refund it asks for pays the wallet that paid.
- The facilitator runs in process and has no public endpoint, so its key pays gas only for Lemma's own settlements. Its key and the RPC URL (which usually carries a provider API key) are held as secrets that print as placeholders; config errors never repeat them, and every RPC error is scrubbed of URLs before x402 or viem can print it. What the facilitator hands back to x402 keeps reason codes only: failure messages are dropped and thrown errors lose every long hex string, so the server's output never pairs a payer, nonce or signature with a resolution id.
- The server logs and returns database errors by name and code (SQLSTATE, or a connection code such as ECONNREFUSED) only, never their text, which carries SQL parameters or the connection string. Every store call is wrapped, so the paid path that calls the ResolutionService receives the same code-only error.
- Demand is counted as distinct profile digests, salted with a daily secret, and distinct client addresses, keyed with a secret held outside the database and then salted, so neither the database nor a backup of it can recover an address by trying every IPv4 value. Both are collapsed to counts when the day closes, and published only for buckets with at least five of each. A caller can make up profiles freely, so the address count is what makes a single prober's bucket stay hidden; a prober with many addresses can still inflate a count, so demand is a roadmap signal, not a metric to pay on. Buckets carry a coarse repository class, never dependency names or versions.
- The hosted MCP endpoint refuses browser-originated requests (any `Origin` header), limits bodies to 256 KB, and rate-limits per client address taken from the trusted proxy hop.
- ERC-8004 feedback files never name the buyer or payer, the preview id, the payment nonce, or the settlement, and the attester key only publishes feedback (see the reputation threat model below).
- The warranty pipeline signs only what the registry names, relays a buyer's claim only against its stored hash, and never sends twice (see the warranty pipeline threat model below).

## Signer threat model

`lemma-signer` holds the buyer key so the bridge, and the installs and acceptance tests it starts, never have it in their environment or memory.

- **Who can reach it.** Any process of the same user can connect to the signer's Unix socket (mode 0600 in a 0700 directory), including the release's acceptance tests, the dependency installs, and anything else the user runs. The socket is not an authentication boundary. Its directory must not be writable by anyone else (the signer refuses one its user does not own or its group or others can write to, such as `/tmp`, and the bridge refuses one its group or others can write to), so no other user can listen at the path first and answer as the signer.
- **So the signer enforces the policy.** It signs only USDC `TransferWithAuthorization` on Arbitrum Sepolia (chain, token and EIP-712 domain are its own constants), only to an allowlisted payee (`LEMMA_ALLOWED_PAY_TO`), only within the per-purchase cap, the rolling 24-hour cap over its own ledger, and a window of 10 to 600 seconds; and Lemma Adoption Receipt typed data. A nonce signed again counts once, since USDC executes at most one authorization per nonce.
- **Worst case.** A hostile local process can make the signer sign purchases within the caps to the allowlisted payee, and no more. Funds can only reach the payee, so it cannot take money for itself; it can waste up to the daily cap, or use the cap up so that real purchases are refused for a day. It can also have receipts signed for this buyer's resolutions, so a receipt proves the buyer's signer signed it, not that the buyer's tests passed; the evaluator's finalization is what the warranty trusts.
- **The key file.** The signer reads the key from the file `LEMMA_SIGNER_KEY_FILE` names (default `<state>/signer/key`); the key itself is never in the environment or an argument. It refuses a link, a file others can read, or one another user owns, and opens the file without following links. A file the user can read is still readable by the user's other processes: run the signer as a separate user (socket mode 0660 with a shared group) for isolation from acceptance tests, or use a hardware or remote signer.
- **What it never does.** It never returns or logs the key, never signs arbitrary typed data or transactions, and never reads the chain.

## Reputation threat model

The server's attester posts each finalized outcome as ERC-8004 feedback on Arbitrum Sepolia, each with a public feedback file (see the [Server guide](../apps/server/README.md#reputation)).

- **The attester key.** It signs every `giveFeedback` from one published address, the only reviewer Lemma's summaries count (`getSummary(agentId, [attester], ...)`). It is a hot server key that holds only testnet gas, and it is never logged or shown in errors (the config prints it as `[redacted]`). The key that owns the provider's agent must be a different key, kept off the server; [Deployment](deployment.md#role-separation) says how to keep the two apart.
- **Rotating the attester key.** If it leaks, rotate it. A new attester address makes a new summary filter, and feedback from the old address can be revoked by whoever holds it. Posts still pending under the old key are skipped (`FILE_MISMATCH`) rather than sent by the new one, because their files name the old address as the client. Readers should trust only the attester address Lemma publishes with its deployment record; the server also logs it at startup (`reputation.on`).
- **Feedback files.** Each feedback has its own public file, hashed on chain, in ERC-8004's off-chain feedback file format. It names the resolution, release, profile, capability, recipe digest, acceptance result, verdict and times, and the spec's required fields: the identity registry, the target agent, the client (Lemma's attester, public on chain anyway), the time, the value and its decimals. It never names the buyer or payer, the preview id, the payment nonce, or the settlement: core `AdoptionFeedbackFile` and the `AdoptionEvidence` under its `lemma` key are strict and have no field for them.
- **No proof of payment.** ERC-8004 suggests an optional `proofOfPayment` in the file for x402 payments (payer, payee, chain and payment transaction). Lemma leaves it out on purpose: it would publish every buyer's paying wallet next to what it bought, including buyers who never opted in. Every outcome the attester posts already needs a paid, settled resolution that Lemma checked itself, so readers rely on the attester's address instead.
- **Buyer agents.** Only a buyer that opted in with its own agent id is linked to its adoption on chain. The attester checks, off the request path, that the address that paid owns the agent or is its ERC-8004 agent wallet; otherwise the post is skipped, so a buyer cannot aim Lemma's attestations at someone else's agent. The agent id is stored with the receipt and shown by no read API except the buyer agent's own feedback file, which is served only after that check passed and a send has begun. The same rule means opting in publishes, on chain and for good, that the paying wallet adopted each resolution. The rule that Lemma's public records never name the buyer or payer therefore holds only for buyers who do not opt in; the bridge README and the dashboard's Setup page say so.
- **Idempotency.** One ledger row per resolution and target. An attempt is claimed before it is sent and looked for on chain before any resend, so a crash or a second replica never double-posts. [Server Runtime](server-runtime.md#erc-8004-reputation) describes the claim, the send deadline, and what the resend check needs from the RPC endpoint.
- **Wash adoption.** This is the main sybil risk: a provider that buys its own release gets most of its payment back, so it can buy passes cheaply. Every outcome needs a paid, settled resolution, a pinned acceptance recipe, and an evaluator's finalization, which raises the cost but does not stop a determined provider. Two more measures apply. The catalog publishes the distinct buyers next to every outcome count and pass rate, counted by the server from settled resolutions by payer, only from three up, and never naming a payer. The evaluator's damper gives weight 0 to a payer's outcomes on a release and profile beyond a set limit, so they reach neither the engine nor the attester, and the warranty itself is unchanged ([the damper](reputation-and-confidence.md#the-damper)). A provider with many wallets still gets past both; weighting outcomes by distinct, independently established buyer agents is still a plan. Read a pass rate with its count and buyers; it is a signal, not a guarantee.
- **The registries** are Draft and upgradeable by their maintainers, so they are a public mirror of outcomes. Bonds, refunds, and pricing never depend on them.

## Warranty pipeline threat model

The server activates, finalizes, and expires warranties and relays credit withdrawals on the warranty registry (see [Server Runtime](server-runtime.md#warranty-outcome-pipeline) and [Reputation and Confidence](reputation-and-confidence.md)).

- **Senders and keys.** The provider key signs vouchers and sends activations and expiries; the evaluator key signs outcomes and sends finalizations and credit withdrawals. Both are hot server keys, kept in values that print as placeholders, never logged, and never repeated by an error. The evaluator's holds testnet gas. The provider's holds more: `register-release` requires each release's `payTo` to be the provider's address, so every settled payment lands in its account, and the registry lets it withdraw any unreserved bond to any address (`withdrawUnreservedBond`). A thief with it takes the revenue and every unreserved bond; reserved warranties stay backed, but new activations then fail for want of bond. The operator sweeps its USDC to an address kept off the server (see [Operations](../ops/README.md#running-the-warranty-pipeline)). Configuration refuses any two of the provider, evaluator, facilitator, and attester keys that are one account: the registry refuses a provider that is its own evaluator, and a shared sender's transaction order would put a buyer's settlement next to the activation it paid for. Which key sends each call is fixed in code (`SENDER_OF`).
- **Activation timing, and what it does not hide.** The voucher's payment reference is 32 random bytes made once per resolution, never derived from the payer, the payment nonce, or the settlement, and the provider, not the facilitator, sends the activation. Each activation waits a random delay of up to `WARRANTY_ACTIVATION_JITTER_SECONDS` (default 300, from `crypto.randomInt`), so it is not timed with its settlement. No read API gives a resolution's time finer than the day (`ResolutionView.createdOn`); the precise time stays in the buyer's signed resolution and the server's row. That is all the delay does. `ResolutionActivated` publishes the resolution id and the amount, and the settlement is a public USDC transfer of the same amount to the release's payee, from the buyer's wallet, a few minutes earlier. The delay makes every such transfer in its window a candidate, so it hides a buyer only among other purchases at the same price in the same minutes. At low volume, as on testnet, there is often just one, and anyone can join the resolution to the wallet that paid for it. A longer delay (up to 86400) widens the window but delays the warranty. The bridge sends a claim with every purchase, so each resolution of a release registered on the registry has its id on chain.
- **Signing only what the registry names.** Before signing a voucher or an outcome, the jobs check on chain that the release is registered (and, for a voucher, active) with this server's provider and evaluator; otherwise nothing is signed. At startup the registry must hold the configured USDC and hash a probe voucher exactly as core does, or the server does not start.
- **Claim-secret relay.** The withdrawal route relays a buyer's claim only when `warrantyClaimHash(resolutionId, claimSecret, to)` equals the claim hash stored with the resolution and the indexed registry shows the credit outstanding. The secret can only pay the refund address it was committed with, so a relayer, the server included, cannot redirect a credit. The route refuses browser requests and is rate limited; the secret is never logged, and the outbox drops it and the address once the relay is over. The withdrawal itself shows both on chain, next to the resolution id.
- **Idempotency.** Every send is claimed in the outbox before it is broadcast, and every later attempt reads the recorded transaction's receipt, the sender's nonces, and the registry's state before sending again, so a crash never sends twice and an action someone else relayed is not repeated.
- **The evaluator's inputs.** The server finalizes only on a receipt whose signature it verified against the buyer, and never on an unverified or missing one: such a warranty runs to its expiry. With `EVALUATOR_FAILURES=review` (the default), an operator decides every failure, as FAILED or VOID, before anything is signed.
- **The index.** Every state, deadline, verdict, and transaction the server shows or acts on comes from the registry events it indexed. The indexer reads a block once, `WARRANTY_INDEXER_CONFIRMATIONS` blocks behind the head (default 64), and trusts that no reorg goes deeper and that its RPC node is never further behind (see [Server Runtime](server-runtime.md#the-indexer)). A wrong read could show a wrong state or feed the attester an outcome that never happened, but not change what a send does: the registry checks each call against its signature, claim, or deadline.

## Known gap: receipts from acceptance tests

Acceptance tests run as the buyer's own user, so they can reach the signer's socket and the bridge's state directory and post a signed receipt before the bridge does (the first receipt wins). A release's own tests could therefore claim a pass the buyer never saw, and that pass would count toward the warranty, the confidence, and the public record. Until the bridge runs acceptance tests with the socket and the state directory out of reach, failures and disputes rely on the evaluator.

## Accepted MVP trust

The evaluator is a separate team-operated key, not decentralized arbitration: the registry trusts its signature for every pass and failure, and so for every refund and public record. By default an operator reviews each failed outcome before the evaluator signs it; `EVALUATOR_FAILURES=auto` finalizes a verified failed receipt as FAILED without review. External pilots use public repositories so the evaluator can inspect evidence without receiving private source. The server and provider remain first-party infrastructure, and the server holds the provider's and the evaluator's keys.

The registry also trusts each provider to sign a voucher after payment and keep enough bond available, and its owner to unpause. USDC is centrally controlled: Circle can block a refund address or pause the token. The [contracts guide](../contracts/README.md#limits) lists the registry's other limits.

These assumptions must be visible in the dashboard and submission. The MVP demonstrates an economic mechanism, not trustless software correctness.

## Deferred controls

- Independent evaluator markets.
- Hardware-backed or threshold provider signing, and revenue paid to an address whose key is not on the server (today `payTo` must be the provider's hot key).
- Sandboxed reproduction of arbitrary private repositories.
- Formal contract verification.
- Production incident response and key rotation automation.
- Fork detection in the warranty indexer. It reads each block once, `WARRANTY_INDEXER_CONFIRMATIONS` blocks behind the head, and keeps no block hashes, so a reorg deeper than that depth, or an RPC node further behind, can leave a wrong or missing row in its index for good. Checking each stored range's block hash on the next run, and rewinding on a mismatch, would close it.
