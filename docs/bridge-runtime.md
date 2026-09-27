# Bridge Runtime

The local bridge is Lemma's authority boundary for repository access, buyer state, patch application, and acceptance evidence. This document records the mechanics that are too detailed for the component README.

## Repository profiling

The bridge finds a real package directory, reads an allowlisted set of manifests and lockfiles, and builds a typed `RepositoryProfile`. It does not send repository source, internal package names outside the catalog interest set, environment files, Git internals, or credentials.

Monorepo package selection is explicit. Parent traversal, dotfile segments, symbolic links, and directories without their own `package.json` are rejected.

Before a purchase, the bridge fetches the release's base probe and hashes the relevant local files. A changed, missing, oversized, linked, or unexpected path is reported as drift without uploading its contents.

## Adoption record in previews

When a release matched, the server may add its capability's public adoption record to the preview result as `_meta["lemma/reputation"]`, `{ passBps, count }`. The bridge parses it with core `ReleaseReputation`; a missing or malformed record reads as none and never fails the preview, and a no-match preview never shows one. The answer then ends with ` Record: pass <p>%, n <count>.`, numbers only. The pass rate comes from basis points and is never rounded up (`9750` is `97.5%`, `9999` is `99.99%`), and the count is how many finalized adoptions Lemma's attester posted. The record is left out whole when adding it would take the answer past 600 characters.

## Purchasing

`lemma_buy_resolution` is registered only when a signer answers at `LEMMA_SIGNER_SOCKET` (default `<state>/signer/signer.sock`) in a directory nobody else can write to, the spending policy variables parse, and `LEMMA_REFUND_TO`, when set, is a usable address. Otherwise the bridge says on stderr why purchases are off. One purchase is one MCP call, and nothing on it reads or writes the chain:

