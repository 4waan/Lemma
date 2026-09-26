# Arbitrum in Lemma

This document explains why Lemma runs on Arbitrum, what is already built, and the ways the product can use Arbitrum more deeply during the Arbitrum Open House Singapore buildathon (submissions close October 4, 2026). It also records what past Arbitrum winners and this round's other entries built, so the team can see which kinds of integration judges reward.

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

   These figures were computed with core's own `maxPriceFor`. On a chain where four contract calls cost dollars, the product cannot exist. On Arbitrum, one USDC payment is estimated at well under a cent. About 80,000 gas at roughly 0.02 gwei is 0.0000016 ETH, which stays under one cent while ETH is below $6,000, plus a small fee for posting the data to Ethereum. The gas price is Arbiscan's figure for late September 2026, read through search results [10]. This is an estimate, not a Lemma measurement; idea C replaces it.

2. **Agents pay with signed USDC transfers, not gas.** x402's `exact` scheme uses native USDC's EIP-3009 `transferWithAuthorization`: the agent signs, and the facilitator submits the transaction and pays the gas. The agent needs no ETH. The installed x402 package already lists Arbitrum Sepolia USDC (`0x75fa…aa4d`, "USD Coin", version 2) as a default asset. Arbitrum has announced official x402 support [11], and PayAI's hosted facilitator already settles x402 payments on Arbitrum Sepolia for another entry in this buildathon [12][13].

3. **The warranty needs a contract that holds money.** A provider bond backs every sale. The bond, its reservation per purchase, the evaluator's verdict and the buyer's refund are contract state (`contracts/README.md`). Arbitrum runs the same EVM and tooling as Ethereum (Solidity, Foundry, viem), so the contract, its tests and its signatures work unchanged.

4. **Evidence must be public.** Lemma's claims are only as good as the records behind them. Settlements, warranty activations and outcomes on Arbitrum are public transactions anyone can check on Arbiscan, which the dashboard links to. A database row cannot give that assurance.

5. **Arbitrum is betting on agents, and on checking their work.** The Arbitrum Foundation writes that the agent economy has a verification problem, and argues that agent work should be spot-checked rather than redone [14]. That is Lemma's model: a release is checked once with fixtures and benchmarks, each buyer's agent reruns only its acceptance test, and the warranty covers a failed adoption. Arbitrum also funds agents that integrate on chain through its Trailblazer grants [15].

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
| **D. Evidence anchoring** | Publish the catalog digest and each benchmark's run-set digest as attestations through the Ethereum Attestation Service (EAS), which is already deployed on Arbitrum Sepolia [19]. Prices then point at timestamped evidence nobody can rewrite, and no new contract is needed. | "This price is backed by run set 0x…", with a link to its attestation. | S |
| **E. On-chain compatibility history** | Warranty outcomes become public events or attestations. The dashboard computes each release's pass rate from the chain, not from Lemma's database. | Live pass rates anyone can recompute. | M |
| **F. Robinhood Chain deployment** | The same contracts and payments on Robinhood Chain, an Arbitrum Orbit chain. This also makes Lemma eligible for the top-3 place reserved for Robinhood Chain projects [8]. | The same purchase settling on two Arbitrum chains. | M; see the notes below |

### Creative: ideas that set Lemma apart

| Idea | What it adds to Lemma | What a judge sees | Effort |
| --- | --- | --- | --- |
| **G. Pay the maintainers** | Each purchase splits on chain: most goes to the provider, and a share goes to the open-source project the patch is based on (its provenance is already recorded). Agents reusing open source then pay the people who wrote it. | One Arbiscan transaction paying both the provider and the upstream maintainers. | S to M |
| **H. Stylus compatibility check** | Compile Lemma's deterministic fit check (platform and semver range rules) to a Stylus contract in Rust. Anyone can then verify on chain that a sold patch really matched the buyer's profile, and the warranty can use it to decide eligibility. Stylus makes this kind of parsing and comparison practical on chain. | Lemma's core logic running on Arbitrum's own contract engine. | L |
| **I. Agent identity and reputation** | Register the provider and buyer agents in an ERC-8004 agent registry, and publish adoption outcomes as reputation. Agents can then discover releases with a trustworthy track record. Buyers opt in, because a public record links a wallet to a purchase. | Agents with on-chain identities and reputations. | M; the registries are live on Arbitrum Sepolia (addresses below) [23] |
| **J. Spending caps enforced by the chain** | The buyer agent pays from a smart account whose session key only pays Lemma's provider, up to a daily cap. The limit then holds even if the bridge is compromised. | An agent that cannot overspend, even in theory. | M; another entry, VeriPay, already builds this [24] |
| **K. Demand bounties** | Anyone can put USDC behind a capability that agents keep asking for (the Demand page already ranks them). The first provider to ship a benchmarked release claims it. | A market that funds the integrations agents actually need. | M |
| **L. Releases for Arbitrum builders** | Lemma's first catalog releases are x402 integrations: payment gating for an MCP server, a paying MCP client, and an Arbitrum Sepolia facilitator (`packages/catalog/releases/README.md`). Many entries in this buildathon build these by hand (section 4). The ecosystem that hosts Lemma becomes its first market. | An integration many teams here wrote by hand, sold as a verified patch for cents. | S for the story; the releases still need payloads and benchmarks |
| **M. Pay only after the tests pass** | x402 contributors have proposed an escrow scheme [30]. With it, the payment would be held until the buyer's acceptance test passes or the claim window closes, instead of being refunded afterwards. | Money that moves only when the patch works. | L; depends on an unsettled spec |
| **N. Underwriting pools** | Third parties stake USDC behind a release's bond and earn part of its price. The warranty becomes a market, which fits the buildathon's category for new financial primitives [8]. The MVP keeps the provider first-party (`docs/security-model.md`), so this is roadmap. | Anyone can back the patches they trust. | L |

