# Review summary: PRs #51 to #56 against the follow-up backlog (2026-09-27)

## Verdicts

| PR | Verdict | Before merge | Owner lane |
| --- | --- | --- | --- |
| #56 backlog | Mergeable; merge first (the only record of items 14 to 60) | Nine small corrections (PR numbers, #36 inside #52 and #53, evidence route, items 52 and 55 wording, WP-01 timings, a D2 server guard) | no |
| #51 registry | Mergeable after owner review | One wrong figure in the review note (runtime size 11,108 bytes, not 12,472) | contracts, EIP-712 |
| #52 confidence | Mergeable after owner review, after #36 | Nothing; note the missing events in the exported ABI (item 16) | Stylus contract |
| #53 paid path | Mergeable once the `validBefore` check is fixed, and only together with #55 (millisecond `createdAt` in the public view) | Two small fixes | x402, facilitator, signing |
| #54 reputation | Mergeable with follow-ups | Add the identity/reputation registry pairing check soon (item 42) | attester key |
| #55 pipeline | Mergeable once three small server fixes land | `PROVIDER_ADDRESS` vs key check; stale registry reads must back off; deadline in the operator list | EIP-712, signing, relayers |

Suggested merge order: #56, #51, #36 (your manual review), #52, #53 with its fix, #54, #55 with its fixes. #52 and #53 carry #36's four commits, so merging either lands the redesign. If you prefer one squash of the stack, merge #55 alone after its fixes and close #52 to #54 as superseded, after #51 and #56.

## New findings (not in the backlog), all verified in the code

| # | PR | Where | What | Severity |
| --- | --- | --- | --- | --- |
| N1 | #53 | `apps/server/src/payments/handler.ts:51,98,136` | A 13 to 15 digit `validBefore` becomes an Invalid Date and the "no longer than quoted" check compares NaN, so it never refuses; Postgres fails closed by accident, MemoryStore stores an unlistable row | should fix (one line) |
| N2 | #53 | `packages/core/src/read.ts:136`, `apps/server/src/service.ts:262` | The public resolution view exposes millisecond `createdAt` next to payee and amount; the settlement is findable on chain from it. #55 already replaces it with `createdOn` | should fix or merge with #55 |
| N3 | #55 | `apps/server/src/config.ts:294-310` | No check that `PROVIDER_PRIVATE_KEY` is `PROVIDER_ADDRESS`'s key; a mismatch skips every activation while sales continue | should fix (one line) |
| N4 | #55 | `evaluator.ts:172`, `expirer.ts:89`, `relay.ts:55` | A stale registry read (lagging RPC backend) ends finalize, expire and withdraw actions for good instead of backing off: lost credit, stuck bond, permanent "abandoned" | should fix (small) |
| N5 | #55 | `review.ts:77`, `evaluator.ts:180` | The operator's `list` shows no claim deadline; a review that outlives the window is abandoned silently and the buyer's refund becomes the provider's bond | should fix (small) |
| N6 | #55 | `activator.ts:158` | Any non-`none` on-chain status counts as "activated by us", without comparing release digest, profile and amount: the server-side half of decision D2 | should fix soon |
| N7 | #51 | `docs/warranty-registry-review.md:44` | Stale, mislabeled size figure | nit |
| N8 | #55 | `config.ts:157`, `outcomes.ts:159,174,304-316`, `docs/deployment.md` | `WARRANTY_SWITCHES` omits three variables; the snapshot rebuild is quadratic and synchronous (6.6 s at 20,000 finalizations); outcomes passed over stay behind the feed cursor; the pipeline assumes one replica | follow-ups |
| N9 | #34 | `docs/arbitrum.md` | Status rows, section 6.2 labels, the evidence route and "distinct buyers planned" are stale; ideas G, D, F, K, N are not built and not in the backlog | docs (see `arbitrum-gaps.md`) |

## The six P0 backlog items

- **6 (refund to the paying wallet).** Confirmed: `buy.ts:131` defaults `refundTo` to the buyer; the withdrawal puts it on chain next to the resolution id; the bridge warns on stderr and in the refund answer. Acceptable on testnet as a documented, warned default. Before real funds: WP-03 option A (never default to the paying wallet).
- **28 (receipts from acceptance tests).** Confirmed and documented in `docs/security-model.md`. Correction: WP-02 step 1 alone does not close it, because the acceptance test can read the preview id from the inbox and get the first receipt signed; step 2 (mount namespaces) is the fix. Acceptable on testnet because the evaluator is the defense and failures wait for an operator; WP-02 before real funds.
- **45 (fork detection).** Confirmed: `chain_cursors` holds no block hash and a lagging `eth_getLogs` backend moves the cursor past a short read. Documented. Acceptable on testnet; WP-04 step 1 before real funds. N4 above is the same weakness on the read side and is cheaper to fix now.
- **46 (nonce race).** Confirmed with a probe: refused resend, heals next attempt, no double effect. Follow-up (WP-04 step 2).
- **48 (activation timing).** Confirmed: random delay up to 300 s; the security model states the anonymity set plainly. Decision D6; acceptable on testnet.
- **49 (buyer counts after every indexer run).** Confirmed. Follow-up (WP-05 step 1).

## Handoff table: all 60 items

Columns: item, package, PR, what I found, merge impact.

