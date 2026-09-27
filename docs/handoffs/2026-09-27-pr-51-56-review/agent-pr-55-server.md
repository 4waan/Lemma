# PR #55, server and core part: adversarial review

Head 1d98041 (branch `pipeline/outcome-pipeline`), read at the worktree checked out at that commit. Line numbers below are from that checkout. Paths are relative to the repository root.

What was run (allowed single files): `warranty-jobs`, `warranty-indexer`, `warranty-outcomes`, `warranty-server`, `warranty-review`, `persistence` and `packages/core/test/warranty.test.ts` (82 + 47 tests, all pass); `warranty-anvil.test.ts` against the real registry built in `contracts/out` (6/6 pass); two throwaway probes under `scratchpad/probe/nonce-race.test.ts` against the PR's own `FakeRegistry` (results quoted below). Not run: the full suite, the e2e, `db:generate`.

Verdict: **approve for the testnet deployment it targets, with two small fixes I would land before merge** (a config check, and "back off instead of close" on registry reads that contradict the index). No blocking finding. Money safety rests on the contract's own state checks (`ResolutionAlreadyExists`, `ResolutionNotActive`, `NoCredit`), which the outbox cannot get around, so the worst a server bug does is burn one gas fee or leave an action closed; I found no path to a double effect.

---

## 1. PR-body claims (server and core)

### Verified