### Notes on the ideas

- **Facilitator for A.** The paused plan runs Lemma's own facilitator with the x402 package. If that stalls, there are fallbacks:
  - PayAI's hosted facilitator settles on Arbitrum Sepolia today, and another entry uses it [12][13].
  - An open-source Arbitrum facilitator by an Arbitrum developer-relations engineer supports both Arbitrum networks [16]. It routes each payment through its own address and charges 0.5% plus 0.1 USDC by default. At the worked example's price of 0.39 USDC, that fee would take about a quarter of the price. Lemma would set both fees to zero and allow the facilitator's address in the spending policy.
  - Coinbase's hosted facilitator carries Arbitrum's official x402 support [11], but it appears to cover Arbitrum One and not Arbitrum Sepolia [32].
- **Settle and activate in one transaction (A with B).** If the warranty registry receives the x402 payment itself, one transaction can take the payment and activate the warranty. That removes one of the four on-chain actions and lowers `g`. EIP-3009 warns that a transfer authorization submitted through a contract can be front-run, and recommends `receiveWithAuthorization` for that case [31]. x402's `exact` scheme signs a plain transfer, so this design needs care.
- **A lighter warranty (B).** An adoption can count as passed unless the buyer files a claim, with a small claim bond, before the window closes. This mirrors Arbitrum's own challenge-based design, and it makes the "buyer fabrication of failure evidence" threat in `docs/security-model.md` costly.
- **Measuring `g` (C).** Testnet gas prices say little about real costs. Measure the gas each action uses on Arbitrum Sepolia, then price it with Arbitrum One's gas price and data fee. The chain reports both through its built-in `ArbGasInfo` and `NodeInterface` contracts [18].
- **Robinhood Chain (F).** Its stablecoin, USDG, supports the same signed transfers as USDC [20], so the payment code carries over, although the token address and signing domain differ. We found no Robinhood Chain support in Coinbase's or PayAI's facilitators, so Lemma would run its own there. Its fees jumped sharply in early September 2026 and then fell 97% [21][22], so `g` must be measured per chain. The server also accepts only Arbitrum Sepolia today (`loadConfig` in `apps/server/src/config.ts`).

### Addresses on Arbitrum Sepolia

Checked against each project's repository on September 26, 2026.

| Contract | Address | Source |
| --- | --- | --- |
| USDC | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | `ARBITRUM_SEPOLIA_USDC` in `packages/core/src/primitives.ts` |
| ERC-8004 identity registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | [23] |
| ERC-8004 reputation registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | [23] |
| EAS | `0x2521021fc8BF070473E1e1801D3c7B4aB701E1dE` | [19] |
| EAS schema registry | `0x45CB6Fa0870a8Af06796Ac15915619a0f22cd475` | [19] |

## 4. What past winners and other entries did

### Past winners

