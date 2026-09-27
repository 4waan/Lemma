# PR #34 `docs/arbitrum.md`: its gaps, and how #51 to #55 cover them

Checked on 2026-09-27 against the code at the #55 head (1d98041), which contains #51 to #54. "Covered" means the code exists and its tests pass locally; nothing is deployed, so every "covered" item is still testnet-on-a-local-chain, not Arbitrum Sepolia.

## 1. The status table in section 2 ("What is built and what is not")

| Row in the doc | Doc says | Now | Where |
| --- | --- | --- | --- |
| Network pinned to Arbitrum Sepolia and its USDC | Built | Still true; the server refuses any other chain id | `apps/server/src/config.ts` (`ARBITRUM_SEPOLIA_CHAIN_ID must be 421614`) |
| Offers quote exact x402 terms | Built | Still true | `packages/core/src/payment.ts` |
| Spending policy `checkPurchase`; "the bridge's purchase tool is in progress" | Built in core only | Covered by #53: `lemma_buy_resolution` checks the policy, and `lemma-signer` enforces the same caps itself | `apps/bridge/src/buy.ts`, `apps/bridge/src/signer/policy.ts` |
| Price bound includes `g`; "`g` is a placeholder until measured" | Built, placeholder | Unchanged: `economics.json` still says `status: placeholder`, so no release carries evidence and nothing is sellable | `packages/catalog/economics.json`; backlog item 3 (WP-20) |
| Idempotent purchases, nonce derived from the resolution; "Designed; lands with the payment work"; points at `receipt.ts` | Designed | Covered by #53: `derivePaymentNonce(resolutionId, previewId)`, a new digest kind with a frozen vector. The doc's file reference is wrong: it lives in `packages/core/src/purchase.ts`, not `receipt.ts` | `packages/core/src/purchase.ts` |
| x402 settlement through a self-hosted facilitator; "In progress (paused)" | In progress | Covered by #53: an in-process facilitator (exact scheme, EIP-3009 only, no public facilitator routes), a reconciler, and a receipt verifier | `apps/server/src/payments/` |
| Warranty registry: bonds, vouchers, outcomes, refunds; "Planned" | Planned | Covered by #51 (the contract, 117 tests, deploy script, ABIs) and #55 (activation, evaluator, expiry, relay, indexer). Not deployed | `contracts/src/ResolutionWarrantyRegistry.sol`, `apps/server/src/warranty/` |
| Dashboard links to Arbiscan | Built | Still true; #55 adds explorer links for activation, outcome, expiry, withdrawal and feedback transactions on the Resolution page, and a Chain section on Status | `apps/web/src/views/Resolution.tsx`, `Status.tsx`, `links.ts` |
| ERC-8004 reputation; "In progress on `reputation/erc-8004`" | In progress | Covered by #54: registration file, evidence files, attester, cached summaries, opt-in buyer agents, tested against the official registries (b9e466c) on anvil. No agent registered on Sepolia | `apps/server/src/reputation/` |
| Stylus confidence engine; "In progress on `contracts/stylus-confidence`" | In progress | Covered by #52: the `no_std` crate, the wasm package, the Stylus contract, the catalog `compatibility` field. Not deployed; `record` gas not measured | `contracts/stylus/`, `packages/confidence/` |

## 2. The ideas in section 3

