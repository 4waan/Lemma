# Arbitrum in Lemma

This document explains why Lemma runs on Arbitrum, what is already built, and the ways the product can use Arbitrum more deeply during the Arbitrum Open House Singapore buildathon (submissions close October 4, 2026). It also records what past Arbitrum winners and this round's other entries built, so the team can see which kinds of integration judges reward. Section 6 asks whether Arbitrum can carry more than payments, and [arbitrum-roadmap.md](arbitrum-roadmap.md) holds the two ideas it leaves for later.

Everything here is on testnet. Amounts are test USDC. Status labels are as of September 26, 2026, except section 6, which is as of September 27, 2026.

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
| ERC-8004 reputation: provider identity, feedback per finalized outcome, cached pass rates | `apps/server/src/reputation/` | In progress on the branch `reputation/erc-8004` (September 27); see section 6 |
| Stylus compatibility-confidence engine | `contracts/stylus/`, `packages/confidence/` | In progress on the branch `contracts/stylus-confidence` (September 27); see section 6 |

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

Section 6 updates items 4 and 5. Idea I is being built now, and a Stylus confidence engine takes the place of H's on-chain fit check. J (chain-enforced caps) and a private version of H (zero-knowledge proofs) are roadmap items with their own document.

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

## 6. Beyond payments

Sections 1 to 5 use Arbitrum for payments and the warranty. This section asks whether Arbitrum can carry more of the product. It analyzes four ideas against the current code: ERC-8004 reputation, bounded spending with ERC-7715 and ERC-7710, a Stylus compatibility-confidence engine, and zero-knowledge compatibility proofs. They refine ideas E, H, I and J of section 3.

One rule decides every verdict: **the MCP experience stays fast and nearly hands-free.** Anything that adds a manual blockchain step, or makes an agent's tool call wait for the chain, is marked **UX gap: holds implementation**, and it is not built until the gap is lifted.

**Status on September 27, 2026, stated plainly:**

- ERC-8004 reputation is being built on the branch `reputation/erc-8004`. It is not finished.
- The Stylus confidence engine is being built on the branch `contracts/stylus-confidence`. It is not finished.
- Both consume outcomes, so both depend on the paid path (branch `payments/x402-paid-path`) and the warranty registry (branch `contracts/warranty-registry`), which are also being built. Nothing in this section is deployed.
- Bounded spending and ZK compatibility proofs are roadmap items. [arbitrum-roadmap.md](arbitrum-roadmap.md) documents both in depth, with their UX gaps.

### 6.1 What Lemma already has

- **The receipt is the atom.** An `AdoptionReceipt` (`packages/core/src/receipt.ts`) records the resolution id, the outcome (`passed`, `failed` or `abandoned`), the acceptance run's exit code, duration and output digest, and a slot for the buyer's signature. The slot stays empty until the buyer signs with a typed-data layout defined by the contract work (EIP-712, being added by the paid path); smart-account signatures are accepted. The `Resolution` it points to binds the release digest, the matched profile index, the profile digest, the payload digest, the buyer and the payment terms. The acceptance recipe is fixed by the release manifest's digest. Joined, the two objects already say which release, on which profile, tested by which recipe, with what result. Publishing outcomes needs no new data, only a choice of what to publish.
- **Compatibility history is already planned, off chain.** Lever 7 of [economic-gates.md](economic-gates.md) groups verified receipts by release digest and profile index to estimate the failure rate `q`, stop offering failing profiles, and later build provider reputation. Lever 8 reserves a ranking slot: "Pass rate slots in after 'sellable' once verified receipts exist." The two ideas being built put these levers on chain.
- **Privacy is a design rule.** The resolution id is public, so the payment nonce is derived from it and the preview id rather than being the id itself; otherwise "anyone could join a wallet to what it bought" (`deriveResolutionId`). The public `ResolutionView` leaves out the buyer, the preview id, the settlement reference and the profile digest. Anything published on chain must keep that property.
- **Key custody is the heaviest setup burden.** Acceptance tests run as the user and can read the user's files and the bridge's start environment, so the buyer key belongs with "a signer that runs as another user, or on a hardware or remote signer" ([apps/bridge/README.md](../apps/bridge/README.md)).
- **Every idea needs outcomes, and outcomes only exist after settled purchases.** The server accepts a receipt only for a settled resolution (it answers `NOT_SETTLED` otherwise, in `apps/server/src/service.ts`). Reputation, confidence and proofs all wait on the paid path and the warranty registry. An outcome with no payment behind it is the ungrounded kind of feedback that, as idea 1 shows, the existing registries are already full of.