| Claim | Evidence |
| --- | --- |
| EIP-712 domain, Voucher and Outcome types "copied exactly from the contract" | `packages/core/src/warranty.ts:22-47` vs `contracts/src/ResolutionWarrantyRegistry.sol:108-115` (type strings) and `:237` (`EIP712("Lemma Warranty Registry", "1")`). Field names, Solidity types and order match. `packages/core/test/warranty.test.ts:57-69` asserts the encodeType strings and the domain literal against the contract source text. |
| Typed-data helpers "reproduce the registry's own vectors" | `packages/core/test/vectors/digests.json:341-342` equal `contracts/test/Vectors.t.sol:18-21` (`0x2770a459…`, `0xc4f2af8c…`); `warranty.test.ts:51-55` recomputes them with `hashTypedData` for the vector inputs (chain 421614, registry `0x4c454D4D41…01`, amount 250000, activateBy 1790000000, verdict 2, weight 10000, validUntil 1790003600). Test passes. |
| "Digest vectors only gain entries" | `git diff ea80046 refs/pr/55 -- packages/core/test/vectors/digests.json`: two added lines plus a trailing comma; nothing changed. |
| Strict, versioned `WarrantyVoucher` / `WarrantyOutcome`; verdict codes; withdrawal route schemas | `warranty.ts:100-113` (strictObject + `schemaVersion`, amount `!== "0"`, zero-word refine), `:131-138`, `:50-71` (1/2/3, `verdictOf`), `:241-271` (`WarrantyWithdrawalRequest` strict, answer, refusal enum). Ranges match the contract: `profileIndex` ≤ 255 (uint8), `weightBps` ≤ 10000 (`MAX_WEIGHT_BPS`), `UnixSeconds` fits uint64. |
| `ResolutionView.createdOn` day only; exact time not public elsewhere | `packages/core/src/read.ts:320` (`z.iso.date()`); `apps/server/src/service.ts:273` (`utcDay(r.createdAt)`); the resolution route returns only `ResolutionView` (`apps/server/src/app.ts:244-246`). The public ERC-8004 feedback file carries `createdAt`/`finalizedAt` = the finalization block time (public anyway) and `acceptance` = `{exitCode, durationMs, outputDigest}` (`packages/core/src/receipt.ts:54-58`): no purchase time. The signed `Resolution.createdAt` reaches only the buyer (recovery needs the preview secret). Server logs carry resolution ids with log timestamps, but they are not public. |
| `ResolutionView.warranty` fields; buyers from 3; `StatusView.chain` | `read.ts:268-296` (state, amount, claimDeadline, activation/outcome/expiry/withdrawal/feedback hashes, cross-field refine), `:37-51` (`MIN_PUBLISHED_BUYERS = 3`, `publishedBuyers`), `:77`, `:139`, `:391-420`. |
| Outbox: claim before send; receipt, then nonces, then registry state before a resend; reverts become codes | `apps/server/src/warranty/actions.ts:202` (receipt), `:204-206` (nonces, wait on pending), `:208` (`prepare` reads the registry), `:214-222` (compare-and-set claim to `sent`, attempts+1, lease), `:224` (send). `chain.ts:164-175` (`InsufficientAvailableBond` → `INSUFFICIENT_AVAILABLE_BOND`). |
| "Each sender uses one account and one nonce manager" | True per process: `pipeline.ts:350` (`privateKeyToAccount(key, { nonceManager })`), `chain.ts:281-282`, `:298-303` (`serially` per sender). See finding F1 for what it does not cover. |
| Indexer: `head − WARRANTY_INDEXER_CONFIRMATIONS` (64), adaptive ranges, cursor moves with the rows | `indexer.ts:68`, `:146-161` (halving on `isRpcRefusal`, growth at `:177`), `:168` (`advanceChainCursor(cursor, to+1, rows)`); `db/store.ts:347-366` (one transaction, conditional cursor update first, `onConflictDoNothing` inserts); `persistence.ts:694-707` (memory store, same contract). `config.ts:129,316`. |
| Activator: jitter ≤ 300 s, random `paymentRef`, on-chain roles, 24 h bond retry then alert | `activator.ts:38`, `:110` (`jitter(jitterSeconds)` seconds), `:62`/`:117` (`randomBytes(32)`), `:162-167` (`releaseProblem(release, chain, true)`), `:36`, `:146-150` (`BOND_RETRY_MS`, then `error`-level `warranty.bond_exhausted` and `abandoned`). "Alerts" means an error log only. |
| Evaluator: verified receipts only; passed → PASSED, abandoned → VOID; failed waits unless `auto`; damper weight 0 on the fourth in 30 days | `evaluator.ts:93-97` (query joins `verified = true`, `db/store.ts:476-477`; memory `persistence.ts:781`), `:39-41`, `:110`, `:14-16` (`DAMPER_LIMIT = 3`, 30 d), `:100-105`, `:123-132` (`counted >= 3` excluding this resolution). Tests `warranty-jobs.test.ts:338,361`. |
| Withdrawal route checks the claim hash and the credit before queueing | `relay.ts:224-238`: strict parse, stored `claimHash` equality, existing action answers first, indexed `OutcomeFinalized` verdict 2 and no `CreditWithdrawn`, then insert. |
| `RegistryOutcomeSource` feeds exactly what the engine recorded; `RegistryOutcomeFeed` feeds the attester | `outcomes.ts:145-160`: verdict 1/2, weight > 0, engine in force at the finalization equals the last engine ever set, no `EngineRecordFailed` in the same tx (matches contract `:452-460`, `:601-622`). Feed: `:301-333`. Tests `warranty-outcomes.test.ts:59-129` fold to the fake engine's confidence. |
| Config gates: fully configured or not started; four addresses differ; secrets never printed | `config.ts:284-306`, `:307-317` (`Secret` wrappers); errors name variables only (`:160-167`, `:292`, `:304`); startup log prints addresses only (`pipeline.ts:335`); `describeError` = name + safe code (`errors.ts:8-24`). |
| Store: three tables, one migration | `db/schema.ts:165-236` vs `drizzle/0003_warranty_pipeline.sql:1-45`: enums, columns, types, nullability, primary keys and the three indexes match column for column. Journal entry idx 3 and `meta/0003_snapshot.json` present. |
| "Both stores pass the shared contract suite" | `persistence.test.ts:504-686` (six warranty cases); 47/47 pass here. |
| Anvil test 6/6 against the real registry | Re-run here: 6 passed. |
| Claim secret never logged, dropped once used | `relay.ts:184-186` (`closedPayload` → ref only) applied at `actions.ts:266-271`; logs use `describeError` (name + code). It does sit in `warranty_actions.payload` while the action is open (documented). |
| "The outbox never sends twice after a crash" | `warranty-jobs.test.ts:186-210` (crash between send and write: 1 send), `:212`, `:227`, `:258`. The contract refuses a second effect anyway. |

### Unverified (not re-run here, by instruction)

`npm run verify` totals, `npm run e2e` 7/7, `npm run db:generate` "no schema changes" (journal and snapshot are consistent with a generated migration; drizzle-kit was not re-run because it may write tracked files), gitleaks, `git merge-tree`.

### Misleading or incomplete

