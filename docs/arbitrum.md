# Arbitrum in Lemma

This document explains why Lemma runs on Arbitrum, what is already built, and the ways the product can use Arbitrum more deeply during the Arbitrum Open House Singapore buildathon (submissions close October 4, 2026). It also records what past Arbitrum winners built, so the team can see which kinds of integration judges reward.

Everything here is on testnet. Amounts are test USDC. Status labels are as of September 26, 2026.

## 1. Why Lemma needs Arbitrum

**In one sentence:** Lemma sells coding agents a verified patch for a few cents, and that is only possible on a chain where the payment, the warranty and the receipts together cost less than a cent or two.

The reasons, each tied to how Lemma works:

1. **Small payments must stay profitable.** Lemma prices a patch at no more than 30% of the model cost it saves, and the buyer must still end up at least 25% cheaper after gas. The chain cost `g` is part of that price formula (`maxPriceFor` in `packages/core/src/pricing.ts`). A paid resolution touches up to four on-chain actions: settlement, warranty activation, the outcome, and expiry (`docs/economic-gates.md`). With the documented worked example (control cost 2.50 USDC, measured saving 1.30 USDC):

   | Chain cost per resolution | Highest price Lemma may charge |
   | --- | --- |
   | 0.01 USDC | 0.39 USDC |
   | 0.30 USDC | 0.375 USDC |
   | 0.60 USDC | 0.075 USDC |
   | 0.675 USDC or more | nothing can be sold |

   These figures were computed with core's own `maxPriceFor`. On a chain where four contract calls cost dollars, the product cannot exist. On Arbitrum they cost a small fraction of the price.

2. **Agents pay with signed USDC transfers, not gas.** x402's `exact` scheme uses native USDC's EIP-3009 `transferWithAuthorization`: the agent signs, and the facilitator submits the transaction and pays the gas. The agent needs no ETH. The installed x402 package already lists Arbitrum Sepolia USDC (`0x75fa…aa4d`, "USD Coin", version 2) as a default asset.

3. **The warranty needs a contract that holds money.** A provider bond backs every sale. The bond, its reservation per purchase, the evaluator's verdict and the buyer's refund are contract state (`contracts/README.md`). Arbitrum runs the same EVM and tooling as Ethereum (Solidity, Foundry, viem), so the contract, its tests and its signatures work unchanged.

4. **Evidence must be public.** Lemma's claims are only as good as the records behind them. Settlements, warranty activations and outcomes on Arbitrum are public transactions anyone can check on Arbiscan, which the dashboard links to. A database row cannot give that assurance.

## 2. What is built and what is not

| Integration | Where | Status |
| --- | --- | --- |
| Network pinned to Arbitrum Sepolia (`eip155:421614`) and its native USDC | `packages/core/src/primitives.ts`, `apps/server/src/config.ts` | Built |
| Offers quote exact x402 payment terms in Arbitrum USDC | resolver, `PaymentTerms` in core | Built |
| Spending policy checks network, token, recipient, amount and daily cap before anything is signed | `checkPurchase` in `packages/core/src/policy.ts` | Built in core; the bridge's purchase tool is in progress |
| Price bound includes the chain cost `g` | `packages/core/src/pricing.ts`, `packages/catalog/economics.json` | Built; `g` is a placeholder until measured |
| Idempotent purchases: a nonce derived from the resolution, so USDC refuses a second payment | design in `packages/core/src/receipt.ts` | Designed; lands with the payment work |
| x402 settlement through a self-hosted facilitator | `apps/server` | In progress (paused) |
| Warranty registry: bonds, vouchers, outcomes, refunds | `contracts/` | Planned |
| Dashboard links to Arbiscan | `apps/web` | Built |

## 3. Ways to use Arbitrum

Effort assumes one developer: S is under a day, M is two to three days, L is about a week.

### Core: the product needs these

| Idea | What it adds to Lemma | What a judge sees | Effort |
| --- | --- | --- | --- |
| **A. x402 settlement on Arbitrum** | Agents actually pay for a patch in USDC, with the facilitator paying gas. | A real Arbiscan transaction for a purchase, made by an agent. | M |
| **B. Warranty registry** | The provider bond turns a promise into money at stake. A failed patch refunds the buyer. | A bond deposit, a warranty activation and a refund, all on Arbiscan. | M to L |
| **C. Measure `g`** | Replaces the placeholder chain cost with real gas figures, so prices become real. | A table of real gas costs per resolution, in `economics.json` and on the dashboard. | S, after A and B |