### 6.2 The four ideas

#### Idea 1: ERC-8004 reputation. Verdict: build now

**What the standard is.** ERC-8004 ("Trustless Agents") is a Draft ERC with three registries [34]:

- **Identity.** One ERC-721 token per agent. Its `agentId` is the token id, and its URI points to a registration file that lists the agent's services (for example an `MCP` endpoint), `x402Support`, and `supportedTrust` values such as `reputation` or `crypto-economic`. The spec says: "If absent or empty, this ERC is used only for discovery, not for trust."
- **Reputation.** `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`. Anyone may post, except the agent's owner or an approved operator. Nothing checks a payment: the spec calls payments "orthogonal", and a `proofOfPayment` exists only inside the optional off-chain feedback file. `getSummary(agentId, clientAddresses, tag1, tag2)` returns a count and an average, and the reviewer list is required: "results without filtering by clientAddresses are subject to Sybil/spam attacks". Trusting specific reviewers is the spec's own answer to fake reviewers.
- **Validation.** A `validationRequest` "MUST be called by the owner or operator" of the agent, and a validator answers 0 to 100. The contracts repository lists no validation registry on Arbitrum Sepolia and calls it "still under active update" [23].
- **On Arbitrum.** The identity and reputation registries are on Arbitrum Sepolia (section 3's address table) and on Arbitrum One (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`) [23]. The Arbitrum Foundation writes that ERC-8004 "went live on Arbitrum on February 5th" 2026 [35]. The deployed contracts report version 2.0.0 and are upgradeable proxies that the ERC-8004 team controls [23].
- **Beware old tutorials.** An October 2025 revision had agents sign a `feedbackAuth` and used a `uint8 score`. The current text has neither [34].

**The gap Lemma fills.** An index of every feedback event on Ethereum and Base, up to Ethereum block 25,601,019 and Base block 49,018,739 (roughly six months of events), counts 419,155. One agent receives 66.05% of all Base feedback, from 60 worker wallets of one mining protocol, and the validation registry has seen 12 requests, all from one agent whose validator is its own owner [36]. A paper quoted in issue #99 of the contracts repository finds that "feedback records are rarely grounded in verifiable interactions", and the issue proposes admitting only feedback grounded in a paid interaction, an escrow release or an outcome checked against a claim [37]. Lemma's outcomes are grounded four ways at once: a paid resolution, a bonded warranty, an acceptance recipe pinned by digest, and an evaluator's signed verdict. The research behind this section found test-based outcomes only in hackathon projects, and none for code patches.

**How it fits Lemma, with no step for the buyer.** This is the planned design for the branch `reputation/erc-8004`, not a description of finished code; names and details may change before that branch merges.

- **Provider identity.** Lemma's provider registers once as an ERC-8004 agent. The server serves the registration file (`GET /api/v1/agent/registration.json`) with the MCP endpoint, `x402Support: true` and `supportedTrust: ["reputation", "crypto-economic"]`. The provider bond is the crypto-economic part.
- **Provider reputation.** For each finalized outcome, one published Lemma attester address posts feedback on the provider's `agentId`: `value` 100 for passed and 0 for failed with `valueDecimals` 0 (abandoned runs are left out), `tag1` set to `"lemma.adoption"`, `tag2` set to the capability id, and a `feedbackURI` pointing at a public evidence file (`GET /api/v1/evidence/:resolutionId`) whose canonical JSON bytes hash to `feedbackHash`. Then `getSummary(provider, [attester], "lemma.adoption", capability)` gives anyone a pass rate and a count per capability.
- **Agent reputation, opt in.** A buyer that sets `LEMMA_AGENT_ID` in the bridge receives the same feedback from the attester. That is task-specific, evidence-backed reputation for the coding agent, and it costs the agent nothing.
- **Reads.** The server caches each summary for five minutes. The Catalog shows it, and a matched preview carries it as metadata, from which the bridge adds a short token such as ` Record: pass 97%, n 34.` to its answer, still within 600 characters. Nothing on the buyer's path waits for the chain.
- **Privacy.** The evidence file names the resolution, the release and profile index, the capability, the recipe digest, the acceptance result, the verdict and the time. It never names the buyer, the payer, the preview id, the settlement transaction or the nonce. An opted-in agent is the only exception, by its own choice.
- **Not used: validation requests from buyer agents.** Each would need a transaction from the agent's owner per adoption. **UX gap: holds implementation.** It lifts once the owner's account can hand that one call to a session key and a sponsor pays the gas, which is the bounded-spending work in the roadmap.

**Risks and answers.**

- **Wash adoption.** A provider that buys its own patch gets the price back and pays only gas, so a pass rate can be inflated cheaply. The evaluator signs each outcome's weight and can count a doubtful one for less. Publishing distinct-buyer counts next to every pass rate is planned, not built.
- **A Draft, upgradeable registry.** Lemma treats ERC-8004 as a public mirror. Bonds, refunds and confidence stay in Lemma's own contracts.
- **Keys.** The attester key holds no funds. It must differ from the key that owns the provider's agent, because the registry refuses feedback from the owner or an operator.

#### Idea 2: bounded spending with ERC-7715 and ERC-7710. Verdict: roadmap

**What the standards are.**

- ERC-7715 (Draft) lets an app ask a wallet for an execution permission through `wallet_requestExecutionPermissions` [38]. ERC-7710 (Draft) is how that permission is spent: its holder calls `redeemDelegations` on a delegation manager, and caveat enforcers check each call [39].
- MetaMask's Delegation Framework v1.3.0 is deployed at the same addresses on Arbitrum One and Arbitrum Sepolia, including its `DelegationManager` and a per-period ERC-20 spending enforcer [40].
- EIP-7702 is live on Arbitrum since ArbOS 40 (Arbitrum Sepolia on May 6, 2025, Arbitrum One on June 17, 2025), so an existing account can gain these features without changing its address [41].
- x402's `exact` scheme already lists ERC-7710 as its "Smart Account Option", verified by simulating `redeemDelegations` [42].

**How it fits Lemma.** In the paid path being built, the spending policy (per-purchase cap, daily cap, token, recipient) is enforced by code: core `checkPurchase`, the bridge, and a separate signer process (`lemma-signer`) that holds the buyer key. Under a delegation, the chain enforces the daily cap, the token, the payee and an expiry. A compromised bridge, or an acceptance test that reads the bridge's key, could then spend at most the daily cap, only in USDC, only to Lemma's provider, and only until the expiry. That bounded worst case would let the bridge hold a session key itself and retire the separate signer, the heaviest setup step in that design. Once set up, this improves the UX rather than costing it.

**Why it waits.**

- The x402 reference facilitator implements EIP-3009 and Permit2 only; the installed `@x402/evm` 2.27.0 has no ERC-7710 code. MetaMask's hosted facilitators do not cover Arbitrum. Lemma's own facilitator would have to add ERC-7710 settlement.
- It is a second payment method inside the paid path, which is still being built.
- MetaMask's browser grant needs the desktop extension, a smart-account upgrade, an approval page per grant, and a renewal at each expiry. **UX gap: holds implementation.** It lifts when a one-click local grant page, a sponsored or ETH-free upgrade, a long expiry with a revoke button, and a path without the extension are proven ([arbitrum-roadmap.md, section 1.5](arbitrum-roadmap.md#15-two-setup-paths)).
- Settlement is estimated at 2.5 to 3.5 times the gas of a plain EIP-3009 transfer. This is an estimate from the code paths, not a measurement.

[arbitrum-roadmap.md, section 1](arbitrum-roadmap.md#1-bounded-spending-erc-7715-and-erc-7710) has the addresses, the two setup paths, gas and latency, trust points, what it would replace, and a checklist for starting.

#### Idea 3: a Stylus compatibility-confidence engine. Verdict: build now

**What Stylus is, and what it is not.** Stylus runs WebAssembly contracts, written in Rust for example, beside the EVM on Arbitrum. They use the same ABI as Solidity contracts, so the two call each other [43].

- Arbitrum's docs quote compute as "10-100x" cheaper and memory as "100-500x" cheaper, but "storage operations cost roughly the same as in the EVM", and every call pays a start-up cost of 8,832 gas (352 when the program is cached) [43].
- Equinox, another entry in this buildathon, measured 256-bit fixed-point arithmetic as "~3× *more* expensive in WASM" than in the EVM, and whole transactions within 1.05 to 1.08 times of Solidity [44].
- A Stylus contract must be reactivated every 365 days [43]. ArbOS 61 raised the Stylus size limit to 96 KB [45]. The current `cargo-stylus` (0.10.9, August 11, 2026) needs Rust 1.91 or newer; `stylus-sdk` 0.10.9 was published the same day [50].

So the pitch is not cheaper gas. What Stylus gives Lemma:

- **One algorithm, the same numbers in two places.** A `no_std`, integer-only Rust crate runs in the Lemma server (compiled to WebAssembly for Node) and on chain as a Stylus contract. The resolver's ranking and the public on-chain value then cannot disagree. This is the determinism rule the resolver already follows.
- **Room for a real model.** The Arbitrum Foundation names "reputation scoring algorithms" among the on-chain logic "that would be impractical in Solidity" [35]. Time-decayed, weighted scoring with a confidence bound fits easily in WebAssembly.
- **Public recomputation.** Anyone can recompute a release's confidence from on-chain events.

Postgres stays the operational store, with fast queries and private fields. The chain holds only what must be public: one record per finalized outcome and running sums per release and profile. Moving the whole history on chain would be slower and would leak more.

**The model** (per release digest and profile index, in integer fixed-point math with 18 decimals, no floating point):

- **A prior from the benchmark.** The treatment arm's passes and failures count as earlier outcomes, so a new release starts from measured evidence rather than from zero.
- **Weighted outcomes that fade.** Each finalized outcome carries a weight in basis points that the evaluator signs. Weights halve every 30 days, so old evidence ages out as dependencies move on.
- **A cautious result.** The lower end of a 90% Wilson interval, in basis points, with the effective sample size. Three passes do not score like three hundred.

**How it fits.** This is the planned design for the branch `contracts/stylus-confidence`, not a description of finished code; names and details may change before that branch merges.

- A crate, `lemma-confidence`, with shared test vectors that the Rust tests and a TypeScript package both replay.
- A Stylus contract that stores the sums. `record` is callable only by the warranty registry, `setPrior` only by the owner (with the evidence digest), and `confidence(release, profile)` is a view. `cargo stylus export-abi` produces the Solidity interface the registry calls.
- The server loads the same crate as a committed WebAssembly file that rebuilds byte for byte, and adds a `compatibility` field (confidence, effective sample size, outcome count, source) to each profile in the catalog read model. The dashboard shows it on the Catalog and Proof pages, with "no outcomes yet" while only the prior exists.
- The registry calls the engine inside `finalizeOutcome` and catches any failure, so a broken engine never blocks a refund.
- Later: rank by confidence in lever 8's slot, and stop offering a profile whose confidence falls below a floor once enough outcomes exist (lever 7). That needs a new sale-blocker reason code.

**Risks.** Deploying needs Sepolia ETH (about 0.001 testnet ETH per deployment and activation, derived from the Arbitrum docs' examples [51]) and a reachable RPC, which this build environment does not have. If Stylus stalls, the fallback is a Solidity port held bit-identical by the same test vectors, as Equinox did [44].

#### Idea 4: zero-knowledge compatibility proofs. Verdict: roadmap, with a UX gap

**What it would be.** A buyer proves that its repository fits a release's supported profile without revealing the profile: privacy-preserving procurement for agents. It is the private form of idea H, which would otherwise need the buyer's profile on chain.

**What a proof can and cannot say.** A proof hides a self-attested profile but cannot make it true, so it does not stop a buyer claiming a fit it does not have. The only binding that looks practical soon is a GitHub Actions OIDC token whose audience is the profile commitment [47], and that runs in CI, not per purchase. [arbitrum-roadmap.md, section 2.2](arbitrum-roadmap.md#22-what-a-proof-can-say-and-what-it-cannot) has the detail.

**Cost to the agent.** With the native Noir prover, a small predicate of 2^12 to 2^15 gates proves in about 0.5 to 1.1 seconds on a laptop (0.52 s and 1.13 s in published benchmarks [48]). The Noir prover package `@aztec/bb.js` 5.2.0 unpacks to about 157 MB [49]. Verifying on chain costs about 230,000 gas with Groth16, which needs a trusted setup [25], to about 2.4 million gas with UltraHonk [46]. The latency and the install break the fast-MCP rule. **UX gap: holds implementation.** It lifts when proving runs outside the purchase call and is reused while the profile is unchanged, and the prover is an opt-in install ([arbitrum-roadmap.md, section 2.3](arbitrum-roadmap.md#23-what-it-costs)).

**What Lemma does now, at no UX cost.** It keeps the profile digest off the chain and out of public views. The digest is unsalted, and the space of profiles is small (a few languages, Node majors, package managers and dependency versions), so a published digest could be matched by trying candidates. The way forward is in [arbitrum-roadmap.md, section 2](arbitrum-roadmap.md#2-zero-knowledge-compatibility-proofs): first a salted profile commitment (a schema change), then an eligibility proof used only in warranty disputes, then CI-bound proofs for teams.

### 6.3 Verdicts

Effort uses section 3's scale.

| Idea | Verdict | Status on September 27, 2026 | Effort | UX effect | Needs first, and what lifts a UX gap |
| --- | --- | --- | --- | --- | --- |
| ERC-8004 reputation for providers and opted-in agents | Build now | Being built on `reputation/erc-8004`; not finished | M | None for buyers; agents opt in with one setting | Outcomes: the paid path and the warranty registry |
| Stylus compatibility confidence | Build now | Being built on `contracts/stylus-confidence`; not finished | M to L | None: on the server, cached, after the fact | Outcomes; Sepolia ETH and a reachable RPC to deploy |
| ERC-7710 bounded spending, headless setup | Roadmap | Documented in [arbitrum-roadmap.md](arbitrum-roadmap.md) | M | Better than the paid path's design once set up; one automated setup step | The plain x402 paid path; ERC-7710 settlement in Lemma's facilitator |
| MetaMask Advanced Permissions (ERC-7715 browser grant) | UX gap: holds implementation | Documented in the roadmap | M | Browser approval, smart-account upgrade, renewals, no mobile | The gap lifts when a one-click local grant page, a sponsored or ETH-free upgrade, a long expiry with a revoke button, and a path without the extension are proven (roadmap section 1.5) |
| ZK compatibility proof | Roadmap; UX gap: holds implementation | Documented in the roadmap | L | About 0.5 to 1.1 seconds of proving and about 157 MB per agent | A salted profile commitment, then a binding such as GitHub OIDC. The gap lifts when proving runs outside the purchase call and the prover is an opt-in install (roadmap section 2.3) |
| ERC-8004 validation requests from buyer agents | UX gap: holds implementation | Not planned | S | A transaction per adoption from the agent's owner | The gap lifts with a delegated, sponsored call (roadmap) |

### 6.4 UX rules every integration follows

1. No chain call inside an agent's tool call, except the payment itself: one signature, settled by the facilitator.
2. Agents never hold ETH. The facilitator or a sponsor pays gas.
3. On-chain writes (warranty activation, outcomes, confidence records, feedback) happen after the fact, on the server, batched and retried.
4. On-chain reads are cached on the server. A preview stays one fast call.
5. Setup may add at most one automated step, run by one command (a future `lemma-mcp setup`). Anything more is a UX gap that holds implementation.
6. Tool answers keep their 600-character limit. Chain facts appear as short codes and numbers, never as prose.

### 6.5 Target flow: one outcome, four public records

```text
purchase: x402 exact with EIP-3009; the facilitator pays gas                  [1 settlement]
  -> the server activates the warranty in the registry
     (the provider's signed voucher; bond reserved)                           [2 warranty]
  -> the bridge applies the patch, runs the pinned tests, signs the Adoption Receipt
  -> the evaluator's signed verdict finalizes the outcome in the registry
     (passed: bond released; failed: a refund credit)                         [2 warranty, closed]
       -> the registry calls the Stylus engine:
          record(release, profile, passed, weight)                            [3 confidence]
  -> the attester posts ERC-8004 feedback on the provider,
     and on the buyer's agent if it opted in                                  [4 reputation]
  -> the server caches confidence and pass rates for the Catalog and the preview answer
```

Only the settlement happens inside an agent's tool call. Everything after it runs on the server, asynchronously and retried, and the agent never waits for the chain.

| Record | Contract | Written by | What it names |
| --- | --- | --- | --- |
| 1. Settlement | USDC (`transferWithAuthorization`) | The facilitator, during the paid call | The payer's wallet, the provider, the amount, and a nonce that cannot be joined to the resolution without the preview id |
| 2. Warranty | Lemma's warranty registry | A server relayer (activation) and anyone carrying the evaluator's signed verdict (finalization) | The resolution id, release digest, profile index, amount, verdict and a claim hash; never the buyer |
| 3. Confidence | The Stylus engine | The registry, inside finalization | The release digest, profile index, pass or fail, and weight |
| 4. Reputation | The ERC-8004 reputation registry | Lemma's attester | The provider's `agentId`, 100 or 0, the capability tag, and the evidence file's link and hash |

**The privacy rule for this flow.** The settlement is the only record that names the buyer's wallet, so no other record may point back to it.

- The registry never stores a buyer or payer address. The payment reference in the provider's voucher is a salted commitment chosen by the server, never a function of the payer and the nonce.
- A refund credit is withdrawn by presenting a per-purchase secret and a refund address whose hash (`claimHash`) was fixed in the voucher. The refund address is revealed when the credit is withdrawn. It defaults to the buyer's own address, so a refund does join that wallet to that resolution. A buyer who wants no link sets a fresh refund address and has the withdrawal relayed (next point).
- Finalization and credit withdrawal are sent by a relayer (Lemma's server or any third party), never from the buyer's wallet. A transaction's sender is public, so sending one yourself joins your wallet to the resolution. The relayer also pays the gas, as UX rule 2 requires, and a fresh refund address holds no ETH anyway.
- Engine records and feedback name releases, profiles and capabilities, never buyers. An agent that opts in to reputation is the only exception, by its own choice.
- Timing and amounts can still hint at a link while volume is low. Batching activations and finalizations blurs that, but does not remove it.

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
34. [ERC-8004: Trustless Agents](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8004.md) (Draft; the October 2025 revision is commit `cb7ae283` of the same repository).
35. [Arbitrum Foundation: AI and Stylus, the builder's new toolkit](https://blog.arbitrum.foundation/ai-and-stylus-the-builders-new-toolkit/) (February 25, 2026).
36. [ERC-8004 forensics: a full index of the registries on Ethereum and Base](https://github.com/marsakahenry14-lab/erc8004-forensics): `FINDINGS.md` for the counts, and `process/STATUS.md` for the indexed block ranges.
37. [erc-8004-contracts issue #99](https://github.com/erc-8004/erc-8004-contracts/issues/99), which quotes the paper [arXiv 2606.26028](https://arxiv.org/abs/2606.26028).
38. [ERC-7715: Request Permissions from Wallets](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7715.md) (Draft).
39. [ERC-7710: Smart Contract Delegation](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7710.md) (Draft).
40. [MetaMask Delegation Framework deployments](https://github.com/MetaMask/delegation-framework/blob/main/documents/Deployments.md).
41. [Arbitrum network upgrades](https://github.com/ArbitrumFoundation/docs/blob/main/docs/network-upgrades.md).
42. [x402 `exact` scheme on EVM](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md).
43. Arbitrum docs: [a gentle introduction to Stylus](https://docs.arbitrum.io/stylus/gentle-introduction) and [Stylus gas metering](https://docs.arbitrum.io/stylus/concepts/gas-metering).
44. [Equinox, a Stylus options AMM](https://github.com/nodesproof/equinox).
45. [ArbOS 61 Elara release notes](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos61).
46. [ERC-8262 and its reference implementation](https://github.com/xochi-fi/ERC-8262).
47. [GitHub Actions OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc).
48. Proving benchmarks: [noir-benchmarks](https://github.com/Savio-Sou/noir-benchmarks) (the native `bb` prover, version 0.63.0, on an Intel Core i7-13700HX laptop).
49. [`@aztec/bb.js` on npm](https://www.npmjs.com/package/@aztec/bb.js) (version 5.2.0, 156,572,374 bytes unpacked).
50. [`cargo-stylus`](https://crates.io/crates/cargo-stylus) and [`stylus-sdk`](https://crates.io/crates/stylus-sdk) on crates.io (version 0.10.9 of each; only `cargo-stylus` declares a minimum Rust version).
51. Arbitrum docs: [Stylus quickstart](https://docs.arbitrum.io/stylus/quickstart) (a deployment of 7,123,737 gas at 0.1 gwei, 0.000712 ETH) and [check and deploy](https://docs.arbitrum.io/stylus/cli-tools/check-and-deploy) (a WebAssembly data fee of 0.0001 ETH for activation).

Repository pages on GitHub, ERC-3009 and the contract addresses above were read directly on September 26, 2026. The other pages, including the x402 escrow proposal, could not be opened from the build environment. Their content comes from search-result summaries and should be re-checked before it is quoted in the submission.

Sources 34 to 51 were read on September 27, 2026 from their source repositories or registries: the ERCs, specifications and GitHub, Arbitrum and x402 docs as raw files on GitHub, the Foundation post [35] through its author's mirror, and the npm and crates.io entries through their registries. Nothing was read on chain, because this build environment cannot reach Arbitrum's RPCs or explorers. The arXiv paper in [37] is known only through its quotation in the issue.
