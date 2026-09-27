# Adversarial review of PR #53 (payments/x402-paid-path, head 9b92151)

All line numbers are from `git show refs/pr/53:<path>`. x402 line numbers are from the installed 2.27.0 packages in the worktree (`node_modules/@x402/...`). Nothing under the repository or the worktree was modified; probes live in `scratchpad/probe/`.

Verdict: no money-losing defect found. Two things should be fixed before merge (one privacy hole that contradicts the PR's own central claim, one bypassed input check that fails closed only thanks to the database driver); the rest are follow-ups, most already in the backlog. The four payment test files pass in the worktree (PR #55 head, a superset): 4 files, 75 tests, 9.3 s (indicative only; not this PR's exact tree).

## 1. PR-body claims: verified, unverified, false

### Verified (with evidence)

| Claim | Evidence |
| --- | --- |
| `derivePaymentNonce` is a new digest kind; the nonce cannot be joined to the resolution id without the preview id; deterministic | `packages/core/src/purchase.ts:19-21` = `digest("payment-nonce", {resolutionId, previewId})`; kind registered at `canonical.ts:23`; `digest` is keccak256 over canonical JSON (`canonical.ts:98-101`), so the same inputs give the same nonce and inverting it needs the 256-bit random preview id (`apps/server/src/main.ts:130` `randomBytes(32)`). Vector added (`digests.json` diff, additions only). |
| `paymentRequirementsFor` gives deep-equal `accepts`/`accepted` with EIP-55 addresses | `purchase.ts:59-73` (`getAddress` on asset and payTo); server side `registrar.ts:15-18,55`, bridge side `buy.ts:126,149`. x402 matches with `paymentRequirementsMatchAccepted` (`@x402/core/dist/esm/chunk-FV2JN4FK.mjs:2046-2058`): case-sensitive `deepEqual` of the non-`extra` fields and a subset check of `extra`. Both sides call the same function, so they match; end-to-end tests run the real x402 server scheme (`apps/bridge/test/buy.test.ts:195`). |
| `BuyInput { previewId, claimHash }` strict | `purchase.ts:82` `z.strictObject`. |
| `warrantyClaimHash` and versioned strict `WarrantyClaim` | `purchase.ts:95-98` (`keccak256(abi.encode(bytes32,bytes32,address))`), `purchase.ts:108-110` (`strictObject`, `schemaVersion: "1"`, refine that `claimHash` matches). |
| `adoptionReceiptTypedData` (domain Lemma/1, chainId) commits to the whole receipt | `signing.ts:18-40`: message = `{resolutionId, outcome, receiptDigest}` where `receiptDigest = adoptionReceiptDigest(receipt)` = digest of the receipt with `signature: null` (`receipt.ts:88-90`). |
| Paid tool registered per request only with an open quote; otherwise the same name answers a code and charges nothing | `apps/server/src/payments/registrar.ts:36-65`: `tools/list` or any non-buy call → `unpaid(NOT_FOUND)` (38-39); bad input → tool answering `BAD_INPUT` (40-44); `quote` failure → `UNAVAILABLE` (45-51); `NOT_FOUND/NO_OFFER/QUOTE_EXPIRED` → `unpaid` (52); only then `createPaymentWrapper` (54-63). Unpaid variants have no payment wrapper, so nothing is verified or settled. |
| In-process facilitator, exact scheme, EIP-3009 only, Permit2 refused, no public endpoints | `facilitator.ts:65-95`: one `x402Facilitator` registered for `eip155:421614` with `ExactEvmFacilitatorScheme` only (68); `onBeforeVerify`/`onBeforeSettle` hooks abort unless `isExactEip3009Payload` (66-68) with `ExactEip3009Payload` a `strictObject` (`handler.ts:65`). x402 honours the abort: before-verify → `{isValid:false, invalidReason}` (`@x402/core/dist/esm/facilitator/index.mjs:190-198`). `apps/server/src/app.ts` has no `/verify`, `/settle` or `/supported` route (grep), README:56 says so. x402 really does route by payload shape: `isPermit2Payload = "permit2Authorization" in payload` (`@x402/evm/dist/esm/chunk-BPTXPSEK.mjs:6-8`), used at `exact/facilitator/index.mjs:814-830`. |
| Handler takes payer, nonce, window only from the verified payment; refuses wrong nonce or a longer window before storing | `handler.ts:132` reads `context.meta["x402/payment"]`, which x402 verified before calling the handler (`@x402/mcp/dist/esm/index.mjs` `processPaidToolCall`: `verifyPayment` then handler). Payee/amount recheck 134, window 136, nonce 138-139, all before `prepare` at 142. Tests `payments.test.ts:181,192`. |
| Reconciler: chain clock, quoted-terms check, bisection, adaptive ranges, backoff | `reconciler.ts:136-139` waits while `head.timestamp < row.validBefore`; `chain.ts:153-175` `outcomeOfUse` requires the log right after `AuthorizationUsed` to be USDC's `Transfer(payer→payTo, amount)`; `chain.ts:184-205` bisection; `chain.ts:111-128` halve on `isRpcRefusal`, double back to `LOG_CHUNK_BLOCKS`; `reconciler.ts:117-120,141-143,206-210` per-row backoff. |
| Receipt verifier: EOA, ERC-1271, ERC-6492 | `receipts.ts:61-65` → `chain.ts:225-237` viem `verifyTypedData` on a public client (deployless universal validator). `markReceiptVerified`/`markReceiptChecked` are single conditional updates (`store.ts:188-195`, `persistence.ts:296-301`). Tests `payment-jobs.test.ts:311-351`. |
| Store: `claim_hash`, `checked_at`/`verified`, settlement keyed by authorization, one generated migration | `schema.ts:65,89,91,93`; `store.ts:119-126` `markSettled` conditions on `resolution_id` and `nonce`, not the transaction; `0001_payment_path.sql:1-4` = drop `resolutions_settlement_idx`, add `checked_at`, add `claim_hash`, partial index on unchecked receipts; snapshot `0001_snapshot.json` carries the same and no settlement index. Matches `schema.ts` exactly. |
| `FACILITATOR_PRIVATE_KEY` and RPC URL held as secrets; RPC errors scrubbed; `PAID_TOOLS=on` fails closed | `config.ts:40-62` `Secret` (`toString/toJSON/inspect` → placeholder), `:150-152` the three gates, `:154-161` key validated without echoing, `:170-174`. `rpc.ts:17-32,40-55` new Error with the URL and any `scheme://` removed, `code`/`data` kept. `index.ts:60-66` refuses a missing secret or a wrong chain id; `main.ts:114-120` exits on failure. Test `payment-jobs.test.ts:548-555`. |
| Signer: key file 0600, socket dir check, allowlisted payees, per-purchase and rolling daily caps, 10–600 s window, USDC `TransferWithAuthorization` on Arbitrum Sepolia only, receipts, never returns/logs the key | `keyfile.ts:22-42` (symlink refused 29, `O_NOFOLLOW` 30, inode 33, mode `& 0o077` 34, uid 35), `:50-67` (`O_CREAT|O_EXCL` 0600). `socket.ts:59-70` directory check, `:86-113` umask 0177 listen then chmod 0600/0660. `signer.ts:89-116`: `TransferAuthorization` strict with `validAfter: "0"`; lifetime ≥ 10 s (26, 94-95); `checkSpend` with the signer's own constants for network/asset and `maxTimeoutSeconds: lifetime` (98-100, so > 600 s is `AUTHORIZATION_TOO_LONG` via `policy.ts:51`/`core policy.ts:76-78`); domain constants own (106-111). Logs carry `to/value/resolutionId/outcome/code` only (`socket.ts:149,156,162,166`; `main.ts:73,80`). |
| Bridge: `checkPurchase` against a locked, atomically written ledger; one MCP call; delivery checked; recovery never pays twice; ≤ 600 chars | `buy.ts:127-128` (`ledger.reserve(..., committed => checkPurchase(...))`), `ledger.ts:72-83,142-150,170-180` (lock file, `O_EXCL`, stale-lock break under a second exclusive file), `:128-140` (temp + fsync + rename, mode 0600). One `callTool` (`remote.ts:171-184`). `buy.ts:200-212` `matching` checks id, preview id, buyer, profile digest, release and terms; `ResolutionDelivery` refines bundle digest (`tools.ts:76-82`). Lost answer → `recovered` (`buy.ts:152-158,192-197`); the nonce is deterministic so a retry signs the same nonce and USDC refuses a second use. `MAX_TOOL_TEXT = 600` (`text.ts:6`), `cap` at `buy.ts:221`. |
| Warranty claim kept in `claims/` mode 0600; only the hash is sent | `inbox.ts:275-293` (temp 0600, `linkSync` into place, `EEXIST` keeps the first), `buy.ts:132-135,154`. |
| `.env.example`: atomic amounts, `BUYER_PRIVATE_KEY` removed | diff confirms. |
| Tests run the real x402 facilitator against a fake USDC over in-memory MCP | `payments.test.ts:54-79` (`paymentResourceServer(inProcessFacilitator(usdc))`), `fake-chain.ts:22-29` (signatures recovered by x402 itself). Named cases exist for every bullet in the PR body's list (`payments.test.ts:135-424`, `payment-jobs.test.ts:74-555`, `buy.test.ts:195-421`, `signer.test.ts:86-280`). |
| Digest vectors: additions only | `git diff 10423444 refs/pr/53 -- packages/core/test/vectors/digests.json`: one new vector (`payment-nonce`) and three new `derived` values; nothing changed or removed. |
| The x402 upstream defect the workaround addresses exists in 2.27.0 | `@x402/evm/dist/esm/exact/facilitator/index.mjs:140` starts `startAssetContractCheck` (a promise that **throws** when `getCode` rejects, `chunk-BPTXPSEK.mjs:74-83,94-98`), then returns early at 153-162, 170-179, 181-190, 192-201, 202-211, 212-221 without ever reaching `await assetCheck.await()` at 222. Same pattern in `verifyPermit2` (440 vs 511). The workaround `getCode: (args) => reader.getCode(args).catch(() => undefined)` (`facilitator.ts:131`) turns the rejection into `asset_not_deployed_contract` (`chunk-BPTXPSEK.mjs:81-83`); `classifyErc6492Payer` already swallows `getCode` failures (`chunk-BEMCJZKA.mjs:15-20`), so "treats the payer as an EOA" is accurate. Test `payments.test.ts:279-308`. |