### Strengthen: small builds with a clear payoff

| Idea | What it adds to Lemma | What a judge sees | Effort |
| --- | --- | --- | --- |
| **D. Evidence anchoring** | Publish the catalog digest and each benchmark's run-set digest on chain, so prices point at timestamped evidence nobody can rewrite. | "This price is backed by run set 0x… anchored in block N." | S |
| **E. On-chain compatibility history** | Warranty outcomes become public events. The dashboard computes each release's pass rate from the chain, not from Lemma's database. | Live pass rates anyone can recompute. | M |
| **F. Robinhood Chain deployment** | The same contracts and payments on Robinhood Chain, an Arbitrum Orbit chain. This also makes Lemma eligible for the top-3 spot reserved for Robinhood Chain projects. | The same purchase settling on two Arbitrum chains. | M; check the chain's stablecoin and facilitator support first |

### Creative: ideas that set Lemma apart

| Idea | What it adds to Lemma | What a judge sees | Effort |
| --- | --- | --- | --- |
| **G. Pay the maintainers** | Each purchase splits on chain: most goes to the provider, and a share goes to the open-source project the patch is based on (its provenance is already recorded). Agents reusing open source then pay the people who wrote it. | One Arbiscan transaction paying both the provider and the upstream maintainers. | S to M |
| **H. Stylus compatibility check** | Compile Lemma's deterministic fit check (platform and semver range rules) to a Stylus contract in Rust. Anyone can then verify on chain that a sold patch really matched the buyer's profile, and the warranty can use it to decide eligibility. Stylus makes this kind of parsing and comparison practical on chain. | Lemma's core logic running on Arbitrum's own contract engine. | L |
| **I. Agent identity and reputation** | Register the provider and buyer agents in an ERC-8004 agent registry, and publish adoption outcomes as reputation. Agents can then discover releases with a trustworthy track record. | Agents with on-chain identities and reputations. | M; confirm the registry is deployed on Arbitrum |
| **J. Spending caps enforced by the chain** | The buyer agent pays from a smart account whose session key only pays Lemma's provider, up to a daily cap. The limit then holds even if the bridge is compromised. | An agent that cannot overspend, even in theory. | M |
| **K. Demand bounties** | Anyone can put USDC behind a capability that agents keep asking for (the Demand page already ranks them). The first provider to ship a benchmarked release claims it. | A market that funds the integrations agents actually need. | M |

## 4. What past Arbitrum winners did

| Project | Event | How it used Arbitrum | Lesson for Lemma |
| --- | --- | --- | --- |
| Orbital AMM Protocol | Open House India, 1st place ($40,000) [1] | A multi-asset stablecoin AMM whose high-precision math layer runs in Stylus (Rust). | Use Arbitrum-specific technology where it does real work (idea H). |
| Shinobi.Cash | Open House India, 2nd place [1] | A cross-chain privacy pool served from one Arbitrum deployment, with account-abstraction paymasters on Arbitrum to cut withdrawal costs. | Make Arbitrum carry the product's cost story (ideas A and J). |
| GuardChain.ai | Open House India, 3rd place [1] | Community insurance with AI-assisted claims, on-chain transparency, and a scoped Orbit chain for claims. | Insurance on Arbitrum wins. Lemma's warranty has the same shape (idea B). |
| Tilt Protocol, Fangorn, EquelFi | Open House NYC buildathon winners [2] | No integration details were found. | Judges scored technical execution, product clarity, ecosystem alignment and long-term potential [2]. |
| A2A x402 Gateway | HackQuest project [3] | AI agents pay each other through x402 in USDC on Arbitrum Sepolia, with EIP-712 signatures, 52 tests and a live settlement dashboard. It chose Arbitrum because sub-cent gas keeps micropayments viable. | The closest precedent to Lemma's payment path. Lemma adds verification, warranty and evidence on top. |
| Kajota Mesh | Open House Singapore 2026 entry [4] | Escrow and commission splits for commerce agents on Arbitrum Sepolia and Robinhood Chain testnet, EIP-3009 transfers, ERC-8004 identities, and eight contracts verified on Arbiscan. | Show proof over promises: verified contracts, transaction hashes in the README, and a judging-criteria map. |
| WhaleTape x402 Gateway | Open House entry [5] | One x402 endpoint that settles on several chains, including Arbitrum One and Robinhood Chain. | Robinhood Chain support is achievable for an x402 product (idea F). |
| Agentic Ethereum (ETHGlobal) | Arbitrum prize track [6] | Arbitrum offered prizes for Stylus used to power AI agents, and for developer toolkits for agents. | Arbitrum actively rewards agent infrastructure, which is Lemma's category. |