- "Each sender uses one account and one nonce manager" does not prevent two jobs of one sender from colliding on a resend's nonce (finding F1, backlog item 46), and it holds per process only; two replicas each have their own manager. `docs/deployment.md:59` deploys one replica, so this is consistent for now.
- "Config and startup gates: … The provider, evaluator, facilitator and attester addresses must all differ" is true, but nothing checks that `PROVIDER_ADDRESS` (the x402 payee every sellable release must pay, `startup.ts:16-18`) is the provider key's address (finding F2).
- "retries a short bond for 24 hours, then alerts": the alert is one error-level log line (`activator.ts:148`); nothing else fires (backlog item 51).

---

## 2. Findings, by severity

### Blocking

None.

### Should fix before merge

**F1. A resend's nonce is read outside the per-sender send queue, so another job of the same account can take it (backlog item 46).**
- Where: `apps/server/src/warranty/actions.ts:204-206` reads `chain.nonces(sender)` and sets `nonce = counts.mined` inside `attempt()`, then `:208` reads the registry, then `:222` claims, then `:224` calls `chain.send(..., { nonce })`. `chain.ts:299-303` (`serially`) and `:393` wrap only the send; the activator and expirer share the provider account, the evaluator and relay the evaluator account (`chain.ts:51-56`).
- Why it matters: the resend goes out with a nonce another job's first send used in the gap. Refused ("nonce too low") or, on a node that shows the other transaction as pending, a replacement attempt that either fails ("underpriced") or, when viem's fresh fee estimate is ≥ 10 % higher, replaces the other job's transaction. No double effect (the contract checks state), and the next attempt heals, but each occurrence costs a failed attempt, a 30 s+ backoff, and can knock out the other job's transaction.
- How verified: probe `scratchpad/probe/nonce-race.test.ts` ("item 46") on the PR's `FakeRegistry`: after `activeWarranty()`, a second purchase whose first activation attempt fails before broadcast (`failSends = 1`), the window advanced past expiry, and a chain wrapper whose `nonces()` runs the expirer before returning. Output: `sent nonces [['activateResolution', 0], ['expireResolution', 1]]`, activator report `failed: 1`, action `{ state: 'sent', attempts: 2, lastCode: 'NonceTooLowError', txHash: null }`; the next attempt activates (`done: 1`). The existing test `warranty-jobs.test.ts:227` covers only one job.
- Smallest fix: read the nonce (and re-check the registry) inside the per-sender queue: pass `prepare`'s decision as a callback into `chain.send`, or have `send` take `nonce: "mined"` and read `getTransactionCount(latest)` itself inside `serially`. The backlog's WP-04 step 2 describes exactly this. Acceptable to merge with WP-04 pending; it is not a money bug.

**F2. `PROVIDER_ADDRESS` is never checked against the provider key's address, and the mismatch fails open on the sales side.**
- Where: `apps/server/src/config.ts:284-317` derives `providerAddress` from `PROVIDER_PRIVATE_KEY` (`:294`) and never compares it with `e.PROVIDER_ADDRESS`. `startup.ts:16-18` requires every sellable release's `payTo` to equal `PROVIDER_ADDRESS`; `admin.ts:392` requires `payTo` to equal the on-chain provider at registration; `actions.ts:356` (`releaseProblem`) requires the on-chain provider to equal the key's address. So the key's address must equal `PROVIDER_ADDRESS`, or every activation is `skipped` with `RELEASE_ROLES_MISMATCH` (`activator.ts:163-167`) at warn level, while purchases with claims keep settling and every buyer's warranty shows `none`.
- Why it matters: buyers pay for a warranty that never activates; the only signal is a warn log per resolution.
- How verified: code reading of the four sites above; no test covers the mismatch.
- Smallest fix: in `warrantyConfig`, `if (e.PROVIDER_ADDRESS !== provider) throw new ConfigError("PROVIDER_PRIVATE_KEY is not PROVIDER_ADDRESS's key: register-release requires each release's payTo to be the provider")`. One line plus a test next to `warranty-server.test.ts:83`.

