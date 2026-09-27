# Lemma follow-up backlog

This is the one work plan for the follow-up work left after the Arbitrum build (September 2026). It replaces 60 separate follow-up issues. Items 1 to 13 are already open on GitHub; items 14 to 60 were never opened. They are grouped here into 22 work packages. Each package is sized for one pull request, so a coding agent can work through the backlog one package at a time.

- Item 7 ("Show distinct-buyer counts next to pass rates, and cap counted outcomes per buyer") is already done by the outcome pipeline pull request. Close it when that pull request merges.
- The last section maps every item number and title to its package.

---

## Prompt to give the agent

```text
You are a coding agent working on the Lemma repository (github.com/4waan/Lemma).
Read CLAUDE.md first, then this backlog (docs/follow-up-backlog.md, or the copy
you were given).

Work on exactly one work package per session:
1. Pick the first package in "Plan at a glance" whose status is "ready" and whose
   "Depends on" pull requests are merged into main. Skip packages marked "decision",
   "blocked" or "needs web" unless their inputs are available.
2. Create the branch the package names, from the latest main.
3. Read every file the package lists before you change anything.
4. For a behavior change, write a test that fails first, then make it pass.
5. Run the package's verification commands and `npm run secrets:scan`. All must pass.
6. Update only the docs the package names, in the same short, plain working-guide style.
7. Open one pull request with .github/pull_request_template.md, and fill in every
   section. Name the backlog items it covers, and close their GitHub issues if they exist.
8. Stop and ask a person before you change a contract, x402 or facilitator code, an
   EIP-712 layout, signing code, or a signed or persisted schema, unless the package
   says this was approved. Never commit a secret or a key.
```

---

## Read first

### Where the code is (state on 2026-09-27)

Pull requests already open on 4waan/Lemma:
- #31 `chore/mit-license`
- #32 `chore/claude-code-housekeeping`
- #33 `bridge/agent-rules`
- #34 `docs/arbitrum-guide`
- #35 `skills/solidity-security`
- #36 `web/redesign-and-brand` (the new dashboard)
- #37 `docs/business-model`

Feature pull requests, from branches on the fork `github.com/tyler-turnpike/Lemma` (their numbers are not known yet):

| Branch | What it adds | Depends on |
| --- | --- | --- |
| `contracts/warranty-registry` | the warranty contract (Foundry, OpenZeppelin 5.6.1) | nothing |
| `contracts/stylus-confidence` | the confidence engine: a Rust crate, wasm in the server, a Stylus contract | #36 |
| `payments/x402-paid-path` | paid purchases over x402, the buyer signer, the reconciler | #36 |
| `reputation/erc-8004` | ERC-8004 feedback, the attester, adoption records | the Stylus and payments branches |
| `pipeline/outcome-pipeline` | warranty jobs, indexer, evaluator, refund relay, e2e run, Sepolia runbook | the ERC-8004 and registry branches |

- **Merged:** start from `main`.
- **Not merged yet:**
  - start code work from `pipeline/outcome-pipeline`, which contains every feature branch above;
  - start docs work from the pull-request branch that owns the file. For example, `docs/arbitrum.md` comes from #34.
  - `pipeline/outcome-pipeline` does not contain #31 to #35 or #37.

### Rules these packages touch most (from CLAUDE.md)

- **Money:** atomic USDC as integer strings or `bigint`, never floating point.
- **Signed, paid or persisted objects:** each one is a strict, versioned schema in `packages/core`. Changing one is a schema change: update `packages/core/test/vectors/digests.json` deliberately (`LEMMA_WRITE_VECTORS=1`), additions only unless agreed, and say so in the pull request.
- **Read models** (`ResolutionView`, `StatusView`, `CatalogView` and the like) are not signed. Changing them needs no vector change, but say it is a read-model change.
- **Migrations:** generate them with `npm run db:generate -w @lemma/server`. Never edit a migration or a snapshot by hand. A second run must report no changes.
- **Secrets:** none in code, fixtures, logs, run records or command-line arguments. Build test keys at runtime.
- **Bridge:** it sends allowlisted metadata only. Acceptance recipes are argv arrays, run without a shell.
- **Owned by the protocol owner:** contracts, x402 and facilitator code, EIP-712 layouts and signing. Packages that touch them are marked "Owner review: yes", and a person must approve before merge.
- **Docs:** they live in the guide that owns the topic, in short, plain sentences. Link to that guide rather than repeating it.
- **Branches:** one per pull request, named `<area>/<topic>`, using the template in `.github/pull_request_template.md`.

### Verification commands

| When | Command |
| --- | --- |
| Always | `npm ci`, then `npm run verify` (typecheck, test typecheck, all tests, build and bundle check) and `npm run secrets:scan` |
| Contracts | `git submodule update --init`, then `npm run contracts:build`, `npm run contracts:test`, `npm run contracts:abi -- --check` and `npm run contracts:rehearse` (needs `forge` and `anvil`) |
| Stylus and confidence | `npm run stylus:test`, `npm run confidence:wasm:check` |
| Server tables | `npm run db:generate -w @lemma/server`, run twice; the second run must say "No schema changes" |
| Digest vectors | `LEMMA_WRITE_VECTORS=1 npm test -- packages/core/test/vectors.test.ts`, then `git diff` shows only intended additions |
| Warranty pipeline | `npm run e2e` (anvil and forge on PATH) and `LEMMA_REGISTRY_ARTIFACTS=contracts/out npx vitest run apps/server/test/warranty-anvil.test.ts` |
| ERC-8004 | `LEMMA_ERC8004_ARTIFACTS=<forge out/ of erc-8004-contracts b9e466c> npx vitest run apps/server/test/erc8004-anvil.test.ts` |

- **Timeouts:** if `packages/catalog/test/resolve.test.ts` times out on a busy machine, rerun that file alone, and report both runs. WP-01 fixes this.
- **CI workflows:** review every change to `.github/workflows/` with `.claude/skills/gha-security-review/SKILL.md`:
  - actions pinned by full SHA;
  - least permissions;
  - no secrets;
  - no untrusted input in `run` steps.

---

## Plan at a glance

Priority:
- **P0:** security, privacy or money.
- **P1:** robustness and operations.
- **P2:** polish, docs and tooling.

Size: S is a small PR, M a medium one, L a large one.