| Project | Event | How it used Arbitrum | Lesson for Lemma |
| --- | --- | --- | --- |
| Orbital AMM Protocol | Open House India, 1st place ($40,000) [1] | A multi-asset stablecoin AMM whose high-precision math layer runs in Stylus (Rust). | Use Arbitrum-specific technology where it does real work (idea H). |
| Shinobi.Cash | Open House India, 2nd place [1] | A cross-chain privacy pool served from one Arbitrum deployment, with account-abstraction paymasters on Arbitrum to cut withdrawal costs. | Make Arbitrum carry the product's cost story (ideas A and J). |
| GuardChain.ai | Open House India, 3rd place [1] | Community insurance with AI-assisted claims, on-chain transparency, and a scoped Orbit chain for claims. | Insurance on Arbitrum wins. Lemma's warranty has the same shape (idea B). |
| Tilt Protocol | Open House NYC buildathon, 1st place ($15,000) [2] | AI agents run tokenized-stock fund vaults on Robinhood Chain's testnet through a REST API and an agent skill [26]. It later won a $100,000 seed award at the NYC Founder House [29]. | Agent-run finance on Robinhood Chain took first place. |
| Fangorn | Open House NYC buildathon, 2nd place ($10,000) [2] | x402f extends x402 to pay-gated encrypted data, with zero-knowledge proofs that keep each purchase private [27]. | An extension of x402 placed second. Lemma extends x402 with verification and a warranty. |
| EqualFi | Open House NYC buildathon, 3rd place ($5,000) [2] | Index baskets of Robinhood stock tokens that work as lending collateral [28]. | New financial primitives on Robinhood Chain score well. |
| Kustodia | NYC Founder House, 1st place ($60,000) [29] | Escrow-style programmable payments. | Payments backed by money held in a contract won the largest award. Lemma's bond is held the same way. |
| Bond.Credit | NYC Founder House, Robinhood Chain Innovation Award ($50,000) [29] | Credit underwriting for autonomous trading agents. | Underwriting agents is fundable. Lemma's warranty underwrites agent purchases (ideas B and N). |

### Other entries in this buildathon, and close precedents

| Project | What it does | What it means for Lemma |
| --- | --- | --- |
| Kajota Mesh [4] | Escrow and commission splits for commerce agents on Arbitrum Sepolia and Robinhood Chain's testnet, with EIP-3009 transfers, ERC-8004 identities, and eight contracts verified on Arbiscan. | Show proof over promises: verified contracts, transaction hashes in the README, and a map to the judging criteria. |
| AegisClear [25] | Escrow and service-level refunds for agent payments over x402 in USDG on Robinhood Chain's testnet. A zero-knowledge proof settles each dispute with a partial refund. | The entry closest to Lemma's warranty. Lemma's difference is what it warrants: a code patch whose fit and savings are checked before the sale. |
| Signal402 [13] | Analysis reports for agents, unlocked by an x402 payment in USDC on Arbitrum Sepolia and settled through PayAI's hosted facilitator. | A working fallback facilitator for idea A. |
| VeriPay [24] | A smart account per agent on Arbitrum One. The contract enforces the budget, allowed payees, a per-payment cap and an expiry. | Idea J is already another team's whole entry, so it stays on Lemma's roadmap. |
| A2A x402 Gateway [3] | AI agents pay each other through x402 in USDC on Arbitrum Sepolia, with EIP-712 signatures, 52 tests and a live settlement dashboard. It chose Arbitrum because sub-cent gas keeps micropayments viable. | The closest precedent to Lemma's payment path. Lemma adds verification, warranty and evidence on top. |
| WhaleTape x402 Gateway [5] | One x402 endpoint that settles on several chains, including Arbitrum One and Robinhood Chain. | Robinhood Chain support is achievable for an x402 product (idea F). |

### What judges reward

- **Stated criteria.** NYC judges weighed technical execution, product clarity, ecosystem alignment and long-term potential [2]. HackQuest's pages for Open House buildathons list smart contract quality, product-market fit, innovation and solving a real problem [17].
- **Verifiable proof.** Deployed and verified contracts, transaction hashes in the README, and a working demo. Judges open the repository and the demo first [7].
- **Arbitrum technology used on purpose.** Stylus, Orbit chains and paymasters, rather than "we deployed on an L2" [7]. Arbitrum's prizes at ETHGlobal's Agentic Ethereum hackathon rewarded Stylus used to power AI agents, and developer toolkits for agents [6].
- **A real product.** A working MVP, tests, documentation, a roadmap beyond the buildathon, and active commits [7].
- **This round's prizes.** The top three share $70,000, and one of those places is reserved for a Robinhood Chain project. A separate $15,000 "Promising Products" category covers AI agents and new financial primitives [8][9].

**The pattern:** an x402 payment in USDC is now common among entries, so it no longer sets a project apart. Winners pair a real financial problem with one Arbitrum feature used on purpose. Lemma should lead with what these entries do not have: a fit check and benchmark evidence before the agent pays, a price capped by the measured saving, and a bond-backed warranty after.

## 5. Recommendation for the buildathon