**F3. A registry read that contradicts the indexed facts closes finalize, expire and withdraw actions for good instead of backing off.**
- Where: `evaluator.ts:172` (`status !== "active"` → `endedBy` → `abandoned` when the status is `none`), `expirer.ts:89,79-81` (`none` → `skipped`), `relay.ts:166,155-157` (anything but `failed`/`refunded` → `abandoned NO_CREDIT`). Each of these actions exists only because the indexer stored the matching event 64+ blocks deep (`listWarrantiesToEvaluate`, `listWarrantiesToExpire`, `requestWithdrawal` at `relay.ts:233-236`), so on a correct chain the registry can never answer `none` for them, nor `active` for a withdrawal. `chain.ts:378` pins the reads to `getBlockNumber({ cacheTime: 0 })`, which a lagging backend of a load-balanced endpoint answers with an old number.
- Why it matters: money. A stale `none` on a finalization abandons it; the warranty then expires and the buyer's failed outcome pays no credit. A stale `none` on an expiry leaves the provider's bond reserved until someone calls `expireResolution` by hand. A stale `active` on a withdrawal answers the bridge `abandoned` for good (one action per resolution and kind, `db/store.ts:387-407`), and the route keeps answering that state (`relay.ts:231-232`). The docs' claim that "a wrong read cannot change what a send does" (`docs/security-model.md:111`) is true, but a wrong read can end an action.
- How verified: code reading; the fake chain has no lagging-read mode for `resolution()`, so no test covers it. Likelihood is low (the backend must lag more than the depth plus a job interval), but the fix is small and strictly safer.
- Smallest fix: in each `prepare`, treat a status that the action's own origin rules out (`none` for finalize/expire; `none`/`active` for withdraw) as `{ kind: "backoff", code: "STALE_READ" }` rather than a final state. The `onRevert` paths stay as they are (a revert is the sequencer's word).

### Follow-up

**F4. `RegistrySnapshot.rebuild` is quadratic per key and runs synchronously on the event loop (extends backlog item 50).**
- Where: `outcomes.ts:159` (`grouped.set(key, [...(grouped.get(key) ?? []), f])`) and `:174` copy the whole array for every finalization; `:149` reverses `engineSets` and `:157` scans them per finalization. `rebuild()` runs after every indexer run that stored a row (`:98`, `pipeline.ts:323`).
- Measured (probe "item 50", `MemoryStore`, one key): incremental refresh of one new outcome takes 177 ms at 5,000 finalizations and 6,602 ms at 20,000 (37× for 4× n); the first refresh at 20,000 took 6.9 s. During that time no request is served.
- Fix: `push` into the grouped arrays (two lines); keep `fed`/`recorded` incremental instead of rebuilding. Memory growth (all activations, finalizations, payers, pauses kept) is item 50 as written.

**F5. Fork detection and a lagging `eth_getLogs` backend (backlog item 45).** `chain_cursors` has only `name`, `next_block`, `updated_at` (`db/schema.ts:232-236`); `indexer.ts:144-178` compares nothing to a block hash; a range past a lagging backend's head returns short without an error and the cursor moves past it (`indexer.ts:115-118`, test `warranty-indexer.test.ts:129` shows the depth is the only protection). 64 blocks is about 16 s on Arbitrum (`indexer.ts:62-68`); public RPC providers can lag more than that on log queries. Documented (`docs/server-runtime.md:114`, `docs/security-model.md:132`) and scheduled (WP-04).

**F6. A failed receipt in `review` is not protected from expiry, and the operator sees no deadline.** `listWarrantiesToExpire` excludes only finalizations in `queued`/`sent` (`db/store.ts:494`, `persistence.ts:790`); the expirer expires an active warranty whose finalization is still in `review`, and `closeEndedReviews` then abandons it as `WARRANTY_ENDED` (`evaluator.ts:135-151`). The contract forbids a late finalization anyway (`ClaimWindowClosed`, contract `:430`), so this is a design consequence, but `list` prints only "waiting 3h 20m" (`review.ts:288`) and nothing alerts before the window closes. A slow operator silently turns a buyer's refund into the provider's bond. Fix: print the claim deadline in force in `listReview`, and log at error level when a review is within, say, 12 h of it.

**F7. Attester cursor in memory (item 52).** `apps/server/src/reputation/attester.ts:109` (`private cursor: string | null = null`); every restart re-reads the feed from the start and re-logs each skip code. `RegistryOutcomeFeed` already takes a cursor string (`outcomes.ts:301`), so `chain_cursors` could hold it.

**F8. Evaluator command paging (item 53).** `review.ts:233` (`limit = 100`), `:322-330` (`decide` takes exactly one id).

**F9. Bond exhaustion alert (item 51).** `activator.ts:148` is the only signal.

**F10. Multi-replica sends.** Two server processes would each run a nonce manager per sender and both first sends would take the same pending nonce (`chain.ts:401-409`). Fine while `docs/deployment.md:59` deploys one replica; worth a sentence in the deployment guide.

### Nits