| WP | Title | Priority | Status | Size | Items | Depends on | Owner review |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WP-01 | Stabilize the timing-sensitive tests | P1, do first | ready | S | 13, 27 | nothing | no |
| WP-02 | Receipts only from the buyer's own bridge | P0 | ready | L | 28, 29 | payments | yes (signing) |
| WP-03 | Private refunds by default | P0 | ready | M | 6, 54 | pipeline | only for option B |
| WP-04 | Warranty indexer: fork detection and send races | P0 | ready | M | 45, 46 | pipeline | no |
| WP-05 | Less linkable public warranty data | P0 | 49 ready; 48 needs decision D6 | S to M | 48, 49 | pipeline | no |
| WP-06 | Payment path robustness | P1 | ready | M | 30, 31, 32, 33 | payments | yes (x402 notes) |
| WP-07 | Reputation module hardening | P1 | ready | M | 39, 40, 42, 44 | ERC-8004 | no |
| WP-08 | Attester key rotation and summary cost | P1 | ready | M | 41, 43 | ERC-8004 | no |
| WP-09 | Operator scripts and key custody | P1 | ready | S | 47, 56 | pipeline | no |
| WP-10 | Status page: reputation state and bond alerts | P1 | ready | M | 37, 51 | pipeline | no |
| WP-11 | Pipeline state: memory, feed cursor, evaluator paging | P2 | ready | M | 50, 52, 53 | pipeline | no |
| WP-12 | CI and supply-chain checks | P1 | ready | M | 11, 24, 25, 38 | registry, ERC-8004, #35 | no |
| WP-13 | End-to-end coverage of production wiring | P1 | ready | M | 55 | pipeline | no |
| WP-14 | JSON ABI with events for the Stylus contract | P2 | ready | S | 16 | Stylus | yes (contracts) |
| WP-15 | One-step ERC-8004 agent opt-in | P2 | ready | M | 36 | ERC-8004 | yes (signing) |
| WP-16 | Dashboard text follows live status | P2 | ready | S | 34, 58 | pipeline | no |
| WP-17 | Docs refresh after the merges | P2 | ready after merges | M | 5, 19, 35, 57, 60 | all, and #32, #34, #35, #37 | a person reviews CLAUDE.md |
| WP-18 | Skills housekeeping | P2 | ready | S | 10, 12 | #35 | no |
| WP-19 | Revenue report build pipeline | P2 | needs inputs | M | 8 | #37 | no |
| WP-20 | Live Arbitrum Sepolia run and measurements | P1 | blocked | L | 2, 3, 9, 14, 15, 17, 26, 59 | all features, network, funded key | yes |
| WP-21 | Fact checks and x402 escrow research | P2 | needs web | M | 1, 4 | #34, #37 | no |
| WP-22 | Decisions for the team | P1 | decision | S each | 12, 18, 20, 21, 22, 23, 48 | nothing | yes |

Suggested order:
1. WP-01.
2. The P0 packages (WP-02 to WP-05).
3. The P1 packages.
4. The P2 packages.

Decisions (WP-22) can run in parallel at any time. WP-20 starts as soon as the network and the key are available.

---

## Work packages

### WP-01 Stabilize the timing-sensitive tests

- **Priority:** P1, do first. It keeps every later pull request's CI honest.
- **Status:** ready
- **Size:** S
- **Items:** 13, 27
- **Branch:** `test/stabilize-timing-tests`

**Why.** Two tests fail on busy machines and pass when rerun:
- In `packages/catalog/test/resolve.test.ts`, two fast-check properties take about 5 seconds each and hit Vitest's 5-second timeout under load (6.5 to 6.8 s measured). They are "is deterministic and independent of catalog order" and "reuses only a profile that passes every check, and offers exactly when it is sellable".
- In `packages/benchmark/test/harness.test.ts`, the test "CursorAdapter process boundary > reaps what a finished child leaves running and does not wait for it" once expected a reaped process id to be gone before it was.

**Steps.**
1. `resolve.test.ts`: give the two properties an explicit timeout, such as 20 s, or lower their fast-check `numRuns`. Keep what they assert.
2. `harness.test.ts`: wait for the reap with a bounded poll instead of a fixed wait. Keep the assertion.

**Done when.** Both files pass while another `npm run verify` runs at the same time. Show two parallel runs in the pull request.

**Verify.** Run `npm run verify` twice at once.

---

### WP-02 Receipts only from the buyer's own bridge

- **Priority:** P0
- **Status:** ready
- **Size:** L
- **Items:** 28, 29
- **Owner review:** yes (signing)
- **Branch:** `bridge/receipt-integrity`

**Why.** `lemma-signer` signs any schema-valid Adoption Receipt that a local process asks for (`POST /sign/adoption-receipt`).
- Every process of the user can reach its socket, including a release's own acceptance tests.
- The server keeps the first receipt posted for a resolution.
- So a release's tests could get a "passed" receipt signed and posted before the bridge posts the real result. A verified receipt proves only that the buyer's signer signed it.
- The warranty evaluator auto-passes verified "passed" receipts, so this affects warranties. `docs/security-model.md` lists it as the known gap "receipts from acceptance tests".

Separately (item 29), the bridge refuses a signer socket in a directory its group or others can write to. It cannot require the directory to be the user's own, because a signer running as another user owns its directory. So a directory another local user created under a parent anyone can write to still passes, for example `/tmp/x/` with `LEMMA_SIGNER_SOCKET=/tmp/x/s.sock`.

**Where.**
- `apps/bridge/src/signer/` (`signer.ts`, `socket.ts`, `policy.ts`, `main.ts`);
- `apps/bridge/src/buy.ts` and `apps/bridge/src/payments.ts`;
- `apps/bridge/src/acceptance.ts`, which runs the recipe and already has an opt-in `unshare` offline mode, and `apps/bridge/src/adoption.ts`;
- tests in `apps/bridge/test/`;
- `docs/security-model.md`, `docs/bridge-runtime.md` and `apps/bridge/README.md`.

**Steps.**
1. Tie receipts to purchases in the signer:
   - `POST /sign/transfer-authorization` also takes `resolutionId` and `previewId`.
   - The signer checks `nonce === derivePaymentNonce(resolutionId, previewId)` (from `@lemma/core`) and records the resolution id in its own ledger.
   - `POST /sign/adoption-receipt` signs only for a resolution id the signer recorded, and only once per resolution id.
   - Update the `Signer` interface, `LocalSigner`, `SocketSigner` and the buy flow.