1. **Must have by October 4:** A (x402 settlement, resuming the paused payment work), a thin B (bond, activation, outcome, refund and expiry), and C (measure `g` once A and B run, then publish it). Ship B tested, deployed and verified on Arbiscan, because contract quality is scored [17].
2. **Lead with verification.** The demo and the README should open on the fit check, the evidence and the warranty. Payment alone is common among entries.
3. **One creative feature:** G, "pay the maintainers". It is small, it reuses the settlement from A, and it tells the story judges remember: agents that reuse open source pay the people who wrote it. Tell L's story in the pitch as well, since it costs nothing to build.
4. **If time remains:** D through EAS (no new contract), I through the live ERC-8004 registries (opt-in), then F (Robinhood Chain) for the reserved place.
5. **For the roadmap slide:** H (Stylus fit check), J (chain-enforced caps), K (demand bounties), M (pay after the tests pass) and N (underwriting pools).
6. **After the buildathon:** Founder House Singapore runs October 23 to 25 [33], and Arbitrum's Trailblazer grants fund agents that integrate on chain [15].

Demo moments to plan for:

- An agent's purchase, opened on Arbiscan.
- A bond deposit and a refund for a deliberately failing patch.
- One transaction that pays both the provider and the upstream maintainers.
- A benchmark run set attested through EAS, opened in its explorer.
- The same purchase settling on Robinhood Chain.

Lines for the pitch:

- "Lemma's price formula contains Arbitrum's gas. If a purchase cost 0.675 USDC in chain fees, nothing could be sold."
- "Agents never hold ETH. They sign a USDC transfer, and our facilitator settles it on Arbitrum."
- "Every warranty is money at stake in a contract, and every outcome is public."
- "The Arbitrum Foundation writes that the agent economy has a verification problem. Lemma checks the work before an agent pays for it."
- "Many teams here built an x402 paywall by hand. It is the first integration in Lemma's catalog."

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
10. [Arbiscan gas tracker](https://arbiscan.io/gastracker).
11. [x402 and MPP for agentic finance on Arbitrum](https://blog.arbitrum.io/x402-and-mpp-for-agentic-finance-on-arbitrum/).
12. [PayAI adds x402 support for Arbitrum](https://blog.payai.network/x402-on-arbitrum-payai-adds-support-for-arbitrum-one/).
13. [Signal402 repository](https://github.com/zedili/Signal402-Arbitrum-Singapore).
14. [The agent economy has a verification problem](https://blog.arbitrum.foundation/the-agent-economy-has-a-verification-problem/).
15. [Trailblazer: $1M in grants for AI on Arbitrum](https://blog.arbitrum.foundation/trailblazer-1m-grants-to-power-ai-innovation-on-arbitrum/).
16. [x402 facilitator for Arbitrum](https://github.com/hummusonrails/x402-facilitator).
17. [Arbitrum Open House India online buildathon on HackQuest](https://www.hackquest.io/hackathons/Arbitrum-Open-House-India-Online-Buildathon).
18. [Arbitrum docs: how to estimate gas](https://docs.arbitrum.io/build-decentralized-apps/how-to-estimate-gas).
19. [EAS contract deployments](https://github.com/ethereum-attestation-service/eas-contracts).
20. [USDG contract repository](https://github.com/paxosglobal/usdg-contract).
21. [The Defiant: Robinhood Chain gas fees jump 82-fold in 11 days](https://thedefiant.io/news/blockchains/robinhood-chain-gas-fees-jump-82-fold-in-11-days-to-top-every-other-chain).
22. [CoinDesk: Robinhood Chain fees collapse 97%](https://www.coindesk.com/business/2026/09/19/robinhood-chain-fees-collapse-97-even-as-transactions-stay-near-record-highs).
23. [ERC-8004 contract deployments](https://github.com/erc-8004/erc-8004-contracts).
24. [VeriPay repository](https://github.com/liunix61/veripay).
25. [AegisClear repository](https://github.com/mdlog/AegisClear).
26. [Tilt Protocol agent skill](https://github.com/rontoTech/tilt-protocol-openclaw).
27. [x402f by Fangorn](https://github.com/fangorn-network/x402f).
28. [EqualFi on HackQuest](https://www.hackquest.io/projects/Arbitrum-Open-House-NYC-Founder-House-EqualFi-RobinHood).
29. [NYC Founder House awards](https://blog.arbitrum.foundation/nyc-founder-house-concludes-with-340k-in-awards-to-winning-teams/).
30. [x402 escrow scheme proposal](https://github.com/x402-foundation/x402/issues/2222).
31. [ERC-3009, security considerations](https://eips.ethereum.org/EIPS/eip-3009).
32. [Coinbase x402 network support](https://docs.cdp.coinbase.com/x402/network-support).
33. [Founder House Singapore](https://blog.arbitrum.foundation/founder-house-singapore-apply-now-to-launch-products-on-arbitrum-one-robinhood-chain/).

Repository pages on GitHub, ERC-3009 and the contract addresses above were read directly on September 26, 2026. The other pages, including the x402 escrow proposal, could not be opened from the build environment. Their content comes from search-result summaries and should be re-checked before it is quoted in the submission.