| Idea | Doc's ask | Now |
| --- | --- | --- |
| A. x402 settlement | An agent pays in USDC, facilitator pays gas | Covered by #53 on a local chain; the Sepolia run (backlog WP-20) is still owed |
| B. Warranty registry | Bond, activation, refund on Arbiscan | Covered by #51 and #55 on a local chain (e2e scenarios: pass, refund, expiry). Not deployed, not verified on Arbiscan (item 26) |
| C. Measure `g` | Real gas figures in `economics.json` and on the dashboard | Not covered. Blocked on network and a funded key (items 3 and 14). The docs' gas figures stay estimates |
| D. Evidence anchoring through EAS | Attest catalog and run-set digests | Not covered. No EAS code anywhere |
| E. On-chain compatibility history | Pass rates the dashboard computes from the chain | Covered in substance by #52 plus #55: the catalog's confidence is folded only from `OutcomeRecorded` events the indexer confirmed, and the ERC-8004 pass rate is read from the registry's `getSummary` |
| F. Robinhood Chain | The same purchase on two Arbitrum chains | Not covered. The server still accepts chain 421614 only |
| G. Pay the maintainers | One transaction paying provider and upstream maintainers | Not covered. No split logic in the server, core or bridge. Section 5 recommends it as the one creative feature; it is not in the backlog either |
| H. Stylus fit check | Lemma's fit check on chain | Replaced, as section 6 says, by the Stylus confidence engine (#52). The fit check itself stays off chain |
| I. Agent identity and reputation | ERC-8004 identities and reputation, buyers opt in | Covered by #54 |
| J. Chain-enforced spending caps | Session-key smart account | Not covered; roadmap in `arbitrum-roadmap.md`. The software caps in #53 (core policy, bridge, signer) are the substitute |
| K. Demand bounties | USDC behind a capability | Not covered |
| L. Releases for Arbitrum builders | The x402 integrations as catalog releases | Unchanged: the skeleton releases still need payloads and benchmarks (issues #24 and #29 ask 8) |
| M. Pay after the tests pass | x402 escrow | Not covered; research item 4 (WP-21) |
| N. Underwriting pools | Third parties stake behind a bond | Not covered; roadmap |

Section 5's "must have by October 4": A and B are built but not deployed; C is not done. The suggested creative feature G is not started. Of the "if time remains" items, I is built, D and F are not.

## 3. Section 6 details the backlog asks to re-check (item 5 of WP-17)

| Statement in the doc | Code | Verdict |
| --- | --- | --- |
| Registration file at `GET /api/v1/agent/registration.json` with the MCP endpoint, `x402Support: true`, `supportedTrust: ["reputation", "crypto-economic"]` | `registration.ts` serves exactly that (plus `/.well-known/agent-registration.json`); `x402Support` is true only while paid tools are on | Matches |
| Feedback: value 100/0, `valueDecimals` 0, `tag1` `lemma.adoption`, `tag2` the capability, a `feedbackURI` and its `feedbackHash` | `packages/core/src/reputation.ts`, `attester.ts` | Matches |
| Evidence file at `GET /api/v1/evidence/:resolutionId` | The route is `GET /api/v1/evidence/:resolutionId/:target` with `target` = `provider` or `buyer-agent`, one file per feedback, served only once the attester has claimed a send | Path differs; update the doc (the backlog's WP-07 text `/api/v1/evidence/:id` is off too) |
| Evidence names resolution, release and profile, capability, recipe digest, acceptance result, verdict, time; never buyer, payer, preview id, settlement, nonce | `AdoptionEvidence` and `AdoptionFeedbackFile` are strict schemas with exactly those fields, no `proofOfPayment` | Matches |
| Summaries cached five minutes; Catalog shows them; a matched preview carries them as metadata; the bridge adds ` Record: pass 97%, n 34.` | `summary.ts` (`SUMMARY_TTL_MS` 5 min, stale value on failure), `REPUTATION_META_KEY` `lemma/reputation`, bridge `text.ts` (` Record: pass <p>%, n <count>.`) | Matches |
| Attester key must differ from the agent owner's | `attester.ts` halts on `SELF_FEEDBACK`; the register script refuses the attester's key | Matches |
| "Publishing distinct-buyer counts next to every pass rate is planned, not built" | #55 publishes `buyers` on both `compatibility` and `reputation`, from 3 up, and damps a buyer's fourth outcome to weight 0 | Now built (backlog item 7); update the doc |
| Crate `lemma-confidence`; a Stylus contract with `record` (registry only), `setPrior` (owner, with the evidence digest), `confidence(release, profile)` view; `cargo stylus export-abi` produces the interface | All present; the exported interface has no events (backlog item 16) | Matches, with that caveat |
| The server loads the crate as committed wasm that rebuilds byte for byte, and adds `compatibility` (confidence, effective sample size, outcome count, source) to each profile | `packages/confidence/wasm/lemma_confidence.wasm` (sha256 46a571ad…5512, rebuilt here byte for byte); `ProfileSummary.compatibility = { confidenceBps, effectiveNMilli, outcomes, source }`, plus `buyers` from #55 | Matches |
| Dashboard shows it on Catalog and Proof with "no outcomes yet" while only the prior exists | `apps/web` (Catalog and Evidence views) | Matches |
| The registry calls the engine inside `finalizeOutcome` and catches any failure | `_recordWithEngine`: 300,000 gas, try/catch, an `EngineRecordFailed` event, plus a gas floor so a relayer cannot starve the engine | Matches |
| Section 6.1: the receipt's signature slot uses an EIP-712 layout "being added by the paid path" | `adoptionReceiptTypedData`, domain `Lemma` version `1` | Now built |
| Section 6.1: the payment nonce is derived from the resolution id and the preview id | `derivePaymentNonce` | Now built |
| Section 6.5 flow and the four records | The pipeline matches step for step: activation by the server with the provider's voucher and a random `paymentRef`, finalization by the evaluator's signed verdict sent from the server's outbox, the registry's engine call, the attester's feedback, cached reads | Matches |
| Section 6.5 privacy rule: "The payment reference in the provider's voucher is a salted commitment chosen by the server" | `activator.ts` uses a random reference per resolution | Matches |
| Section 6.5: refund defaults to the buyer's own address, so a refund joins that wallet to the resolution; a relayed withdrawal | Still the default (`LEMMA_REFUND_TO` optional); `lemma_claim_refund` warns when a refund pays the paying wallet; the server relays | Matches; backlog item 6 (WP-03) changes the default later |
| Section 6.5: "Timing and amounts can still hint at a link while volume is low" | The activator waits a random delay up to 300 s; the public resolution view shows only the day | Matches; backlog item 48 (decision D6) |
| Section 6.3 verdict table: both ideas "being built, not finished" | Both are complete pull requests now | Update the statuses and name the PRs |

## 4. What to change in the doc (either in #34 before it merges, or in WP-17 afterwards)

1. Section 2 table: move the rows for the purchase tool, the nonce, the facilitator, the registry, ERC-8004 and Stylus to "Built (tested, not deployed)", with the real paths, and fix the nonce row's file (`purchase.ts`).
2. Section 6.2, ideas 1 and 3: drop the "planned design, not finished code" labels; the names did not change.
3. Section 6.2, idea 1, risks: "distinct-buyer counts … planned, not built" is now built.
4. Evidence route: `/api/v1/evidence/:resolutionId/:target`.
5. Section 6.3 statuses; section 3's "Facilitator for A" notes can say the in-process facilitator is built and the fallbacks are unused.
6. Keep: `g` is a placeholder; nothing is deployed; G, D, F, K, M, N are not built; C is not measured.

Everything listed as "Not covered" here is either in the backlog (C, M, J's audit mapping) or absent from it (D, F, G, K, N). G is the one the doc itself calls a must-do for the pitch, so it deserves a decision: build it after the merges, or drop it from the doc's recommendation.
