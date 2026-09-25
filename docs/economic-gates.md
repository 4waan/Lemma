# Economic Gates and Iterations

This document ties every build stage to the economic claim it must support, and says when to stop and iterate instead of building further. [economics.md](economics.md) defines what is sold. [benchmark-protocol.md](benchmark-protocol.md) defines how savings are measured. This file connects the two to the build order in the [README](../README.md).

All amounts are atomic USDC (6 decimals). Model costs are recorded in micro-USD at the same scale. The MVP treats 1 USDC as 1 USD and says so wherever the two meet. Every number in the worked examples is an illustrative assumption, not a measurement.

## 1. The money path

```text
benchmark RunRecords ──► deriveEvidence ──► ProfileEvidence ──► saleBlocker ──► Offer (x402 PaymentTerms)
        ▲                (paired, conservative)   (per supported profile)   (30% rule, freshness)       │
        │                                                                                              ▼
  adoption receipts ◄── acceptance run ◄── patch applied ◄── Resolution ◄── checkPurchase ◄── x402 challenge
        │
        └──► observed pass rate ──► warranty exposure ──► provider margin ──► which releases to keep
```

Each arrow is a typed, deterministic function over `@lemma/core` schemas. No step takes model prose as input. The names refer to the implementation in `packages/core` (`saleBlocker`, `checkPurchase`, `allInReductionBps`, `RunRecord`) and `packages/benchmark` (`deriveEvidence`, `evaluateBenchmark`).

## 2. Unit economics of one resolution

| Symbol | Meaning | Source |
| --- | --- | --- |
| `C` | control raw model cost to reach green | `ProfileEvidence.controlMedianCostUsdc` |
| `S` | conservative raw model-cost saving | `ProfileEvidence.expectedRawSavingUsdc` (lower quartile of paired savings) |
| `P` | resolution price | `Offer.terms.amount` |
| `g` | chain cost per resolution (settlement, warranty activation, outcome, expiry) | chain receipts, `RunRecord.payment.gasCostMicroUsd` |
| `q` | eligible failure rate within the claim window | adoption receipts and evaluator outcomes |
| `K` | cost of producing evidence for one release profile (benchmark runs, curation) | benchmark run records |
| `N` | resolutions sold for that profile before its evidence goes stale | server records |

The sale rule is `P <= 0.3 S` (`isSellable`). From it:

- **Buyer net saving** is `S - P - g_buyer`, at least `0.7 S - g_buyer`, before counting time and interventions.
- **Buyer all-in reduction** is `(S - P - g) / C` (`allInReductionBps`). **The sale rule does not imply the benchmark target.** At the 30% price cap, the all-in reduction is `0.7 S / C`, which meets the 25% target only when `S >= 0.357 C`. A release that saves 25–35% of the control cost can pass the sale rule yet leave the buyer short of the promised reduction. Both numbers must be shown, and the frozen benchmark (`evaluateBenchmark`) is what licenses the claim.
- **Price bound.** `maxPriceFor(S, C, g)` (core) is the highest price that is sellable and still leaves the buyer the 25% target after chain cost: `min(floor(0.3 S), S - g - ceil(0.25 C))`. `0` means preview-only. `catalog:check` refuses any evidenced price above it, or below the price floor, using the dated inputs in `packages/catalog/economics.json`. Until the protocol lane sets `g` and the floor there, no release may carry evidence.
- **Provider margin per resolution** is `P (1 - q) - g_provider - K / N`. The warranty refunds `P` on an eligible failure.
- **Break-even volume** is `N* = K / (P (1 - q) - g_provider)`.

### Worked example (assumptions, not data)

With `C = 2.50`, `S = 1.30`, `P = 0.39` (the cap), `q = 0.10`, `g = 0.01` and `K = 30.00`:

- buyer all-in reduction ≈ `(1.30 - 0.39 - 0.01) / 2.50` = 36%
- provider margin before evidence cost ≈ `0.39 * 0.9 - 0.01` ≈ 0.34
- break-even `N*` ≈ `30 / 0.34` ≈ 88 resolutions per profile version

Where the economics break:

1. **Evidence cost dominates.** A profile is worth curating only if about `N*` buyers adopt it before its evidence goes stale. That favors broad profile classes and recurring demand.
2. **Small prices can't carry fees and gas.** A paid resolution touches up to four on-chain actions. At sub-dollar prices, chain cost can be a double-digit share of `P`, and a planned 10% Lemma fee (`0.1 P`) can be smaller than facilitator gas. Decide who pays each transaction and set a price floor before opening to external providers.
3. **Savings decay as models get cheaper.** `S` is measured with one model and price sheet. Evidence therefore records the model, the token saving and `staleAfter`, and a stale profile drops to preview-only (`EVIDENCE_STALE`).
4. **Small samples are noisy.** With three pairs, pricing off the minimum paired saving (the lower quartile) keeps a single lucky run from setting the price.

## 3. Critical-stage iterations

Each stage names its gate: the evidence that must exist before the next stage starts. The "iterate if" column says what to change instead of pushing forward. The owner column follows the lane split: **P** is the protocol and payments teammate, and **N** is the non-chain lane.