2. Keep acceptance tests away from the signer and the bridge's state directory. On Linux, run the recipe in a mount namespace that hides the signer socket's directory and the state directory, building on the existing `unshare` path. Make that the default where user namespaces are available. Elsewhere, say plainly in the verify answer and the docs that the evaluator is the only defense.
3. Socket trust (item 29): add `LEMMA_BUYER_ADDRESS`, and refuse a signer whose `GET /address` answers another address. Pinning the address is simpler and stronger than checking every ancestor directory; keep the existing directory check too.
4. Tests:
   - a local process that is not the bridge cannot get a receipt signed;
   - a second receipt for one resolution is refused;
   - an acceptance test cannot connect to the signer socket (Linux; skip elsewhere);
   - a signer answering with another address is refused.

**Done when.**
- Only the bridge's own purchases get receipts, once each.
- Acceptance tests cannot reach the signer where namespaces exist.
- The docs narrow the known gap to platforms without namespaces.

**Verify.** `npm run verify` and `npm run e2e`.

---

### WP-03 Private refunds by default

- **Priority:** P0
- **Status:** ready
- **Size:** M
- **Items:** 6, 54
- **Owner review:** only for option B (signing)
- **Branch:** `bridge/private-refunds`

**Why.** Lemma's privacy rule is that nothing public joins a buyer's wallet to the resolution it bought. By default, though:
- the refund address `refundTo` is the buyer's paying wallet;
- `withdrawCredit(resolutionId, claimSecret, to)` puts `to` on chain next to the resolution id;
- the server's relay sends that transaction, and the dashboard links it.

`lemma_claim_refund` warns, but the default still creates the link. Separately (item 54), every refund call reads the server's view of every stored claim, including warranties that ended long ago. A user with many purchases can hit the per-minute rate limit (`RATE_LIMITED`).

**Where.**
- `apps/bridge/src/buy.ts` (claim creation);
- `apps/bridge/src/payments.ts` (`refundToFromEnv`, `LEMMA_REFUND_TO`);
- `apps/bridge/src/refund.ts` and `apps/bridge/src/inbox.ts` (`claims/`);
- `apps/bridge/src/signer/` (option B only);
- tests;
- `docs/security-model.md`, `docs/bridge-runtime.md` and `apps/bridge/README.md`;
- `apps/web/src/views/Setup.tsx` (the `LEMMA_REFUND_TO` text).

**Steps.**
1. Choose the default, and write the choice in the pull request:
   - **Option A (recommended now):** never default to the paying wallet.
     - A purchase with a warranty claim needs `LEMMA_REFUND_TO` set to another address the user controls.
     - `LEMMA_REFUND_TO=buyer` is the explicit opt-in to the paying wallet.
     - Without either, the bridge buys without a claim (no warranty), and says so in at most 600 characters.
   - **Option B (later):** `lemma-signer` derives a fresh refund address per purchase (BIP-32 through `@scure/bip32`, which viem already depends on). It can list those addresses and sweep them.
2. Remember final refund states (item 54). Store each claim's final state in the inbox (passed, void, expired, refunded or none) and skip those claims in later `lemma_claim_refund` calls.
3. Tests:
   - a default purchase never creates a claim whose refund address is the paying wallet;
   - the refund tool skips final claims;
   - answers stay within 600 characters.
4. Docs: say what choosing the paying wallet reveals.

**Done when.** A default refund never publishes the paying wallet, and the requests per refund call depend only on open warranties.

**Verify.** `npm run verify` and `npm run e2e` (the refund scenario).

---

### WP-04 Warranty indexer: fork detection and send races

- **Priority:** P0
- **Status:** ready
- **Size:** M
- **Items:** 45, 46
- **Branch:** `server/warranty-indexer-forks`

**Why.**
- **Forks (item 45).** The registry indexer reads only up to `head - WARRANTY_INDEXER_CONFIRMATIONS` (default 64 blocks), and it keeps no block hashes. Two failures remain:
  - a reorg deeper than that leaves a row that is no longer on chain. The attester may then post ERC-8004 feedback that cannot be taken back, and the confidence counts an outcome the engine never recorded;
  - a load-balanced RPC whose `eth_getLogs` backend lags further than the depth silently drops logs for good. A dropped activation means the warranty is never finalized or expired, and the buyer gets no refund.
- **Nonce race (item 46).** In `apps/server/src/warranty/actions.ts`, `attempt()` reads `nonces(sender)` outside the per-sender send queue. Another job's first send from the same account can take that nonce. The resend is then refused, or it replaces the other transaction if fees rose by 10% or more. The next attempt heals it.

**Where.**
- `apps/server/src/warranty/`: `indexer.ts`, `actions.ts`, `chain.ts`;
- `apps/server/src/db/schema.ts` (`chain_cursors`), `apps/server/src/persistence.ts` and `apps/server/src/db/store.ts` (MemoryStore and PgStore);
- a generated migration;
- the warranty tests in `apps/server/test/`;
- `docs/server-runtime.md` ("Warranty outcome pipeline") and `docs/security-model.md` (remove the fork-detection entry from the deferred controls).

**Steps.**
1. Fork detection:
   - store the hash of the last block of each indexed range, in a new `chain_cursors` column (a generated migration);
   - on the next run, read that block's hash. On a mismatch, rewind the cursor to the fork point and delete the `registry_events` above it, in one store step, in both stores;
   - optionally, re-read the last few blocks every run to heal a lagging node;
   - an alternative is indexing to Arbitrum's `safe` block tag, which costs tens of minutes of latency.
2. Nonce race: re-read the nonce and re-check the registry inside the per-sender queue (`serially()`), for example with a callback passed into `send`. Keep the documented crash-safety order: the registry check comes before the send.
3. Tests:
   - a fake chain that reorgs below the depth: afterwards, the rows match the new chain;
   - two jobs sending from one account never collide on a nonce.

**Done when.** A reorg below the depth heals itself, and shared senders never collide.

**Verify.**
- `npm run verify` and `npm run e2e`;
- the warranty anvil test;
- `npm run db:generate -w @lemma/server`, twice.

---

### WP-05 Less linkable public warranty data