- `config.ts:157`: `WARRANTY_SWITCHES` leaves out `EVALUATOR_FAILURES`, `WARRANTY_ACTIVATION_JITTER_SECONDS` and `WARRANTY_INDEXER_CONFIRMATIONS`; setting only those silently does nothing.
- `review.ts:241`: `releaseDigest: release?.releaseDigest ?? action.resolutionId` prints a resolution id where a digest is expected when the row is missing.
- `persistence.ts:773-777`: the memory store's `listResolutionsToActivate` is unordered while `db/store.ts:466` orders by `updatedAt`; harmless, but the contract suite would not catch an ordering-dependent job.
- `outcomes.ts:304-316`: an outcome passed over with `NO_RECEIPT` or `RELEASE_NOT_IN_CATALOG` is behind the cursor for good; a release re-added to the catalog later is never fed.
- `registry_events` rows are persisted objects that are not a core schema; they are chain facts checked by `checkRegistryEvent` (`persistence.ts:841-861`). Reasonable, but note it against the CLAUDE.md rule when the PR is described.

---

## 3. Backlog items 7, 45 to 53, 55

| Item | Accurate? | Code fact | Merge impact |
| --- | --- | --- | --- |
| 7 (distinct-buyer counts, per-buyer cap) | Accurate: done by this PR. | `evaluator.ts:14-16,123-132` (limit 3 per payer, release digest and profile index, 30 days, finalized or in flight); `read.ts:37-51` (published from 3); `outcomes.ts:183-185` (distinct payers); `docs/reputation-and-confidence.md:27-35`. | None; close on merge. |
| 45 (fork detection, lagging backend) | Accurate. | No block hash stored (`db/schema.ts:232-236`); no comparison in `indexer.ts:144-178`; a short answer past a lagging backend's head advances the cursor (`indexer.ts:115-118`). | Not blocking for testnet; P0 before real money (WP-04). |
| 46 (resend nonce race) | Accurate, now demonstrated. | `actions.ts:204-206` reads `nonces(sender)` outside `serially` (`chain.ts:299-303,393`); `:224` sends with that nonce. Probe: refused as `NonceTooLowError`, healed next attempt (finding F1). The "replaces if fees rose 10 %" branch follows from viem re-estimating fees for the explicit-nonce resend (`chain.ts:403-421`); not probed. | Not blocking; fix in WP-04. |
| 47 (revenue to a cold address) | Accurate. | `admin.ts:392` requires `payTo === PROVIDER_ADDRESS`; `actions.ts:356` requires the on-chain provider to be the hot key; `docs/security-model.md:100` says so. See F2 for the missing config check. | None. |
| 48 (activation matched to settlement at low volume) | Accurate. | Jitter ≤ 300 s (`activator.ts:38,110`); `ResolutionActivated` carries `amount` (contract `:174-181`, decoded `chain.ts:227`) equal to the price (`activator.ts:116`); the day-only `createdOn` does not help against the on-chain transfer. Documented (`docs/security-model.md:103`). | Decision D6. |
| 49 (counts refresh every indexer run) | Accurate. | `pipeline.ts:323` (`onIndexed: () => snapshot.refresh()`), `outcomes.ts:169,179` recount payers on every rebuild. | WP-05. |
| 50 (snapshot memory) | Accurate, and understated: rebuild is also quadratic and synchronous (F4, measured 6.6 s at 20k). | `outcomes.ts:41-47` keep everything; `:159,174` copy arrays per finalization. | Cheap part (push instead of copy) could land now. |
| 51 (bond alert) | Accurate. | `activator.ts:146-150`: error log then `abandoned`. | WP-10. |
| 52 (attester feed cursor) | Accurate. | `reputation/attester.ts:109,224-227`. | WP-11. |
| 53 (evaluator paging/batching) | Accurate. | `review.ts:233` (100), `:324` (one id). | WP-11. |
| 55 (e2e vs production wiring) | Mostly accurate; one correction. | `main.ts` runs nowhere in the e2e (`e2e/lib/server.ts:79-120` assembles in process); `EVALUATOR_FAILURES: "auto"` at `e2e/outcome-pipeline.e2e.ts:92`; `startPaymentPath` takes no intervals so the e2e stops and restarts its jobs (`e2e/lib/server.ts:95-96`); `forge fmt --check` runs only in `contracts` (`.github/workflows/ci.yml:89-90`). **Correction:** `startReputation` does take `attesterIntervalMs` (`reputation/index.ts:41,68`; used at `e2e/lib/server.ts:116`), so only `startPaymentPath` needs the change. | WP-13. |