| # | Stage | Gate (evidence) | Iterate if | Owner |
| --- | --- | --- | --- | --- |
| 1 | Shared schemas (`@lemma/core` v1) | Vectors reproduce in every consuming encoder. The protocol owner maps `Resolution`, `AdoptionReceipt`, `PaymentTerms` and `deriveResolutionId` into typed data without adding fields. | A settlement or warranty field is missing. Change the schema now, before anything persists v1. | N, reviewed by P |
| 2 | Catalog and fixtures | Every release has exact, boundary, near-miss and unsupported fixtures with frozen expected decisions. `payloadDigest` equals `bundleDigest` of the bundle files. `npm run catalog:check` passes. | A near-miss matches, or a digest depends on the machine. | N |
| 3 | Resolver and free preview | Output is deterministic and records `catalogDigest`. Negative fixtures produce zero matches. No-match previews carry no offer. | Any nondeterminism, or an offer on an unsupported or unbenchmarked profile. | N |
| 4 | **Economic probe** (before the paid path is finished) | Two or three exploratory control runs and one hand-applied treatment run per candidate release give a rough `S` and `C`. It passes when `maxPriceFor(S, C, g)` is at least the price floor: some price then meets the sale rule, the 25% all-in target after chain cost, and the floor at once. This replaces the older `S >= 0.357 C` check, which assumed the 30% cap and ignored gas. | Either threshold fails. Pick larger or more failure-prone integration tasks before spending on payments. | N |
| 5 | Paid path end to end | One purchase through `checkPurchase`. Recovery without a duplicate payment, with `deriveResolutionId` as the idempotency key. Voucher activation, one pass and one refunded failure, all on testnet. | Any duplicate charge or unrecoverable response. | P |
| 6 | Frozen benchmark (20 runs) | `evaluateBenchmark` passes on the frozen matrix. `deriveEvidence` produces each profile's `ProfileEvidence` and `runSetDigest`. | A target is missed. Report the measured values, keep the profile preview-only, and revisit stage 4. | N |
| 7 | Pilot on a public repository | One external attempt completes and produces an Adoption Receipt without manual intervention, or the intervention is recorded. | The buyer needed help the product should provide. | N and P |
| 8 | Scale readiness | See section 4. | Any item that would force a code release per new provider or capability. | N and P |

Stage 4 is the cheapest place to learn that a release family can't pay for itself. Run it before finishing stages 5 and 6.

Stages 5 and 6 need something to buy before frozen evidence exists. The testnet-only overlay `packages/catalog/releases.provisional/` provides it.
- It holds `X+provisional-N` versions that differ from `X` only in version, evidence, price and dates.
- They carry the stage-4 probe numbers at the pre-registered price.
- The public service never loads the overlay, and `catalog:check` refuses `provisional-` evidence in `releases/`.
- Frozen evidence then ships as `X+<benchmarkVersion>` in `releases/`, bound to the same `baseReleaseDigest` as the runs that measured it.

## 4. What makes the product scale

Items marked **done** are implemented in schema v1. The rest are ordered by how early they need a decision.

1. **Evidence per profile, bound to its runs (done).** Evidence sits on each `SupportedProfile` and cites `runSetDigest` and `fixtureProfileDigest`. Unbenchmarked profiles stay preview-only.
2. **Freshness and model awareness (done).** `staleAfter`, `model` and `expectedTokenSaving` are recorded. Next, let the bridge send a privacy-safe model-price class, so the resolver can price the saving for the buyer's own model.
3. **Idempotent purchases (done in core).** `resolutionId = deriveResolutionId(previewId, buyer)`. Used as the EIP-3009 nonce, it lets USDC refuse a duplicate payment on-chain.
4. **One definition of what is paid (done in core).** `PaymentTerms` mirrors x402 v2, and `checkPurchase` refuses any challenge that differs from the quote.
5. **Evidence attestation.** Before external providers join, record who measured the saving (Lemma, not the provider), because a provider could otherwise inflate `S` to pass the sale rule.
6. **Profile classes and a dependency interest set.** Publish, per capability, the dependency names the catalog actually matches on. The bridge sends only those, internal package names never leave the machine, and one benchmark can cover a documented profile class.
7. **Compatibility history.** Group adoption receipts by (release digest, matched profile index) to estimate `q` per profile. Use it to stop offering failing profiles, set the bond or price per profile, and later build provider reputation. Receipts are observational, so they never replace the paired benchmark for savings claims.
8. **Deterministic ranking at catalog scale.** When several releases match, rank by a published total order: decision class, evidence present, pass rate, price, semver descending, release id.
9. **Data-driven taxonomy.** Capability ids, frameworks and per-capability options should move into validated catalog data, so a new capability doesn't need a core release. Consider CAIP-19 asset ids and per-asset spend limits for multiple chains.
10. **Cheaper evidence.** Sequential designs that stop once the interval clears the threshold, shared control arms across releases for the same task, and occasional shadow-control runs for high-volume releases reduce `K` without weakening the claim.

## 5. Records each stage must produce

| Record | Produced by | Consumed by |
| --- | --- | --- |
| `RunRecord` (tokens by type, raw cost, wall time, tool calls, interventions, acceptance, price, gas) | benchmark harness | `deriveEvidence`, `evaluateBenchmark`, dashboard |
| `ProfileEvidence` (conservative saving, token saving, model, run-set digest, freshness) | `deriveEvidence` | release manifests, `saleBlocker`, dashboard |
| `Preview`, `Resolution`, `AdoptionReceipt` | resolver, server, bridge | pass-rate estimate, dashboard, warranty |
| Chain receipts (payment, activation, outcome, refund) | payment and contract path | cost accounting, dashboard |

Every public number names its record, its measurement date, and whether it is observed, modeled or testnet-nominal.