- **Priority:** P0
- **Status:** item 49 is ready; item 48 needs decision D6 (WP-22) first
- **Size:** S for 49, M for 48
- **Items:** 48, 49
- **Branch:** `server/warranty-privacy`

**Why.**
- **Item 48.** The activator waits a random delay (up to `WARRANTY_ACTIVATION_JITTER_SECONDS`, default 300) before activating a warranty, and the public resolution view shows only the day. At testnet volume, though, there is often only one same-price transfer to the payee in that window. An observer can then match the `ResolutionActivated` event to the USDC settlement and learn the buyer's wallet.
- **Item 49.** Distinct-buyer counts are published from 3 up and refresh after every indexer run. When a new outcome arrives and the count does not move, an observer learns that the new resolution's buyer is one of the earlier ones.
- An on-chain weight of 0 says the same thing, and cannot be hidden. It is already documented.

**Where.**
- `apps/server/src/warranty/`: `outcomes.ts`, `view.ts`, `activator.ts`;
- `apps/server/src/config.ts`;
- `packages/core/src/read.ts`, if a read model changes;
- `docs/security-model.md` ("Activation timing, and what it does not hide") and `docs/reputation-and-confidence.md`.

**Steps.**
1. Item 49: publish the distinct-buyer counts (profile `compatibility.buyers` and release `reputation.buyers`) from a daily snapshot instead of after every indexer run. The test: a new outcome does not change a published count before the next daily refresh.
2. Item 48, after decision D6: implement the chosen option, such as activating in batches at fixed times, a longer default delay, or a purchase without a warranty. Then state the buyer's anonymity set in the security model.

**Done when.** A single outcome's effect on a published count cannot be seen on its own. At the expected volume, an activation cannot be matched to one settlement by timing alone.

**Verify.** `npm run verify` and `npm run e2e`.

---

### WP-06 Payment path robustness

- **Priority:** P1
- **Status:** ready
- **Size:** M
- **Items:** 30, 31, 32, 33
- **Owner review:** yes (x402 and facilitator notes)
- **Branch:** `payments/robustness`

**Steps.**
1. **Backoff survives restarts (item 30).** Today `apps/server/src/payments/reconciler.ts` keeps each undecided row's backoff in memory. Add a `next_check_at` column on `resolutions` (a generated migration). `listUnsettled` orders and filters by it, and the reconciler writes it. Several replicas then share one backoff.
2. **Late signer (item 32).** `paymentsFromEnv` in `apps/bridge/src/payments.ts` asks the signer for its address once, at startup, so a signer started after the bridge leaves purchases off.
   - Register `lemma_buy_resolution` whenever the socket and the spending policy are set, and answer "signer unreachable" per call.
   - The preview text must then say that purchases may be unavailable.
3. **Refused before the handler (item 33).** `remote.buy` throws on any HTTP error, including a 429 that refused the request before x402 ran. `buy.ts` then treats it as a lost answer: it keeps the purchase pending for up to 15 minutes and counts the reservation for 24 hours. Tell apart the errors that mean the request never reached the paid handler, such as 429 and some other 4xx answers, and release the pending mark and the reservation for those.
4. **x402 upstream (item 31).** In `@x402/evm` 2.27.0, `verifyEIP3009` and `verifyPermit2` start an asset check (a `getCode` of the token) and return early without awaiting it, so a failing check becomes an unhandled rejection. Lemma works around it in `viemFacilitatorSigner`.
   - Draft the upstream issue text in the pull request, or open it if you can.
   - Add an "x402 upgrade checklist" to `apps/server/README.md`: re-check that workaround, and the payload-shape routing (`"permit2Authorization" in payload`) that the facilitator guard relies on.

**Tests:**
- the backoff survives a restart;
- starting the signer late enables purchases without a restart;
- a rate-limited purchase leaves no pending mark and no reservation.

**Docs:** `docs/server-runtime.md` and `docs/bridge-runtime.md`.

**Verify.** `npm run verify`, and `npm run db:generate -w @lemma/server` twice.

---

### WP-07 Reputation module hardening

- **Priority:** P1
- **Status:** ready
- **Size:** M
- **Items:** 39, 40, 42, 44
- **Branch:** `reputation/attester-hardening`

**Steps.**
1. **One secret type and one RPC transport (item 44).** The payment path wraps the RPC URL and keys in config's `Secret`, and sends viem errors through `apps/server/src/payments/rpc.ts` `redactingTransport`. The reputation module has its own `SecretKey` class (`apps/server/src/reputation/config.ts`), keeps the RPC URL as a plain string, and calls viem's `http()` directly. Move it to the shared `Secret` and the redacting transport, and delete the duplicate.
2. **Attester search and retries (item 40)**, in `apps/server/src/reputation/attester.ts` and `chain.ts`:
   - replace the fixed `ERC8004_LOG_RANGE` search with the reconciler's adaptive search, which halves a refused range and grows it back;
   - cap retries, with an alert code, and make resend searches continue where they stopped;
   - add an optional `ERC8004_FROM_BLOCK`. When it is set, search the chain before the first send too, so a database restored from an old backup never double-posts.
3. **Registries that belong together (item 42).** At startup, with reputation on, read the reputation registry's `getIdentityRegistry()`. Refuse to start unless it equals `ERC8004_IDENTITY_REGISTRY`.
4. **Cross-origin reads (item 39).** Send `Access-Control-Allow-Origin: *` only on the public, immutable GET routes:
   - `/api/v1/agent/registration.json` and `/.well-known/agent-registration.json`;
   - `/api/v1/evidence/:id`.

   Every other API route keeps its CORS policy.
5. Add tests for each step.

**Docs:** `docs/server-runtime.md`, `apps/server/README.md`, `docs/deployment.md` and `.env.example`.

**Verify.** `npm run verify` and the ERC-8004 anvil test.

---

### WP-08 Attester key rotation and summary cost

- **Priority:** P1
- **Status:** ready
- **Size:** M
- **Items:** 41, 43
- **Branch:** `reputation/rotation-and-summaries`

**Why.**
- **Rotation (item 41).** Each queued `reputation_posts` row stores its feedback file, and the file names the attester as the ERC-8004 `clientAddress`. After a key rotation, every post queued before the change is skipped as `FILE_MISMATCH`. The summaries also count only the reviewer addresses they are given.
- **Summary cost (item 43).** The registry's `getSummary` loops over every feedback from the given reviewers, so each call costs more gas inside `eth_call`. Eventually it passes an RPC provider's call gas cap, and the Catalog's record goes stale.

