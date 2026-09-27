# Reputation and Confidence

A paid resolution with a warranty ends as public records: an outcome in the warranty registry, a record in the compatibility engine, and ERC-8004 feedback on the provider's agent. This document explains how an outcome gets there, what each number built from outcomes means, what is public and what never is, and what the numbers trust. Everything runs on Arbitrum Sepolia, and every amount is testnet USDC.

## What is built

The server runs the whole flow in background jobs (`apps/server/src/warranty/`), batched and retried. No agent tool call waits for the chain.

1. **Activation.** A random delay after a purchase settles with a warranty claim, the provider signs a voucher for the price and sends `activateResolution`. The registry reserves that amount of the release's bond and opens the claim window.
2. **Receipt.** The buyer's bridge applies the patch, runs the release's pinned acceptance tests, and posts a signed adoption receipt. The server's receipt verifier checks the signature against the buyer.
3. **Finalization.** For a verified receipt, the evaluator signs an outcome and sends `finalizeOutcome`. A receipt that `passed` finalizes PASSED, one `abandoned` VOID, and one `failed` FAILED, after an operator's review by default. PASSED and VOID release the bond to the provider; FAILED turns it into the buyer's credit. The registry records each PASSED or FAILED outcome with a weight above zero into the compatibility engine.
4. **Expiry.** A warranty without a finalized outcome expires after its claim deadline. The provider sends `expireResolution` and gets its bond back.
5. **Indexing.** The indexer reads the registry's events into the server. It is the only source of chain facts: every state, deadline, verdict, and transaction hash the server shows or acts on comes from it, so an action anyone relayed shows up too.
6. **Confidence and reputation.** From the indexed events, the catalog computes each profile's compatibility confidence, and the attester posts each PASSED or FAILED outcome with a weight above zero as ERC-8004 feedback.
7. **Refund.** A FAILED outcome leaves a credit on the registry. The buyer's bridge asks the server to relay the withdrawal, the evaluator sends `withdrawCredit` and pays its gas, and the credit goes to the refund address the buyer committed to when it paid.

