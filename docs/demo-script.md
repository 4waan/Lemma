# Demo Script

## Core line

Lemma stops coding agents from paying to rediscover solved integration work.

## Submission gate

The full demo requires a public deployment with paid tools on, the warranty registry and engine, a measured benchmark, and a real catalog payload. Until those are complete, demonstrate only the implemented preview, drift, apply, verification, recovery, dashboard, and benchmark-harness behavior, and the warranty pipeline on a local chain. Label synthetic records and provisional evidence visibly.

## Before the demo

- The [Arbitrum Sepolia runbook](deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation) is done: the registry, the Stylus engine, a registered and bonded release, the provider's ERC-8004 agent, and the server running the warranty pipeline with `EVALUATOR_FAILURES=review`.
- On the demo machine: `lemma-signer serve` with the buyer's key file and the bridge with its spending policy (see [Buyer setup](deployment.md#buyer-setup)). The buyer holds testnet USDC and no ETH.
- Three fixture repositories: one the release fits whose tests pass with it, one it fits whose tests fail, and one it does not fit.
- The dashboard open on the Catalog page, and an Arbiscan tab.
- A short activation delay keeps the wait short: `WARRANTY_ACTIVATION_BATCH_SECONDS=60` (or `0` with `WARRANTY_ACTIVATION_JITTER_SECONDS=30`). The default sends activations together once an hour, so one activation cannot be paired with the one settlement just before it; with a one-minute batch on a quiet testnet, a batch often holds a single activation, so say so if asked.
- If Arbitrum Sepolia is unreachable, show the same flow on a local chain with `npm run e2e` instead (about a minute; see below).

## Three-minute sequence

1. Show a TypeScript MCP fixture and ask the agent to add x402 on Arbitrum Sepolia.
2. The agent calls `lemma_preview` before writing code. It is free and sends no source code.
3. Show the typed match, supported profile, provenance, evidence, price, limitations, and warranty terms. On the Catalog page, show the release's compatibility confidence (the benchmark prior, then real outcomes, with how many distinct buyers are behind them once there are three) and its public pass rate from ERC-8004. The calculator on the Proof page shows why the price is allowed.
4. Show the local bridge checking drift, spend policy, network, asset, recipient, and authorization window.
5. The agent calls `lemma_buy_resolution`, and the signer signs one USDC authorization. The agent never holds ETH; the facilitator pays the gas. Open the Arbitrum Sepolia settlement transaction.
6. Deliberately lose the paid response, then recover the same resolution without a second payment.
7. Open the resolution's page (`#/resolutions/<id>`): its warranty goes from pending to active, with the activation transaction, in which the provider's signed voucher reserves the price from its bond.
8. Preview and atomically apply the delivered patch.
9. `lemma_verify_adoption` runs the acceptance recipe and sends the signed Adoption Receipt. Within a minute or two (the server checks receipts every minute and finalizes every 30 s), the page shows the receipt verified, then the warranty passed, with links to the finalization (the same transaction records the outcome in the compatibility engine) and to the attester's ERC-8004 feedback. The Catalog's outcome count follows as soon as the server indexes the finalization, and its pass rate within five more minutes (the server caches it).
10. Switch to an incompatible fixture and show a free no-match with zero payment.
11. Switch to the failing fixture: buy, apply, and verify. The failed receipt waits for the evaluator: `npm run evaluator -w @lemma/server -- list`, then `-- decide <resolutionId> failed`. The page shows the warranty failed with its credit.
12. The agent calls `lemma_claim_refund`. The evaluator relays the withdrawal, the page shows the warranty refunded with the withdrawal transaction, and the refund address holds the price.
13. End with the frozen control and treatment benchmark and its raw evidence references on the dashboard's Proof page.

## The local rehearsal instead

`npm run e2e` runs the same flow against real contracts on a local chain: Circle's USDC, the warranty registry, the official ERC-8004 registries, and a Solidity stand-in for the Stylus engine. Its output names each scenario as it passes: setup with the runbook's scripts, a pass, a refund, the wash-adoption damper (one buyer's fourth outcome on a profile counts for nothing), a server killed right after a send that never sends twice, and an expiry. Say plainly that this is a local chain and a stand-in engine.

## Claims supported by the design

- Lemma sells verified applicability and integration execution, not ownership of open-source code.
- Compatibility is resolved before payment.
- Spending policy is enforced by local code outside the model.
- Unsupported and unbenchmarked profiles remain free.
- Eligible failure costs the provider's bond, and the buyer collects it without holding ETH.
- Every warranty, outcome, and refund is a public record on Arbitrum Sepolia. No warranty or outcome record names the buyer; a refund shows only the refund address the buyer chose, which `LEMMA_REFUND_TO` must keep apart from the paying wallet before the bridge will buy.
- One buyer cannot inflate a release's record: after three weighted outcomes on a profile in 30 days, its next ones weigh nothing.
- The paired benchmark measures all-in cost-to-green against the same acceptance standard.

## Evidence required before claiming results

- A public release with verified provenance, payload, fixtures, and benchmark-bound evidence.
- Arbitrum Sepolia payment, recovery, activation, outcome, and refund transactions.
- A frozen benchmark report containing every attempted run and intervention.
- One public-repository pilot or an explicit statement that no external validation has occurred.
- A deployed status page that labels testnet, provisional, unsigned, and unverified data.

## Claims to avoid

- Do not call the MVP a decentralized correctness oracle.
- Do not claim a broad marketplace from one first-party provider.
- Do not imply testnet USDC is production revenue.
- Do not describe receipts as causal proof of savings.
- Do not present provisional evidence as a public benchmark result.
- Do not hide the manual evaluator trust assumption (the evaluator is a team key, and it decides failures) or an intervention.
- Do not present the pass rate as independent review: it counts only Lemma's attester.
- Do not say the Stylus engine ran in the local rehearsal: anvil cannot run Stylus.