**Steps.**
1. Rotation:
   - document it in `docs/deployment.md`;
   - accept a list of past attester addresses for `getSummary`;
   - re-queue `FILE_MISMATCH` posts under a new feedback file naming the new attester, after a chain search shows the old key never posted them.
2. Summary cost:
   - measure `getSummary` gas against the number of feedback entries on anvil, with the official registry (the ERC-8004 anvil test setup), and record the numbers and the date;
   - build the summary from `NewFeedback` events the server indexes, and keep `getSummary` as a periodic cross-check.

**Done when.** A key rotation loses no pending feedback, the record keeps its history, and the Catalog record no longer depends on an ever-growing `eth_call`.

**Verify.** `npm run verify` and the ERC-8004 anvil test.

---

### WP-09 Operator scripts and key custody

- **Priority:** P1
- **Status:** ready
- **Size:** S
- **Items:** 47, 56
- **Branch:** `ops/operator-key-custody`

**Steps.**
1. **Revenue to a cold address (item 47).** `register-release` in `apps/server/src/warranty/admin.ts` requires the release's `payTo` to be the provider address, and the server holds the provider key as a hot key. So that key receives all revenue, and it can withdraw every unreserved bond.
   - Let `register-release` accept a `payTo` that differs from the provider: take the provider from the provider key's address, and check `payTo` separately.
   - Update the runbook (`docs/deployment.md`), the e2e rehearsal (`e2e/`) and `ops/README.md`.
   - Recommend keeping the provider key off the server in production, or splitting the roles.
2. **Bare hex keys (item 56).** `parseRegisterArgs` in `apps/server/src/reputation/register.ts` refuses only `0x`-prefixed 64-hex arguments. Refuse bare 64-hex runs too, like `warranty-admin` and `ops/sepolia/setup-roles.ts` already do, and never echo an unknown option. Add a test.

**Verify.** `npm run verify` and `npm run e2e`.

---

### WP-10 Status page: reputation state and bond alerts

- **Priority:** P1
- **Status:** ready
- **Size:** M
- **Items:** 37, 51
- **Branch:** `web/status-reputation-and-bonds`

**Steps.**
1. **Reputation state (item 37).** Add to `StatusView` (`packages/core/src/read.ts`; a read-model change) and to the Status page (`apps/web/src/views/Status.tsx`):
   - whether reputation is on;
   - the attester address;
   - the registry addresses;
   - counts of pending, posted and skipped `reputation_posts`.
2. **Bond alerts (item 51).** When a release's bond is too small, the activator retries for 24 hours and then gives up, with only an error-level `warranty.bond_exhausted` log.
   - Route that event to an alert hook, such as a configurable webhook.
   - Show each release's available bond against its queued activations on the Status page.
   - Refusing offers for a release whose bond cannot cover them would change the sale rule, so ask a person first.
3. Add page tests, and keep the CSP and bundle checks green.

**Where.** Also `apps/server/src/app.ts` (the status route), `apps/server/src/warranty/` and `apps/server/src/reputation/`.

**Verify.** `npm run verify`.

---

### WP-11 Pipeline state: memory, feed cursor, evaluator paging

- **Priority:** P2
- **Status:** ready
- **Size:** M
- **Items:** 50, 52, 53
- **Branch:** `server/pipeline-state`

**Steps.**
1. **Memory (item 50).** `RegistrySnapshot` (in `apps/server/src/warranty/`, see `outcomes.ts`) keeps every indexed finalization, activation profile and payer in memory, so it grows without limit. Keep only the per-key outcome arrays and counts that the catalog needs, or reload them in pages. Add a test with a large history.
2. **Feed cursor (item 52).** The attester keeps its `OutcomeFeed` cursor in memory, so after a restart it reads every outcome again and logs its skip codes again. Persist the cursor (for example in `chain_cursors`) and read it at startup.
3. **Evaluator paging (item 53).** `npm run evaluator -w @lemma/server -- list` shows at most 100 outcomes, and `decide` handles one resolution per run.
   - Add paging.
   - Add a way to decide several resolutions at once, with a confirmation that lists them.
   - The code is in `apps/server/src/warranty/review.ts` and `apps/server/src/scripts/evaluator.ts`.

**Verify.** `npm run verify`, and `npm run db:generate -w @lemma/server` twice if a table changes.

---

### WP-12 CI and supply-chain checks

- **Priority:** P1
- **Status:** ready
- **Size:** M
- **Items:** 11, 24, 25, 38
- **Branch:** `ci/supply-chain-checks`

Review every workflow change with the gha-security-review skill.

**Steps.**
1. **Slither (item 24).** Add a CI step: `crytic/slither-action` pinned by SHA, or `slither-analyzer` at a pinned version.
   - Use `--filter-paths contracts/lib/`.
   - Keep a triage file for the three accepted timestamp findings, which are listed in `docs/warranty-registry-review.md`.
   - CI fails on any new, untriaged finding in `contracts/src`.
2. **Dependency alerts (item 25).** Add a Dependabot `gitsubmodule` entry for `contracts/lib` (OpenZeppelin 5.6.1 and forge-std 1.16.2), or document a quarterly review of both pins.
3. **ERC-8004 anvil test in CI (item 38).** Run `apps/server/test/erc8004-anvil.test.ts` in CI. It needs either of these, with `LEMMA_ERC8004_ARTIFACTS` set:
   - erc-8004-contracts checked out at `b9e466c` and built with forge (via-IR, optimizer 200, its OpenZeppelin 5.4 dependencies);
   - or committed runtime artifacts with a provenance file, like `e2e/fixtures/`.
4. **Vendored skills check (item 11).** Add a script or CI job that:
   - fetches each pinned commit in `.claude/skills/SOURCES.md`;
   - diffs the installed files against it, allowing only the documented edits to `hono/SKILL.md` and `gha-security-review/SKILL.md`;
   - runs the scanner and its second pass (which also covers `reference/` and `resources/`).

**Done when.** CI catches new slither findings, stale submodules, a broken ERC-8004 integration, and drift in the vendored skills.

---

### WP-13 End-to-end coverage of production wiring

- **Priority:** P1
- **Status:** ready
- **Size:** M
- **Items:** 55
- **Branch:** `e2e/production-wiring`