The bridge's `lemma_claim_refund` tool claims the credit of each of the buyer's failed warranties through the server's relay, with no chain call of its own ([Bridge Runtime](bridge-runtime.md#warranty-refunds)). `npm run e2e` runs this whole flow on a local anvil chain, against Circle's USDC, the real registry, a Solidity stand-in for the Stylus engine, and the official ERC-8004 registries ([e2e/README.md](../e2e/README.md)), and the Sepolia runbook deploys it in order ([Deployment](deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation)). [Server Runtime](server-runtime.md#warranty-outcome-pipeline) covers the jobs and [Protocol](protocol.md#vouchers-and-outcomes) the signed objects.

## What each number means

- **Compatibility confidence** (`ProfileSummary.compatibility.confidenceBps`). The 90% Wilson lower bound on how often a release's acceptance tests pass on a profile. The prior is the profile evidence's treatment arm, and the outcomes the engine recorded are added on top, each losing half its weight every 30 days. `effectiveNMilli` is the sample size after decay, in thousandths of an outcome. The server computes it with `@lemma/confidence`, the same integer code as the Stylus engine, so the two agree when they have the same prior, outcomes, and time ([when they agree](../packages/confidence/README.md#when-the-catalog-and-the-chain-agree)).
- **Outcomes** (`compatibility.outcomes`). The outcomes the engine recorded for the release and profile: PASSED or FAILED, with a weight above zero, finalized while the most recently set engine was in force, and without an `EngineRecordFailed` in the same transaction. VOID outcomes and outcomes the damper weighed at 0 are never recorded. A new engine starts empty, so after an engine change only its own records count.
- **Buyers** (`compatibility.buyers`). How many distinct buyers paid for those outcomes. Only the server knows each resolution's payer, so it counts the payers of the resolutions it sold and publishes the count from three up. Below three it is null, and the dashboard says "fewer than 3 buyers".
- **Adoption record** (`ReleaseSummary.reputation`). `passBps` and `count` come from ERC-8004 `getSummary(providerAgentId, [attester], "lemma.adoption", capability)`: the share of Lemma's posted feedback for the capability that passed, and how many were posted. The server caches it for five minutes per capability. Its `buyers` counts the distinct buyers behind every outcome fed to the attester for the capability, so for a moment it can run ahead of `count`.
- **Warranty** (`ResolutionView.warranty`). The state (`none`, `pending`, `active`, `passed`, `failed` with the credit outstanding, `refunded`, `void`, or `expired`), the reserved amount, the claim deadline in force (a registry pause moves it later), and each step's transaction, including the attester's feedback to the provider's agent.

## The damper

Wash adoption is a provider, or anyone it pays, buying its own release to inflate its record. Every counted outcome already needs a paid, settled resolution, a pinned acceptance recipe, and the evaluator's signature. On top of that, the evaluator weighs each buyer's outcomes:

- A buyer (the resolution's payer) counts for at most three outcomes with a weight per release digest and profile index in 30 days, finalized or still in flight (`DAMPER_LIMIT`, `DAMPER_WINDOW_MS`).
- The next ones finalize with weight 0, so the engine records nothing and the attester posts nothing for them. An outcome older than 30 days no longer counts toward the limit.
- The damper never changes a warranty: a damped outcome keeps its verdict, and a damped FAILED outcome still pays the buyer's credit.

A provider with many wallets can still pass the damper. The distinct-buyer counts show that a record rests on few buyers; they do not prevent it.

## What is public and what never is

Anyone can read on chain:

- The registry's events: each activation (resolution id, release digest, profile index, amount, payment reference, and claim deadline), each outcome (verdict, weight, and evidence hash), each expiry and credit withdrawal (amount), and each engine change. Activation calldata also shows the voucher's claim hash and `activateBy`.
- A credit withdrawal's refund address and claim secret, in its calldata and USDC transfer, next to the resolution id. The secret is spent by then. A buyer that wants its purchase to stay unlinkable commits to a fresh refund address (the bridge's `LEMMA_REFUND_TO`).
- The senders: the provider activates and expires, and the evaluator finalizes and relays withdrawals.
- The engine's records, and each ERC-8004 feedback with its public feedback file.

Never in the registry's or the engine's records, the ERC-8004 feedback, a read API, or the pipeline's logs:

- The buyer or payer. The registry stores hashes and accounting only. A buyer that opts in with its own ERC-8004 agent id is the exception: the feedback to its agent links its paying wallet to the adoption ([Security Model](security-model.md#reputation-threat-model)).
- The preview id, the payment nonce, and the settlement transaction. The payment itself is a public USDC transfer, but no record names it next to the resolution: its nonce is derived with the secret preview id, the voucher's payment reference is random ([Protocol](protocol.md#vouchers-and-outcomes)), and the resolution view gives only the day it was created (`createdOn`), never the time.
- The claim secret and the refund address before the withdrawal: only the claim hash.
- The receipt itself: the outcome carries only its digest (`evidenceHash`).
- Distinct-buyer counts below three.

The amount and the timing can still join them: an activation publishes the resolution id and the amount, and at low volume the buyer's USDC payment a few minutes earlier is often the only one at that price ([Security Model](security-model.md#warranty-pipeline-threat-model), activation timing).

Two more public facts join resolutions to one another without naming a wallet. A PASSED or FAILED outcome finalized with weight 0 says that its buyer had already reached the damper's limit on that release and profile. And the published buyer counts change as outcomes are indexed, so a new outcome that leaves a count where it was came from one of the earlier buyers. Either can widen a wallet that timing joined to one resolution to that buyer's others.

## Trust assumptions

- **The evaluator is a team key.** The registry trusts its signature for every pass and failure, so whoever holds it decides refunds and records. The server finalizes only on a verified receipt, and holds each failed receipt for an operator's decision unless `EVALUATOR_FAILURES=auto`. A warranty without a verified receipt runs to its expiry.
- **The provider is first-party.** The server holds the provider's key as well, signs a voucher only after settlement, and checks on chain that the release names this provider and evaluator before signing. A voucher is only as good as the bond available when it is submitted.
- **The engine prior.** The on-chain confidence starts from the prior the engine's owner sets with `setPrior`, while the catalog uses the release's evidence. They agree only when the owner sets each frozen evidence's treatment arm, never a provisional prior.
- **The registry.** It has not been audited ([its review](warranty-registry-review.md)). Its owner registers releases with their roles, sets the engine, and can pause, which moves every claim deadline later. Resolution ids and payment references must stay private until activation ([contracts/README.md](../contracts/README.md#limits)).
- **The ERC-8004 registries.** They are Draft and upgradeable by their maintainers, so they are a public mirror of outcomes: bonds, refunds, and pricing never depend on them. Readers should count only the attester address Lemma publishes.
- **The RPC endpoint.** The server reads every chain fact, and checks the registry before every send, through the configured RPC. A wrong answer could show a wrong state or keep a job from acting, but not change what a send does: the registry checks each call against its signature, claim, or deadline. Every fact can be checked on the explorer.
- **Receipts.** A release's own acceptance tests can post a passing receipt before the bridge does, so failures and disputes rely on the evaluator: the known gap in the [Security Model](security-model.md#known-gap-receipts-from-acceptance-tests).