| Item | WP | PR | Found | Impact |
| --- | --- | --- | --- | --- |
| 1 | 21 | #34, #37 | docs facts, not checked (needs web) | follow-up |
| 2 | 20 | none | not checkable here | blocked |
| 3 | 20 | none | `economics.json` still `placeholder` | blocked |
| 4 | 21 | none | not checkable here | needs web |
| 5 | 17 | #34, #37 | stale statements listed in `arbitrum-gaps.md` | follow-up after merges |
| 6 | 03 | #53, #55 | confirmed | accepted on testnet; fix before real funds |
| 7 | done | #55 | confirmed done (buyers from 3, damper, e2e scenario 4) | close #44 on merge |
| 8 | 19 | #37 | not checkable | needs inputs |
| 9 | 20 | none | not checkable | blocked |
| 10 | 18 | none | not checked | follow-up |
| 11 | 12 | none | not checked | follow-up |
| 12 | 22 | none | decision D7 | decision |
| 13 | 01 | main | corrected: 0.6 to 0.8 s alone, 0.9 to 1.1 s under a parallel full run, 1.3 s in CI | follow-up, cheap |
| 14 | 20 | #52 | confirmed unmeasured | blocked |
| 15 | 20 | #52 | confirmed | blocked |
| 16 | 14 | #52 | confirmed, five events missing from the export | follow-up |
| 17 | 20 | #52 | confirmed | blocked on RPC |
| 18 | 22 | #52 | confirmed display only | decision D1 |
| 19 | 17 | none | docs | follow-up |
| 20 | 22 | #51, #55 | confirmed and extended: the server also accepts a foreign activation as its own (N6) | decision D2 before mainnet; N6 now |
| 21 | 22 | #51 | confirmed | decision D3 |
| 22 | 22 | #51 | confirmed | decision D4 |
| 23 | 22 | #51 | confirmed | decision D5 |
| 24 | 12 | #51 | confirmed; local slither reproduces the three accepted findings | follow-up |
| 25 | 12 | #51 | confirmed | follow-up |
| 26 | 20 | #51 | confirmed | blocked |
| 27 | 01 | main | not reproduced (passed in both parallel runs) | follow-up |
| 28 | 02 | #53, #55 | confirmed; step 1 alone insufficient (see above) | accepted on testnet; before real funds |
| 29 | 02 | #53 | confirmed, plus a check-once TOCTOU on the socket directory | follow-up |
| 30 | 06 | #53 | confirmed | follow-up |
| 31 | 06 | #53 | confirmed upstream (`exact/facilitator/index.mjs:140-222`) | follow-up |
| 32 | 06 | #53 | confirmed | follow-up |
| 33 | 06 | #53 | confirmed; the signer holds a reservation too and has no release endpoint | follow-up |
| 34 | 16 | #55 | confirmed | follow-up |
| 35 | 17 | docs | not checked | follow-up |
| 36 | 15 | #54 | confirmed | follow-up |
| 37 | 10 | #55 | not checked in detail | follow-up |
| 38 | 12 | #54 | confirmed; the e2e already runs the registries from fixtures | follow-up |
| 39 | 07 | #54 | confirmed (`app.ts:148`); route is `/api/v1/evidence/:resolutionId/:target` | follow-up |
| 40 | 07 | #54 | confirmed | follow-up |
| 41 | 08 | #54 | confirmed | follow-up |
| 42 | 07 | #54 | confirmed (function in the ABI, never called) | should fix soon |
| 43 | 08 | #54 | confirmed by design | follow-up |
| 44 | 07 | #54 | confirmed; no active leak today | follow-up |
| 45 | 04 | #55 | confirmed, documented | accepted on testnet; before real funds |
| 46 | 04 | #55 | confirmed with a probe | follow-up |
| 47 | 09 | #55 | confirmed (`admin.ts:299`) | follow-up |
| 48 | 22 | #55 | confirmed, documented | decision D6 |
| 49 | 05 | #55 | confirmed | follow-up |
| 50 | 11 | #55 | confirmed, understated: quadratic synchronous rebuild | follow-up, two-line fix now |
| 51 | 10 | #55 | confirmed | follow-up |
| 52 | 11 | #54 | confirmed; skip codes do not repeat, validation warnings do | follow-up |
| 53 | 11 | #55 | confirmed | follow-up |
| 54 | 03 | #55 | confirmed; stops after the first transient answer | follow-up |
| 55 | 13 | #55 | corrected: `startReputation` takes an interval; `forge fmt` not run on `e2e/contracts` | follow-up |
| 56 | 09 | #54 | confirmed for `register.ts:61`; the other scripts already refuse bare keys | nit |
| 57 | 17 | docs | not checked | follow-up |
| 58 | 16 | #55 | confirmed | follow-up |
| 59 | 20 | none | not checkable | blocked |
| 60 | 17 | docs | all 160 relative links resolve at the #55 head | follow-up |

## Files

- `evidence.md`: every command run, its result and the PR-body claim it checks.
- `pr-51.md` to `pr-56.md`: the review texts as posted.
- `arbitrum-gaps.md`: docs/arbitrum.md (PR #34) against the code.
- `agent-pr-53.md`, `agent-pr-55-server.md`: the subagents' full reports (their findings were re-verified before use; probes under `scratchpad/probe/`).
- `vectorcheck.py`: the independent replay of the confidence vectors.