**Why.** `npm run e2e` assembles the server in process, the way `main.ts` does, over PGlite. It does not cover:
- `main.ts` itself, as a process, with its config gates;
- the evaluator's review flow: the e2e uses `EVALUATOR_FAILURES=auto`;
- job intervals: `startPaymentPath` and `startReputation` take none, so the e2e stops their timers and restarts the same jobs on short intervals;
- formatting of `e2e/contracts`.

**Steps.**
1. Let `startPaymentPath` (`apps/server/src/payments/index.ts`) and `startReputation` (`apps/server/src/reputation/index.ts`) take job intervals, and remove the e2e's workaround.
2. Add a CI step that starts `dist/main.js` against a Postgres service and the e2e chain, and checks health, status and one preview.
3. Rehearse `list` and `decide` in the e2e, with `EVALUATOR_FAILURES=review`.
4. Run `forge fmt --check` on `e2e/contracts` in the e2e job.

**Verify.** `npm run verify` and `npm run e2e`.

---

### WP-14 JSON ABI with events for the Stylus contract

- **Priority:** P2
- **Status:** ready
- **Size:** S
- **Items:** 16
- **Owner review:** yes (contracts)
- **Branch:** `contracts/stylus-abi-events`

**Why.** `cargo stylus export-abi` prints functions and errors only. Indexers need the events: `OutcomeRecorded`, `PriorSet`, `RegistrySet` and the ownership events.

**Steps.**
1. Commit a JSON ABI with every function, error and event. For example, compile the exported interface with solc, plus a small hand-kept events file.
2. Add a check to the `stylus` CI job that fails when the ABI drifts from the contract.
3. Update `contracts/README.md`.

**Verify.** `npm run stylus:test` and `npm run confidence:wasm:check`.

---

### WP-15 One-step ERC-8004 agent opt-in

- **Priority:** P2
- **Status:** ready
- **Size:** M
- **Items:** 36
- **Owner review:** yes (signing)
- **Branch:** `bridge/agent-opt-in`

**Why.** The attester posts feedback to a buyer's agent (`LEMMA_AGENT_ID`) only when the paying address owns the agent or is its agent wallet. Linking the two is a manual on-chain step today.

**Steps.**
1. Teach `lemma-signer` to sign the identity registry's `setAgentWallet` EIP-712 message. Take the typed data from the official erc-8004-contracts at `b9e466c`.
2. Add a `lemma-mcp setup` step that links the bridge's buyer address to the user's agent, relayed so that the user needs no ETH. Decide which relay to use, and write the choice in the pull request.
3. Add tests and docs.

**Done when.** A user opts in with one setting and one automated setup step.

---

### WP-16 Dashboard text follows live status

- **Priority:** P2
- **Status:** ready
- **Size:** S
- **Items:** 34, 58
- **Branch:** `web/live-status-text`

**Steps.**
1. `apps/web/src/views/Overview.tsx`:
   - drive the "coming soon" mark on the Buy step and on `lemma_buy_resolution` from `StatusView.paidTools`;
   - drive the hero line "A provider bond backs every sale" from `StatusView.chain.registry`.
2. `apps/web/src/views/Setup.tsx`: list `lemma_claim_refund` with the other bridge tools.
3. Update the code comments that still call the payment work future work:
   - `apps/server/src/`: `mcp.ts`, `service.ts`, `errors.ts`;
   - `apps/bridge/src/`: `bridge.ts`, `adoption.ts`, `install.ts`.
4. Add page tests, and keep the CSP and bundle checks green.

**Verify.** `npm run verify`.

---

### WP-17 Docs refresh after the merges

- **Priority:** P2
- **Status:** ready after all feature pull requests and #32, #34, #35 and #37 merge
- **Size:** M
- **Items:** 5, 19, 35, 57, 60
- **Branch:** `docs/post-merge-refresh`
- A person should review the `CLAUDE.md` part, since it is the coding agents' instruction file.

**Steps.**
1. Item 5, docs written while the work was in progress:
   - `docs/arbitrum.md`:
     - move the status rows to "Built", with real paths;
     - in section 6.2, replace the "planned design" labels on idea 1 (ERC-8004) and idea 3 (Stylus);
     - re-check each detail against the code: routes, cache time, preview metadata, the bridge's Record token, crate and wasm names, contract functions, the catalog `compatibility` field, and the dashboard.
   - `docs/business-model.md`: retag the [PLANNED] statements as [REPO], with citations. They are in section 1, section 2 (the status table, note and map), section 5, the first paragraph of section 7.4, and the facilitator line of section 7.5. Rebuild the PDF after WP-19.
   - `.claude/skills/SOURCES.md`: its note about `contracts/lib`.
2. Items 19 and 57, `CLAUDE.md` and the root README:
   - add to Commands:
     - `git submodule update --init`;
     - `npm run stylus:test`, `npm run confidence:wasm`, `npm run confidence:wasm:check`;
     - `npm run e2e`, `npm run sepolia:roles`, `npm run warranty:admin -w @lemma/server`;
   - add to "Where things go":
     - the confidence math lives only in the `no_std` crate `contracts/stylus/lemma-confidence`;
     - `packages/confidence` is the server-only wasm wrapper;
     - `contracts/stylus/confidence-contract` belongs to the protocol owner;
     - `e2e/` holds the local-chain run;
   - in the root README: the "Common scripts", the repository map, and the `ops` bullet.
3. Item 35, `docs/economic-gates.md`: redraw the money path as offer terms, then `checkPurchase`, then the signed authorization, then the paid call. Keep the note that a challenge whose terms differ from the quote is refused.
4. Item 60: keep one full statement of each warranty fact, in the guide that owns it, and replace the other copies with a sentence and a link:
   - the evaluator's inputs;
   - the ERC-8004 registries being a Draft, upgradeable mirror;
   - "a wrong read cannot change what a send does";
   - resolution dates that show only the day.

**Verify.** `npm run verify`, and a check that every relative link and anchor resolves.

---

### WP-18 Skills housekeeping

- **Priority:** P2
- **Status:** ready
- **Size:** S
- **Items:** 10, 12
- **Branch:** `skills/pin-refresh`