What these winners have in common:

- **Verifiable proof.** Deployed and verified contracts, transaction hashes in the README, and a working demo. Judges open the repository and the demo first [7].
- **Arbitrum technology used on purpose.** Stylus, Orbit chains and paymasters, rather than "we deployed on an L2" [7].
- **A real product.** A working MVP, tests, documentation, a roadmap beyond the buildathon, and active commits [7].
- **This round's bonus.** One top-3 spot is reserved for a project on Robinhood Chain [8], and a separate category rewards AI agents and new financial primitives [9].

## 5. Recommendation for the buildathon

1. **Must have by October 4:** A (x402 settlement, resuming the paused payment work), a thin B (bond, activation, outcome, refund and expiry), and C (measure `g` once A and B run, then publish it).
2. **One creative feature:** G, "pay the maintainers". It is small, it reuses the settlement from A, and it tells the story judges remember: agents that reuse open source pay the people who wrote it.
3. **If time remains:** F (Robinhood Chain) for the reserved spot, and D (evidence anchoring) as a quick addition.
4. **For the roadmap slide:** H (Stylus fit check), I (agent identity), J (chain-enforced caps) and K (demand bounties).

Demo moments to plan for:

- An agent's purchase, opened on Arbiscan.
- A bond deposit and a refund for a deliberately failing patch.
- One transaction that pays both the provider and the upstream maintainers.
- The same purchase settling on Robinhood Chain.

Lines for the pitch:

- "Lemma's price formula contains Arbitrum's gas. If a purchase cost 0.675 USDC in chain fees, nothing could be sold."
- "Agents never hold ETH. They sign a USDC transfer, and our facilitator settles it on Arbitrum."
- "Every warranty is money at stake in a contract, and every outcome is public."

## Sources

1. Arbitrum Open House India winners: [ChainThink](https://chainthink.cn/en/news/49556622885900316) and [PR Newswire](https://www.prnewswire.com/in/news-releases/arbitrum-foundation-announces-winners-of-bengaluru-irl-hacker-house-302565059.html).
2. [Open House NYC Buildathon: meet the winning teams](https://blog.arbitrum.foundation/open-house-nyc-buildathon-concludes-meet-the-winning-teams/).
3. [A2A x402 Gateway on HackQuest](https://www.hackquest.io/projects/A2A-x402-Gateway).
4. [Kajota Mesh repository](https://github.com/KaJota-inc/kajota-arbitrum-singapore).
5. [WhaleTape x402 gateway repository](https://github.com/Elipacosta88/whaletape-x402-gateway).
6. [Arbitrum prizes at Agentic Ethereum](https://ethglobal.com/events/agents/prizes/arbitrum).
7. [What winning Arbitrum Open House teams do differently](https://dev.to/arbitrum/what-winning-arbitrum-open-house-teams-do-differently-18f8).
8. [Arbitrum launches a $115K buildathon with a podium spot for Robinhood Chain builders](https://egamers.io/arbitrum-launches-115k-buildathon-reserving-a-podium-spot-for-robinhood-chain-builders/).
9. [Builder's Block #023: $415K in prizes at Open House Singapore](https://blog.arbitrum.foundation/builders-block-023-415k-in-prizes-at-open-house-singapore-apply-now/).

Some of these pages could not be opened directly from the build environment. Their content here comes from search-result summaries and should be re-checked before it is quoted in the submission.