### Unverified (could not be checked here)

- "`npm run verify`: 33 files / 669 tests" and "`git merge-tree` merges cleanly with #31 to #35 and #37; merged with #33 the tree passes verify": not reproducible from this environment (full suite not run; other PR refs not compared). GitHub reports `mergeable_state: clean` against `main` only.
- "`npm run db:generate`: no schema changes": not run (worktree is at PR #55). The committed snapshot matches `schema.ts` field for field (see above), which is the observable consequence.
- "the Get started page lists the signer and the spending limits": not reviewed (web scope excluded).

### False or overstated

- "the public nonce cannot be joined to the public resolution id without the preview id" (PR body, `docs/security-model.md:56`). True of the nonce, but the public resolution view defeats the purpose: see finding F1. With this PR the resolution id can be joined to the payer wallet by timing alone, nonce or no nonce.
- "Before storing anything, it refuses ... a window longer than quoted": bypassable for a `validBefore` of 13–15 digits (finding F2). Nothing is charged on Postgres, but the refusal itself does not fire.

## 2. Findings, by severity

### Blocking

None found. No path was found in which a buyer is charged twice, charged without delivery being recoverable, or delivered without a settlement the reconciler can confirm.

### Should fix before merge

**F1. The public resolution view joins a resolution id to the payer wallet (privacy).**
- Where: `apps/server/src/service.ts:262` (`createdAt: r.createdAt`), `packages/core/src/read.ts:136` (`createdAt: IsoTimestamp`, millisecond precision), served by `apps/server/src/app.ts:215-221` (`GET /api/v1/resolutions/:id`, cacheable) together with `terms.amount` and `terms.payTo` (`read.ts:135`).
- What: `createdAt` is set inside `prepare` (`service.ts:166`), which runs in the paid handler seconds before x402 sends `transferWithAuthorization`. An observer holding a resolution id (public by design, `receipt.ts:12-13`) reads `createdAt`, `payTo` and `amount`, then looks for USDC `Transfer(payer → payTo, amount)` on Arbitrum Sepolia in the following seconds. At testnet volume that is one transfer. So the very linkage `derivePaymentNonce` exists to prevent is available to anyone, and the PR body's and `docs/security-model.md:56`'s claim is void in practice.
- How verified: read the handler/settlement order (`handler.ts:142` then x402 `settlePaymentResult`, `@x402/mcp/dist/esm/index.mjs` lines 1080-1141) and the view. The view pre-dates this PR (base `service.ts:233`), but the on-chain transfer it can be matched against is new here. PR #55's tree already replaces it with a UTC day (`createdOn: z.iso.date()`, worktree `packages/core/src/read.ts:319-320`, `service.ts:273`), which shows the authors reached the same conclusion later.
- Smallest fix: return the UTC day only (`createdOn`), as #55 does; it is a read-model change (no digest vectors). Also keep the dashboard from showing settlement time.
- Merge impact: only live once `PAID_TOOLS=on` with a sellable release, which the PR says does not exist yet; still, merging the claim with the hole invites a deployment that leaks. Blocking if it ships to the public deployment as is.

**F2. The "window no longer than quoted" refusal is skipped for an out-of-range `validBefore`.**
- Where: `apps/server/src/payments/handler.ts:51` (`validBefore: /^[0-9]{1,15}$/`), `:98` (`new Date(Number(validBefore) * 1000)`), `:136` (`auth.validBefore.getTime() > ...`).
- What: any value ≥ 8640000000001 (13–15 digits) yields an Invalid Date; `NaN > x` is false, so the refusal at 136 does not fire. x402 accepts it (`verifyEIP3009` only checks `validBefore ≥ now+6`, `exact/facilitator/index.mjs:192`) and so would USDC. The row would then be written with a NaN `validBefore`. On Postgres, drizzle's `toISOString()` throws, `safeStore` turns it into a `StoreError`, the handler answers `UNAVAILABLE` and x402 cancels settlement (nothing charged, fails closed by accident). With `MemoryStore`, the row is stored, sold and settled; it never appears in `listUnsettled` (`persistence.ts:264` `r.validBefore < before` is false for NaN), so if the settlement hook's commit fails the row is unrecoverable and the sale is delivered nowhere.
- How verified: probe `scratchpad/probe/date-probe.mjs` (`999999999999999` and `8640000000001` → Invalid Date, comparison false, `toISOString` throws `RangeError`); code reading of the stores. The existing test (`payments.test.ts:192`) covers only a too-long but valid window.
- Smallest fix: in `authorizationOf` return `undefined` when `!Number.isFinite(validBefore.getTime())`, or tighten the regex to `^[0-9]{1,11}$` (valid until year 5138). Add the 15-digit case to the window test.

### Follow-up (not merge-blocking; several are already backlog items)

**F3. Item 33 confirmed, with a correction to the planned fix.** `remote.ts:171-184` throws on any transport or HTTP failure (`client.callTool` rejects on a 429 before x402 runs; no status classification). `buy.ts:152-157` treats every throw as a lost answer → `recovered` → `ctx.recover()` (which also fails on a 429, `recovery.ts:20-25` `waiting++`) → `SETTLING_TEXT`; the pending mark stays until `recoverPending` sees `NOT_FOUND` more than `PENDING_GIVE_UP_MS` (15 min, `recovery.ts:5,27-31`) later; the ledger entry stays `reserved` and counted for `DAY_MS` (`ledger.ts:9,109-112`). Correction: the signer keeps its own reservation (`signer.ts:98-104`) and exposes no release endpoint (`socket.ts:140-159` has only `/address` and the two `/sign/...` routes), so releasing the bridge's reservation on a 429 still leaves the signer's daily cap consumed for 24 h. WP-06 step 3 must either accept that or add a signer-side release for nonces the bridge never transmitted (the signer cannot verify that claim, so it is a policy choice).

**F4. Item 30 confirmed.** `reconciler.ts:87` `private readonly backoff = new Map(...)`; comment at 80-81 admits restart behaviour. Across a restart every undecided row is judged once more; with two replicas each keeps its own map, both judge the same rows every run (double RPC reads and double `commit`/`expire` attempts). Safe because `markSettled`/`markExpired` are single conditional updates (`store.ts:119-135`), so the second replica gets `UNCHANGED` and backs off (`reconciler.ts:184,193,199-203`).

**F5. Item 28 confirmed, with a correction to WP-02.** `signer.ts:118-123` signs any schema-valid receipt for any resolution id; `socket.ts:152-157` serves it to any process of the user. Posting needs the preview id (`service.ts:237-241`), but the tests run as the user and the inbox is theirs to read: `resolutions/<id>.json` holds `resolution.previewId` in a 0600 file under 0700 directories (`inbox.ts:131-137,315-320`), and `lemma_verify_adoption` runs the recipe (`adoption.ts:180`) before it creates, signs and posts its own receipt (`adoption.ts:199-208`). The bridge's later post answers `DUPLICATE`, recorded as final (`recovery.ts:58-60`, `adoption.ts:186` reports "recorded-before"), so the forgery is silent. Correction: WP-02 step 1 (signer records resolution ids from transfer signing and signs a receipt once per id) does not close this: the test can ask first for the resolution the bridge just bought (id readable from the inbox), and then the bridge's own receipt cannot be signed at all. Only step 2 (hide the socket and state directory from the recipe's namespace) or a server-side channel the tests cannot reach fixes it. `docs/security-model.md:71` states the gap honestly.

**F6. Item 29 confirmed.** `socket.ts:59-70` checks only `dirname(socketPath)`: a symlink, group/other write bits, and ownership only when `ownedByMe` (the signer). The bridge passes `ownedByMe: false` (`payments.ts:59`) and checks once at startup, then connects per call (`buy.ts:118,139`), so a parent directory another user can rename or write to (`/x/shared-0777/x/s.sock`) passes and can be swapped later (TOCTOU). Pinning the buyer address (backlog's `LEMMA_BUYER_ADDRESS`) makes an impostor's signatures fail x402 verification; it still lets the impostor learn purchase terms and receipts.

**F7. Item 32 confirmed.** `payments.ts:61-66`: `await signer.address()` once; failure returns `absent` with no `registerPaidTools`, so the tool is never registered until the bridge restarts. `buy.ts:117-121` already answers `SIGNER_UNREACHABLE_TEXT` per call, so registering unconditionally (once the policy parses and the directory check passes) is a small change.

**F8. Item 6 confirmed.** `buy.ts:131` `const refundTo = deps.refundTo ?? buyer;` and `payments.ts:88-90` returns `address: undefined` when `LEMMA_REFUND_TO` is unset or empty. The stderr note exists (`payments.ts:73-76`).

**F9. Byte-equality of `accepts`/`accepted` is an x402 implementation detail.** It works because 2.27.0's server scheme leaves the core fields untouched and `paymentRequirementsMatchAccepted` only needs `extra` to be a subset (`chunk-FV2JN4FK.mjs:2046-2058`); the bridge never asks for a challenge (`buy.ts:181-189` refuses to pay one). Any x402 upgrade that enriches `accepts` (a new `extra` field, address normalisation) silently turns every purchase into "No matching payment requirements found". `apps/server/README.md` has no upgrade checklist yet (backlog item 31 asks for one); pin 2.27.0 and add the checklist.

**F10. `startPaymentPath` makes an RPC blip at boot fatal.** `index.ts:64-70` (`getChainId`, `getBalance`) throw → `main.ts:119` exits. Fails closed, but an availability nit for a chain check that could be retried.

**F11. The signer silently ignores a relative `LEMMA_STATE_DIR`.** `signer/paths.ts:27` falls back to the default state directory, while the bridge refuses one (`inbox.ts:25`). The key and ledger can land where the operator did not intend.

**F12. Persisted bridge records vs. the "strict, versioned schema from core" rule.** `LedgerFile` (`ledger.ts:31`) is strict and versioned but lives in the bridge; `Pending`, `StoredReceipt`, `PreviewContext`, `Link`, `Adapting` (`inbox.ts:55-115`) are strict but unversioned (pre-existing). Not a regression from this PR; `WarrantyClaim`, the only new persisted core object, follows the rule.

### Nits

- `buy.ts:127`: `known` is read outside the ledger lock; harmless (same nonce, same bridge), but `reserve` could return whether the nonce was already held.
- `buy.ts:128-130`: the reservation is taken before `markPending`; if `markPending` throws the reservation stays counted for 24 h with nothing signed.
- `handler.ts:134` re-checks payee and amount that x402 verified; fine as defence in depth, but the `UNSUPPORTED_PAYMENT` text (33) then blames the buyer's clock for a payee mismatch.
- `registrar.ts:42` registers the `BAD_INPUT` variant without an `inputSchema`, so `tools/list` in that one request advertises no schema; cosmetic.
- `reconciler.ts:104` `batch ?? 100` duplicates `PAGE_SIZE`; the two are coupled by the paging logic.

## 3. Issue #29: the ten asks

| # | Ask | Done? | Where / why not |
| --- | --- | --- | --- |
| 1 | Map every `prepare` refusal to `isError`; pass verified payer, nonce, `validBefore` | Done | `handler.ts:140-150` (refusal for `!result.ok`, `UNAVAILABLE` on throw), `:142` passes `{payer, nonce, validBefore}` from the verified payload. |
| 2 | Never throw in `onAfterSettlement`; call `commit(resolutionId, {nonce, settlementRef})` | Done | `handler.ts:164-181`; `service.commit` itself never throws (`service.ts:185-195`). x402 would otherwise report "Settlement failed" for a settled payment (`@x402/mcp` 1094-1141, hook awaited inside the try). |
| 3 | Reconciler over `listUnsettled` calling `expire` or `commit` | Done | `reconciler.ts:101-190`, `chain.ts`. |
| 4 | Nonce not the resolution id; derived from resolution id and preview id under its own digest kind | Done | `purchase.ts:19-21`, `canonical.ts:23`; enforced server-side `handler.ts:139`. |
| 5 | Build `accepts` per request from `quote`; paid results as JSON text | Done | `registrar.ts:47,55`; `handler.ts:152`. |
| 6 | Verify stored receipts against the payer and mark verified; history counts only verified receipts | Partly | Verifier and `markReceiptVerified` done (`receipts.ts`, `store.ts:179-195`); `ResolutionView.receipt.verified` exposed (`read.ts:137-138`). No consumer of "compatibility history" exists in this tree (grep: only the comment), so the counting rule is not implemented here. |
| 7 | Export `SpendLedger.entriesFor(resolutionId)` (amount, gas, transaction) for the benchmark's `PaymentSource` | Not done | `ledger.ts` has `entries()` only, keyed by nonce, with no gas or transaction; `packages/benchmark/src/runner.ts:16-26` still has `noPayments`. Needs its own issue. |
| 8 | Draft bundles for the stage-4 probe skeleton releases | Not done | No `packages/catalog` change in the PR; README still says placeholder payloads (`packages/catalog/README.md:5,71`). |
| 9 | Keep the buyer key out of the bridge's environment | Done | `lemma-signer` (`signer/`), `payments.ts:49-50` warns on any `WALLET_SECRET` name in the current or start environment, `adoption.ts:158-159` refuses to run tests while one is set. |
| 10 | Fill `packages/catalog/economics.json` | Not done | Still `"status": "placeholder"`, all amounts `"0"` (`economics.json:1-9`); so nothing is sellable, as the PR body admits. |
| + | `markPending` with the release digest before paying; `ctx.recover()` after a lost response; never pay again | Done | `buy.ts:130` (`markPending(previewId, buyer, now, releaseDigest)` before signing), `:156-157,192-197`. |

## 4. Backlog items 6 and 28–33

| Item | Status | Code fact | Merge impact |
| --- | --- | --- | --- |
| 6 | Accurate | `buy.ts:131` defaults `refundTo` to the paying wallet; `payments.ts:88-90`. | None for this PR; WP-03 remains. |
| 28 | Accurate, incomplete | See F5: preview id is required to post (`service.ts:240`) but readable by the tests; tests run before the bridge's receipt (`adoption.ts:180` vs `:199-208`). WP-02 step 1 alone does not close it. | Documented known gap; not blocking. |
| 29 | Accurate | `socket.ts:59-70` checks the immediate directory only; ownership only for the signer. | Not blocking. |
| 30 | Accurate | `reconciler.ts:87`. | Not blocking; correctness holds via conditional store updates. |
| 31 | Accurate | Upstream defect confirmed at `exact/facilitator/index.mjs:140,153-222` and `440-511`; workaround `facilitator.ts:131`. README lacks the upgrade checklist. | Not blocking; add the checklist with the pin. |
| 32 | Accurate | `payments.ts:61-66`. | Not blocking. |
| 33 | Accurate, fix needs a caveat | `remote.ts:173` throws on any HTTP error; `buy.ts:152-157`; `recovery.ts:5,27-31`; `ledger.ts:9,112`. The signer's reservation cannot be released (no endpoint), see F3. | Not blocking. |

## 5. Protocol-owner lane (x402, facilitator, EIP-712 layouts, signing)

Files in the owner's lane that this PR adds or changes and that need the owner's sign-off per CLAUDE.md: `packages/core/src/purchase.ts` (new digest kind `payment-nonce`, `warrantyClaimHash` layout matching the registry's `abi.encode(bytes32,bytes32,address)`), `packages/core/src/signing.ts` (EIP-712 `AdoptionReceipt(bytes32 resolutionId,string outcome,bytes32 receiptDigest)`, domain `Lemma`/`1`/chainId, no `verifyingContract`), `packages/core/test/vectors/digests.json`, `apps/server/src/payments/{facilitator,handler,registrar}.ts`, `apps/bridge/src/signer/*` (the only code that signs with the buyer key). Points for the owner:

1. `viemFacilitatorSigner` (`facilitator.ts:118-134`) depends on two x402 internals: `getCode` rejections being unawaited (item 31) and the `"permit2Authorization" in payload` routing that the `ExactEip3009Payload` guard mirrors. Both must be re-checked on every x402 bump; 2.27.0 is pinned exactly in `apps/bridge/package.json` and (per the lockfile) the server.
2. `ExactEvmFacilitatorScheme` runs with `eip6492AllowedFactories: []` and `simulateInSettle: false` (defaults, `exact/facilitator/index.mjs:777-786`): counterfactual smart-account buyers are refused at verify (`factory_not_allowed`), which is fine; a nonce spent between verify and settle makes the facilitator pay gas for a reverted transaction (bounded by the rate limit; testnet).
3. Before-settle abort in x402 throws (`facilitator/index.mjs:286-291`), so `inProcessFacilitator.settle` converts it to a `FacilitatorError` and x402 answers "Settlement failed"; unreachable in practice because the same hook already aborts verify, but worth knowing.
4. The settlement hook must remain non-throwing (`@x402/mcp` awaits it inside the try that maps any throw to "Settlement failed"); `handler.ts:164-181` complies.
5. `CONFIRMATION_TIMEOUT_MS = 6_000` (`facilitator.ts:20`) relies on x402's `settlement_pending` path (`chunk-P7ASDIFN.mjs:61-83`) plus the reconciler; a settlement that lands after the timeout is delivered only after `validBefore + 2 min` (`reconciler.ts:17`), i.e. up to ~7 minutes with the default 300 s window.
6. F1 is the owner's call too: the privacy property of the nonce design only holds if the resolution view stops publishing a precise creation time.

## 6. Suspicions not confirmed

- A sequencer reorg after `waitForTransactionReceipt` (one confirmation) that drops the settlement would leave a `settled` row and a delivered bundle with no payment; settled rows are never re-checked. Arbitrum sequencer reorgs are rare; not reproduced.
- The reconciler's "unused at a head past the window" judgement assumes non-decreasing block timestamps across the chain the RPC serves; a reorg that lowers the head timestamp could expire a row whose authorization then settles. Same rarity; the store allows `expired → settled` (`store.ts:123` `ne(state, "settled")`), so a later hook commit would still land.
- `outcomeOfUse` (`chain.ts:164`) depends on FiatTokenV2_2 emitting `Transfer` directly after `AuthorizationUsed`; a USDC upgrade changing event order would make every paid row look `mismatched` and expire it. Documented in the code comment; not testable here.
- `isRpcRefusal` (`chain.ts:213-218`) treats any numeric JSON-RPC `code` as a range refusal, so an unrelated `-32602` halves the range down to one block before failing; slow, not wrong.
- Whether x402 2.27.0's server scheme leaves `accepts` untouched in every configuration (F9) was inferred from the passing end-to-end tests, not from reading `exact/server/index.mjs` line by line.
- The web `Setup.tsx` text about atomic amounts was not reviewed.