**Steps.**
1. Item 10: move the `property-based-testing` pin from trailofbits/skills `32e34f8` to `0cc1c73`. Follow "Updating a skill" in `.claude/skills/SOURCES.md`:
   - fetch `0cc1c73`;
   - run the scanner and the second pass;
   - confirm the files are identical;
   - update the table.
2. Item 12: decision D7 (WP-22). Either vet and install `audit-prep-assistant` and `code-maturity-assessor` from the same plugin, or decline them.

---

### WP-19 Revenue report build pipeline

- **Priority:** P2
- **Status:** needs inputs
- **Size:** M
- **Items:** 8
- **Branch:** `docs/business-model-build`

**Inputs needed.** The report's sources are not in the repository:
- the section files `src/00-summary.md` to `src/08-sources-close.md`;
- `sources.mjs`, with 121 source entries;
- `cite.mjs`, which numbers the citations;
- `build.mjs`, which turns the Markdown into a PDF through Chromium;
- the fonts.

Ask for them before you start.

**Steps.**
1. Add the sources under `docs/business-model/`, with a small `package.json` outside the npm workspaces (marked and playwright) and a README.
2. Add a check that the sources reproduce `docs/business-model.md` byte for byte.
3. Decide where the PDF lives: in git (updated only at milestones), in Git LFS, or as a release asset. Each regenerated PDF adds about 750 KB to git history.
4. Trim the half-blank page 3.

**Done when.** One command rebuilds the Markdown and the PDF from committed sources.

---

## Gated work

### WP-20 Live Arbitrum Sepolia run and measurements

- **Status:** blocked
- **Size:** L
- **Items:** 2, 3, 9, 14, 15, 17, 26, 59, plus the plan's deploy-and-run step
- **Owner review:** yes
- **Branch:** `ops/sepolia-live-run`

**Blocked on:**
- an environment that can reach `sepolia-rollup.arbitrum.io`, `sepolia.arbiscan.io` and `api.etherscan.io`;
- `ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY`, a testnet key with about 0.05 Sepolia ETH and 20 test USDC from Circle's faucet, set as an environment variable and never pasted anywhere;
- all feature pull requests merged, or work from `pipeline/outcome-pipeline`.

**Steps.** Follow the runbook in `docs/deployment.md`, "Arbitrum Sepolia runbook":
1. `npm run sepolia:roles -- --dir <a private directory outside the repository>`, which generates the role keys and funds them.
2. Deploy the registry with `contracts/script/DeployRegistry.s.sol` (two steps). Verify its source on Arbiscan (item 26).
3. Deploy the Stylus engine (item 15):
   - `cargo stylus check --endpoint` first;
   - then `cargo stylus deploy` with the constructor arguments and a key file with mode 0600.
4. Measure `record` gas through the registry in three cases (item 14): a cold program with a new key and no prior, the same with a prior set, and an existing key. Write the figures and the date in the contracts guide. Cache the program through the CacheManager if the cold figure nears the 300,000-gas budget. Only then run `warranty:admin set-engine`.
5. `npm run warranty:admin -w @lemma/server --` with `register-release`, `deposit-bond`, then `set-priors` (item 15).
6. `npm run agent:register -w @lemma/server` for the provider's ERC-8004 identity.
7. Configure the server as the runbook says. Run one passing purchase and one refunded failure, end to end. A purchase needs a sellable release: frozen benchmark evidence, or the testnet-only provisional overlay (`ALLOW_PROVISIONAL_EVIDENCE=true`).
8. Record every address, the deployment block and each transaction hash in `docs/deployments/arbitrum-sepolia.md`.
9. Measurements:
   - **Item 3:** the gas of an EIP-3009 settlement, and of warranty activation, outcome and expiry. Update the tables in `docs/arbitrum.md` and `docs/arbitrum-roadmap.md` with the values and dates, and the chain cost `g` in `packages/catalog/economics.json` through the protocol lane. Measure an ERC-7710 redemption on a fork or on Sepolia, and re-check Arbitrum One's minimum base fee.
   - **Item 2:** read the MetaMask Delegation Framework v1.3.0 bytecode on chain with `cast code`, compare it with a build of the v1.3.0 tag, and map each contract to its audit in `audits/`. Update section 1.3 of `docs/arbitrum-roadmap.md`.
   - **Item 9:** put measured values, with dates, into `docs/business-model/unit-econ.mjs`, rerun it, and update section 10 and the PDF.
   - **Item 59:** update the lever-7 note in `docs/economic-gates.md`.
10. Item 17: once CI may reach an RPC, add a pinned `cargo stylus check --endpoint` to the `stylus` job.

### WP-21 Fact checks and x402 escrow research

- **Status:** needs web access
- **Size:** M
- **Items:** 1, 4
- **Branch:** `docs/fact-checks`

**Steps.**
1. Item 1: read each fact that rests on a search summary on its original page, correct the text, and remove the "search summary" label.
   - Arbitrum guide:
     - the arXiv 2606.26028 quote;
     - the SP1 verification gas figure;
     - the Arbitrum Foundation post "AI and Stylus: The Builder's New Toolkit".
   - Revenue report, section 6:
     - the x402 payment census;
     - the Docker Hardened Images price of 5,000 USD and the Salesforce review fee of 999 USD;
     - the Chainguard revenue figure;
     - the Copilot and Cursor plan prices.
2. Item 4: read the auth-capture escrow scheme that `@x402/evm` 2.27.0 ships next to `exact` and `upto`. Answer these questions, then update idea M ("pay after tests pass") in `docs/arbitrum.md`:
   - Can it hold a payment until an adoption outcome, then capture or release it?
   - What would Lemma's facilitator need for that?

### WP-22 Decisions for the team

- **Status:** decision
- **Items:** 12, 18, 20, 21, 22, 23, 48

An agent may draft one short decision record per question in `docs/decisions/` (question, options, trade-offs, recommendation). A person decides. Implementation then becomes a new work package.