---

## 4. Protocol-owner lane (EIP-712 layouts, signing, relayers)

- Layouts: `packages/core/src/warranty.ts:22-47` reproduce the contract's two type strings and domain; the vector test ties both sides (`Vectors.t.sol:95-124` also checks against Foundry's own encoder). The startup probe (`pipeline.ts:270-300`) refuses a registry whose `hashVoucher` differs from core's for a fixed voucher, so a deployed registry with another domain or layout stops the server.
- Signing: keys live only in `viemWarrantyChain` (`chain.ts:388-389`, `signTypedData` on the local accounts); nothing outside the chain client sees them; `Secret` wrappers in config. Re-signing keeps the same `paymentRef` (`activator.ts:172`), so a stale voucher relayed by anyone still cannot activate a second time (`PaymentRefAlreadyUsed`, and `ResolutionAlreadyExists` first).
- Relayers: `SENDER_OF` (`chain.ts:51-56`) fixes provider → activate/expire, evaluator → finalize/withdraw; the facilitator sends nothing. The relay's `withdrawCredit` puts `to` and the claim secret in public calldata next to the resolution id (item 6, bridge lane WP-03).
- Please have the owner look at: F1 (the nonce path inside `send`), the `gas = estimate + 20 %` rule for `finalizeOutcome` against `ENGINE_GAS_RESERVE` (`chain.ts:411`, contract `:133,615`; the estimate already includes the reserve check, and the anvil test exercises it), and the fake registry's revert order (below).
- Fake fidelity: `apps/server/test/fake-registry.ts:345-431` follows the contract's check order for each call (pause first via the modifier; activate: expired → unknown release → inactive → exists → ref used → signature → bond; finalize: not active → expired → window closed → signature; expire; withdraw: no credit → recipient → claim). It omits `ZeroAmount`, `InvalidVoucher`, `InvalidVerdict`, `InvalidWeight` (core schemas make them unreachable) and `InsufficientGasForEngine` (covered by the `refusing()` wrapper test at `warranty-jobs.test.ts:585`). Reverted-when-mined and a mempool with nonce order and replacement are modelled (`:211-227`, `:258-284`). The anvil test passes against the real contract.

---

## 5. Suspicions not confirmed

- A send that throws after broadcast: `sendRawTransaction` is the last await in `send` (`chain.ts:423-424`); a transport error after the node accepted the transaction leaves `attempts = 1, txHash = null`, and the next attempt reads nonces and the registry (`actions.ts:200-208`) and closes `done`. Verified by reading and by `warranty-jobs.test.ts:186` (a crash after the send). Not a bug.
- Claim lease vs send deadline: `SEND_DEADLINE_MS` = 2 min ≤ `ATTEMPT_LEASE_MS` = 5 min (`reputation/attester.ts:59,62`; `actions.ts:213,224`); the deadline is checked after the queue wait and before broadcast (`chain.ts:422`); the receipt wait (30 s) is outside the queue. `SIGN_MARGIN_SECONDS` 180 > 120 s (`activator.ts:34`). Consistent.
- A stale voucher (`activateBy` set on the server's clock at discovery, `activator.ts:120`) is re-signed from the chain's clock when within the margin or after `VOUCHER_EXPIRED` (`:170-174`). Fine.
- `finalizeOutcome` after expiry: `evaluator.ts:172-180` abandons on `expired` or a closed window; test `:383`. Fine.
- Withdrawal route griefing: one action per resolution; a request costs three store reads and is rate limited with `/api/v1` (`warranty-server.test.ts:321`); a buyer who withdraws on their own between the simulation and the send costs the evaluator one reverted transaction at most (`NoCredit`). Bounded.
- Damper and per-buyer privacy: the `DAMPED` code and weights appear only in internal logs (`evaluator.ts:114`); the on-chain weight 0 is documented as public (`docs/reputation-and-confidence.md:56`).
- `buyers <= outcomes` refine (`read.ts:80`): both come from the same snapshot key (`outcomes.ts:168-169`), so a count cannot exceed the outcomes; a mismatch would only cost one profile its confidence (`compatibility.ts:83-89`).
- Money types: `amount` stays a string or `bigint` end to end (`chain.ts:227,237,240`, `numeric(78,0)` column, `UsdcAtomic` in the voucher); no float found.
- Migration 0003 vs `schema.ts`: identical column for column; whether drizzle-kit regenerates cleanly was not run.