1. The offer is the open one from the last preview for the capability: no drift, not expired by the monotonic or the wall clock, and no purchase of that release pending or stored. With `package`, that preview must have been for the same package.
2. Core `checkPurchase` runs against the bridge's spend ledger, and the price is reserved in it, under the ledger's lock. A refusal (`EXCEEDS_PER_RESOLUTION`, `EXCEEDS_DAILY_CAP`, `WRONG_RECIPIENT`, and so on) signs and sends nothing.
3. The purchase is marked pending in the inbox, so a lost answer is recovered rather than paid again.
4. The nonce (core `derivePaymentNonce`) and the x402 requirements (core `paymentRequirementsFor`) come from the preview's own terms, so no challenge round trip is needed.
5. A warranty claim is made once per resolution: a random 32-byte secret and a refund address (the buyer's, or `LEMMA_REFUND_TO`), kept as a core `WarrantyClaim` in `claims/<resolutionId>.json` with mode 0600. Only its hash is sent, and a retry sends the same one.
6. The signer signs the `TransferWithAuthorization` after checking its own policy. The authorization is valid for the quoted window less a minute (never under half of it), which gives a buyer clock running fast up to two minutes of room before the server refuses the window.
7. The paid call carries the payment in `_meta["x402/payment"]`. A delivery is stored only if its resolution matches the preview id, release, profile digest, buyer, and terms; the ledger entry then becomes settled.

When signing fails, no signature left the signer, so the bridge removes the pending mark and releases the reservation, unless an earlier signature for the same nonce still holds it. A server refusal code means nothing was charged. A 402 challenge is checked with `checkPurchase` and never paid. `IN_FLIGHT`, `ALREADY_SETTLED`, a settlement failure, or a lost or timed-out answer triggers the free recovery instead, so a purchase is never paid twice. A pending mark the server never saw is dropped after 15 minutes, once no authorization could still settle. Answers are short text with codes and numbers only, at most 600 characters.

### Buyer signer

`lemma-signer` is a separate process that holds the buyer key, so neither the bridge nor the installs and acceptance tests it starts ever have it. `lemma-signer init` creates the key file (mode 0600 in a 0700 directory, never overwritten) and prints only the address to fund. `lemma-signer serve` refuses a key file that is a link, that its group or others can access, or that another user owns. It serves JSON over HTTP on a Unix socket: `GET /address`, `POST /sign/transfer-authorization`, and `POST /sign/adoption-receipt`. A refusal answers 403 with its code.

Every process of the user can reach the socket, so the signer enforces the spending policy itself, with its own ledger. It signs only USDC `TransferWithAuthorization` on Arbitrum Sepolia, only to `LEMMA_ALLOWED_PAY_TO`, within the per-purchase cap, the rolling 24-hour cap, and a window of 10 to 600 seconds; and Adoption Receipt typed data. The socket's directory must be a real directory that the signer's user owns and that neither its group nor others can write to; the bridge also refuses a socket directory its group or others can write to. The socket is mode 0600, or 0660 for a signer run as another user that shares a group with the bridge. The signer logs one JSON line per signature or refusal, never the key or a signature.

The bridge reaches the signer through a `Signer` interface, so a hardware or remote signer can take its place.

### Spend ledger

The bridge keeps committed spend per payment nonce in `<state>/ledger/spend.json`; the signer keeps its own under `<state>/signer/ledger/`. Every read-check-write runs under an exclusive lock file that holds its owner's pid and a random token, so two bridges on one state directory cannot both reserve. A stale lock is broken only under a second exclusive file, and only while it still holds the token judged stale. The file is replaced atomically, and a damaged ledger refuses further spending.

A signed authorization stays counted for 24 hours even when its purchase failed, because only the chain could prove it unspent and the bridge never reads the chain. The nonce is derived from the resolution, so a retry counts once.

## Resolution selection

Apply and verify select the newest applicable purchase for the requested capability and package. A still-settling purchase takes priority and is recovered first. A purchase already associated with the package remains associated after a merge or dependency install, provided the package still fits the release profile.

The bridge stores manifests by digest. If a required manifest is missing locally, it fetches and validates the immutable server copy rather than trusting an older purchase.

## Preview, adapt, and apply

Preview mode reports file additions, modifications, deletions, and dependency changes without writing.

If the repository differs from the bundle's base, the bridge returns `adapt`. It exports the purchased resolution into bridge state for the agent to merge manually. Verification then requires an explicit `adapted: true` signal.

Apply mode is all-or-nothing. One journal is allowed per lockfile-owning repository, so two packages cannot run competing dependency installs against the same manifests.

## Crash-safe journal

The journal records its owner, every affected path, original file copies and digests, directories created by the apply, and the dependency-install process identity. Journal data and staged content are flushed before the workspace changes.

An added file is linked into place only if the path is still empty. A modified or deleted file must still match its expected base. Any failure begins rollback.

On startup and before a new apply, the bridge inspects unfinished journals. It first handles any recorded install, then claims an abandoned journal without moving it, and resumes rollback. Live ownership is identified by process id, start time, boot, namespace information, and a heartbeat when direct comparison is unsafe.

Rollback restores a file only when it still contains what Lemma wrote. A file changed afterward is kept, and any displaced original is preserved under the recovery directory. Manifest and lockfile recovery is recorded step by step so another crash can resume it safely.

## Dependency installation

Dependency changes are declarations, not edits to manifests or lockfiles in the bundle. The bridge saves exact versions and disables package lifecycle scripts for npm, pnpm, Yarn Classic, and Yarn Berry.

Wallet secrets, Lemma settings, Cursor credentials, and RPC variables are removed from the install environment. Registry credentials with unrelated names remain available because package managers may require them.

An install that survives its bridge is killed only when the process identity can be verified. Ambiguous processes are left running and the journal remains blocked for operator review.

## Acceptance runs

Verification runs only when the resolution is present, no apply journal is active, the package still fits the purchased profile, the package manager is available, and the configured script is real.

The acceptance command runs without a shell, in its own process group, with a fresh home directory, bounded output, and a timeout. Raw output never enters model context. The receipt records the digest and execution result.

The bridge refuses to start an acceptance run when its current or startup environment contains a wallet-secret variable. The buyer key lives in `lemma-signer`, not the bridge, but a key file readable by the operating-system user remains readable by the test process. Production buyer signing should therefore run the signer as another user, or use a hardware or remote signer.

On Linux, optional offline mode creates a new network namespace with loopback enabled. If namespace setup cannot be verified, no test starts and no receipt is recorded.

## Receipt delivery

The first started acceptance run creates the receipt that counts. Retryable server responses and network failures are retried later. Final mismatches are retained and reported.

`lemma-signer` signs the receipt over core `adoptionReceiptTypedData` when a signer answers. If signing fails, the bridge keeps the receipt and never submits it unsigned; it is signed at the next verify. Without a signer, the receipt is sent unsigned and the server stores it as unverified. The receipt is posted with the preview id, which proves the sender is the buyer, and the server's receipt verifier then checks its signature against the resolution's buyer.

With `LEMMA_AGENT_ID` set, the receipt is posted with `agentId`, this agent's own ERC-8004 agent id, beside the receipt rather than inside it. The bridge checks the value at startup and refuses to start with an invalid one; without it, no receipt names an agent. The server stores the id with the receipt, and once the outcome is finalized its attester gives that agent the same feedback it gives the provider, but only when the address that paid owns the agent or is its ERC-8004 agent wallet. Opting in therefore publishes that the paying wallet adopted each resolution (see [Security Model](security-model.md#reputation-threat-model)). The value is the buyer agent's id, never the server's `LEMMA_AGENT_ID`.