| ID | Question | Items | Recommendation to start from |
| --- | --- | --- | --- |
| D1 | How should the compatibility confidence gate sales, ranking or bonds? Today it is display only (`docs/economic-gates.md`, lever 7). | 18 | First a ranking key after "sellable" (lever 8). A sale blocker only once a profile has enough outcomes. Bond and price later. |
| D2 | Should warranties and payment references be keyed per release? Today a provider of release B could activate a resolution id meant for release A first. | 20 | Yes, before any mainnet deploy. Needs the release digest in the EIP-712 `Outcome` type, or as an argument, so the server's typed data and vectors change with it. |
| D3 | How should a failed compatibility-engine record be retried? Today `EngineRecordFailed` is final. | 21 | A `retryEngineRecord(resolutionId)` that anyone may call, guarded by a per-resolution "record failed" flag. It adds no new trust. |
| D4 | How can a leaked provider or evaluator key be rotated? | 22 | Document ERC-1271 smart-account roles now. Consider a timelocked evaluator rotation later. |
| D5 | Should the registry sweep USDC sent to it by mistake? | 23 | Only an owner-only sweep of `balance - (available + reserved + credits)`, with invariant tests. Otherwise keep none. |
| D6 | How should warranty activations be made unlinkable at low volume? | 48 | Batch activations at fixed times (for example hourly), and offer a purchase without a warranty. |
| D7 | Should the Trail of Bits `audit-prep-assistant` and `code-maturity-assessor` skills be installed? | 12 | Defer until an external audit is planned. |

---

## Item index

"Done" means the item is already implemented. Close its issue when the named pull request merges.

| Item | Title | Package |
| --- | --- | --- |
| 1 | Re-check facts that rest on search summaries before the buildathon submission | WP-21 |
| 2 | Read the MetaMask Delegation Framework on chain and map its audits | WP-20 |
| 3 | Measure payment gas on Arbitrum Sepolia: EIP-3009 now, ERC-7710 for the roadmap | WP-20 |
| 4 | Check whether x402's auth-capture escrow scheme supports "pay after tests pass" | WP-21 |
| 5 | Refresh the docs after the paid path, warranty registry, confidence engine and ERC-8004 pull requests merge | WP-17 |
| 6 | Warranty refunds to the buyer's own address link that wallet to what it bought | WP-03 |
| 7 | Show distinct-buyer counts next to pass rates, and cap counted outcomes per buyer | Done by `pipeline/outcome-pipeline` |
| 8 | Commit the revenue report's build pipeline so the PDF can be rebuilt | WP-19 |
| 9 | Replace the revenue report's assumed inputs with measured numbers | WP-20 |
| 10 | Move property-based-testing's pin to trailofbits/skills 0cc1c73 | WP-18 |
| 11 | Add a CI check that vendored skills still match their pinned upstream | WP-12 |
| 12 | Decide on two more Trail of Bits contract skills | WP-22 (D7), then WP-18 |
| 13 | Catalog property tests nearly hit Vitest's 5-second timeout | WP-01 |
| 14 | Measure the Stylus engine's `record` gas against the registry's 300,000-gas budget | WP-20 |
| 15 | Deploy the Stylus confidence contract and set its priors from evidence | WP-20 |
| 16 | A JSON ABI with events for the Stylus confidence contract | WP-14 |
| 17 | Run `cargo stylus check` in CI once CI can reach an Arbitrum RPC | WP-20 |
| 18 | Decide how the compatibility confidence gates sales, ranking or bonds | WP-22 (D1) |
| 19 | Update CLAUDE.md for the Stylus workspace and the contract submodules | WP-17 |
| 20 | Key warranties and payment references per release | WP-22 (D2) |
| 21 | Retry a compatibility-engine record that failed | WP-22 (D3) |
| 22 | Provider and evaluator role rotation per release | WP-22 (D4) |
| 23 | Decide whether the registry may sweep USDC sent to it by mistake | WP-22 (D5) |
| 24 | Run slither in CI | WP-12 |
| 25 | Get notified of OpenZeppelin and forge-std security releases | WP-12 |
| 26 | Verify the registry's source on Arbiscan when it is deployed | WP-20 |
| 27 | A benchmark harness test is flaky under load | WP-01 |
| 28 | The buyer's signer signs an Adoption Receipt for any resolution | WP-02 |
| 29 | The bridge trusts the signer socket's directory only partly | WP-02 |
| 30 | Keep the reconciler's backoff in the database | WP-06 |
| 31 | Report x402's unawaited asset check upstream | WP-06 |
| 32 | Purchases stay off when the signer starts after the bridge | WP-06 |
| 33 | A request the server refused before the paid handler looks like a lost answer | WP-06 |
| 34 | The Home page still shows buying as coming soon | WP-16 |
| 35 | The money-path diagram in the economic gates still pays from an x402 challenge | WP-17 |
| 36 | Link the buyer's address to its ERC-8004 agent in one automated step | WP-15 |
| 37 | Show the reputation state on the Status page | WP-10 |
| 38 | Run the ERC-8004 anvil test in CI | WP-12 |
| 39 | Let other sites read the agent registration and evidence files | WP-07 |
| 40 | Make the attester sturdier: adaptive log ranges, a retry limit and a restored-backup guard | WP-07 |
| 41 | Rotating the attester key leaves pending posts unsent | WP-08 |
| 42 | Check at startup that the ERC-8004 identity and reputation registries belong together | WP-07 |
| 43 | `getSummary` gets slower with every feedback | WP-08 |
| 44 | One secret type and one RPC transport for both chain clients | WP-07 |
| 45 | Detect forks in the warranty indexer and rewind | WP-04 |
| 46 | A warranty resend can race another job's first send from the same account | WP-04 |
| 47 | Let warranty revenue go to a cold address | WP-09 |
| 48 | At low volume, a warranty activation can still be matched to its settlement | WP-22 (D6), then WP-05 |
| 49 | Publish distinct-buyer counts on a coarser schedule | WP-05 |
| 50 | Bound the warranty snapshot's memory as history grows | WP-11 |
| 51 | Alert when a release's warranty bond runs out | WP-10 |
| 52 | Keep the attester's outcome-feed cursor across restarts | WP-11 |
| 53 | Page and batch the evaluator's review command | WP-11 |
| 54 | Remember final refund states in the bridge | WP-03 |
| 55 | Close the gaps between the end-to-end run and production wiring | WP-13 |
| 56 | The ERC-8004 register script accepts a bare 64-hex key as an argument | WP-09 |
| 57 | Name the end-to-end run and the Sepolia role script in the root README and CLAUDE.md | WP-17 |
| 58 | List `lemma_claim_refund` on the Get started page | WP-16 |
| 59 | Update the lever-7 note once the warranty pipeline runs on Sepolia | WP-20 |
| 60 | Say each warranty fact in one guide and link to it | WP-17 |
