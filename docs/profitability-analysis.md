# Making Lemma sustainably profitable

Subtitle: Where the unit economics break, which business models fix them, who would pay for what, and what to test before spending more.

> **Update, October 1, 2026.** [OBSERVED] Since this analysis was prepared, the five feature branches have merged into `main` (pull requests #51 to #55) and run on Arbitrum Sepolia. One purchase passed and one was refunded, through the shipped bridge, on a demo release whose evidence is made up ([deployments/arbitrum-sepolia.md](deployments/arbitrum-sepolia.md)). The gas was measured there: about 454,000 for a passed purchase (settlement 91,275, warranty activation 216,065, outcome with its engine record 146,896), and 84,009 more for a refund's withdrawal. The rest of this report is as prepared on September 28. Its [PLANNED] items are now merged and on testnet, and nothing else it depends on has been measured yet: no saving, no evidence cost, no buyer outside the test, and the chain cost `g` in `packages/catalog/economics.json` is still the placeholder 0.

## 1. Executive summary

**What this report rests on.** [REPO] The business model is the one in Lemma's repository (`docs/economics.md`, `docs/economic-gates.md`, the catalog, the bridge and server code) and in the revenue report of September 27, 2026 ([`docs/business-model.md`](https://github.com/4waan/Lemma/blob/23f16e4ce32f1d05038a8b86608b3d9e1e53ef10/docs/business-model.md), kept at commit `23f16e4` of pull request #37), whose 121 sources supply every external fact quoted here. Every modeled number comes from one script, `docs/profitability-analysis/model.mjs`, whose inputs are listed in section 15. Amounts are USD; the repository treats 1 USDC as 1 USD. Nothing Lemma has built has settled a payment on any chain, so no Lemma amount below is observed.

> **The verdict.** [INFERENCE] The model as designed is a good proof of a mechanism and a bad business, and better execution will not change that. An agent pays at most 30% of a measured token saving for a patch whose fit is evidenced, tested and bonded. That yields cents per sale, against evidence that costs thousands per release per year and expires. Keep the mechanism as a public rail and a source of outcome data. Build the company on a different unit of sale: a maintained, evidenced integration, sold to organizations by the year.

**Why it breaks, in numbers.** [MODELED] Every figure below is derived from the repository's own worked example and from assumptions that section 14 lists as unvalidated.

- A resolution earns 0.39 and contributes 0.295 after refunds, chain cost, the facilitator, infrastructure and support, before any evidence cost.
- Evidence for one release-profile-class costs about 1,682 to create and 3,128 a year to keep fresh in the mid case. The docs' figure of 30 counts compute only, on a cheap model. Paying the mid figure back needs 5,702 sales per release version: 63 a day over a 90-day shelf life. [RESEARCH] The whole x402 rail on Base handles about 73,000 payments a day across every seller, and about 6% of buyers come back.
- The buyer's setup (a funded wallet, a separate signer, spending caps) costs 35 to 341 purchases' worth of token savings before the first cent is saved.
- Reviewing a failed adoption by hand, which is the pipeline's default, costs 0.83 per resolution at a 10% failure rate and five minutes a review: twice the price.
- The chain stack (facilitator, warranty registry, Stylus engine, ERC-8004 attester, indexer and jobs) carries fixed operating and audit costs, and its economic function, letting outside providers, buyers and underwriters trust Lemma without trusting the company, is not exercised while Lemma is the only provider and the only evaluator.

**What to change.** [INFERENCE]

| Today | Change | Why the economics improve |
| --- | --- | --- |
| The unit of sale is one patch for one agent, priced in cents | A maintained release-profile per year, sold to an organization | Contribution per sale goes from 0.295 to thousands, and revenue takes the same shape as the cost |
| The price is 30% of a measured token saving | Price against the payer's alternative (a developer-relations budget, a platform seat). Keep the 30% cap only for anonymous agent purchases | Revenue stops depending on a shrinking input that Lemma does not control |
| Lemma pays for evidence before any sale | The sponsor pays for evidence up front and supplies fixtures and tests; Lemma measures | Evidence is funded before it is produced, and labor per release halves |
| A micro-refund backed by bond, with failures reviewed by hand | Automated verdicts for the public catalog. For organizations, a fix-time promise: a re-benchmark within days of a breaking SDK release | Review cost leaves the per-unit path. The promise is what organizations already pay for |
| The chain stack is the revenue mechanism | The chain is the proof layer and the rail, with its cost capped: mainnet and audits only when a paying customer needs them | Fixed cost falls while the trust asset stays |
| Team plans per seat or per repository | Per maintained integration, plus a platform fee | A 47% margin instead of 3% |
| An open marketplace with a 10% fee | Closed; commissioned supply only | The fee is below the cost to serve |

**What the better economics look like.** [MODELED] A vendor program at 12,000 a year (agent-ready certification and upkeep for one product) contributes 7,645 (64%). Fifteen programs cover a one-founder cost base of 9,000 a month; 52 cover a 2.5-person team. A team plan priced per maintained integration contributes 47%; the same plan priced per repository contributes 3%. An agent-platform partnership contributes 85%.

**The honest reading of the scenarios.** [MODELED] In the base case Lemma earns 79,514 in its first year, reaches a recurring run-rate of 64,800 a year, needs 58,354 of cash on the lean base, and does not cover even that base from recurring contribution within twelve months. The upside case reaches a 304,000 run-rate and covers the lean base from month 8. No scenario covers a 2.5-person team in year one. Lemma is a lean, grant-supported business in year one. It becomes a team-sized business only by closing eight or more vendor programs at 24,000, or about twenty at 12,000, or by landing platform and enterprise contracts.

**Before spending more.** [INFERENCE] Seven experiments in 60 days, with a cash cost under 3,000 plus founder time, each with a decision rule (section 12): measure the true cost of evidence; pre-sell vendor programs against a price ladder and ask for deposits; run concierge team pilots priced per integration; measure wallet friction; ask platforms and registries; put up a priced plan page; time the evidence work. Two kill rules: if no vendor pays a deposit by day 60, the vendor model is out; if the measured saving on a frontier model is under 0.30, the agent-paid unit stays free.

| Question | Short answer |
| --- | --- |
| Is the current model viable? | As a business, no. As a rail and an evidence source, yes. |
| What should Lemma sell? | A maintained, evidenced, agent-ready integration, by the year. |
| Who pays first? | Integration vendors. Then engineering teams, per maintained integration. Then agent platforms. |
| What does the agent pay? | Cents, capped at 30% of the saving. Budget it as marketing and data, not revenue. |
| What is the moat? | Grounded outcomes per release and profile, and the evidence factory that produces them cheaply. |
| What must be true? | Vendors pay at least 6,000 a year, evidence costs under about 3,000 a year per release class, and the fit rate is high enough for adoptions to happen. |

## 2. The model as designed, and what has changed

### The mechanism

[REPO] Lemma sells a Compatibility Resolution: one digest-pinned integration patch, matched to one repository profile, with a pinned acceptance recipe and a bonded warranty. The steps and their economic roles:

| Step | What happens | Economic role |
| --- | --- | --- |
| Preview | The bridge sends a typed profile (language, runtime, package manager, frameworks, matched dependency versions), never source. The resolver answers `reuse`, `adapt`, `build` or `decline` deterministically | Free. It is what makes agents call Lemma |
| Offer | Only `reuse` and `adapt` can carry a price, only with frozen benchmark evidence, and only if `price <= 30%` of the measured saving and the buyer ends at least 25% cheaper after chain cost | The sale rule: `maxPriceFor(S, C, g) = min(floor(0.3 S), S - g - ceil(0.25 C))` |
| Purchase | The agent's wallet pays USDC over x402 on Arbitrum; Lemma's own facilitator settles and pays gas | Revenue of cents per sale |
| Warranty | A provider-signed voucher reserves bond equal to the price; an evaluator finalizes pass or fail within a 72-hour window; a failure is refunded from the bond | The promise; the outcome data |
| Outcome | Verified receipts feed a per-profile confidence (a 90% lower bound on the pass rate) and ERC-8004 feedback | The public track record |

[REPO] The docs' worked example uses a control cost `C = 2.50`, a conservative saving `S = 1.30`, a chain cost `g = 0.01` and a failure rate `q = 0.10`, all "illustrative assumptions, not measurements". The price ceiling is 0.39. Evidence per release version is a frozen 20-run benchmark matrix, tied to one model and price sheet, with a stale date.

### What has changed since the revenue report

- [PLANNED] Everything the revenue report called planned is now built, on five branches: the x402 paid path with a separate buyer signer, the warranty registry (117 Foundry tests), the Stylus confidence engine, ERC-8004 reputation, and the outcome pipeline that connects them. The combined branch passes 968 tests and a seven-scenario run on a local chain with Circle's USDC contract and the official ERC-8004 registries.
- [OBSERVED] None of it is merged, deployed or running on a live network. The catalog still holds two skeleton releases at price 0 with no benchmark evidence, and the chain cost in `packages/catalog/economics.json` is still the placeholder 0. No saving has been measured. No buyer has paid.
- [OBSERVED] The pipeline defaults to operator review of every failed adoption (`EVALUATOR_FAILURES=review`). That default is an economic decision, and section 4 prices it.

**The consequence.** [INFERENCE] The engineering risk is largely retired. What remains is entirely economic: does anyone pay enough to fund evidence?

## 3. Six places where the economics break

### 3.1 The price is indexed to the wrong value strand

[REPO] The only price basis is the measured model-cost saving `S`, capped at 30%. [RESEARCH] Token prices for a given capability fall by a median of about 50 times a year, while tokens per task rise; per-task costs of coding agents span 0.07 to 13.04 depending on the agent and model. [INFERENCE] `S` is the difference of two moving numbers that Lemma does not control, and the cap makes Lemma's revenue a residual of them. The value strands developers actually feel, fewer wrong attempts to review, reliability on payment code, agent minutes, are unpriced by design. A business whose price is a fraction of a declining input cannot fund a fixed-cost evidence factory.

### 3.2 Evidence is a perishable fixed cost

[ASSUMED] Three assumption sets for the cost of evidence per release-profile-class. Model spend uses the protocol's 20 runs at the research range of per-task costs; labor is the time to write fixtures, the recipe and the bundle, and to review the runs, at a loaded 100 an hour. Refreshes follow model and SDK changes. Nobody has measured any of these; the harness records billed model cost but not hours.

| Assumption set | Model cost per task | Model spend, 20 runs | Labor, new release | `K_new` | Labor, refresh | `K_refresh` | Refreshes a year | Evidence cost a year |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Low | 0.50 | 10 | 8 h | **810** | 2 h | 210 | 2 | **1,230** |
| Mid | 4.10 | 82 | 16 h | **1,682** | 4 h | 482 | 3 | **3,128** |
| High | 13.04 | 261 | 24 h | **2,661** | 6 h | 861 | 4 | **6,104** |

[MODELED] What that means for the agent-paid unit, at a contribution of 0.295 per sale:

| Evidence cost | Value | Sales to pay it back at 0.295 contribution | Sales a day if the evidence lasts 90 days |
| --- | --- | --- | --- |
| Docs' worked example (compute only, cheap model) | 30 | 102 | 1.1 |
| Low: new release | 810 | 2,746 | 30.5 |
| Mid: new release | 1,682 | 5,702 | 63.4 |
| Mid: one refresh | 482 | 1,634 | 18.2 |
| High: new release | 2,661 | 9,020 | 100.2 |

[INFERENCE] Labor, not compute, dominates evidence cost. Evidence has the cost shape of a subscription: a fixed amount per release, per year, whether or not anyone buys. It needs revenue of the same shape.

### 3.3 The volume the unit needs versus the market that exists

[MODELED] Evidence cost per adoption, mid case, against the price:

| Adoptions a year in one profile class | Evidence cost per adoption (mid, 3,128 a year) | Against the 0.39 price |
| --- | --- | --- |
| 100 | 31.28 | 80.2 times the price |
| 500 | 6.26 | 16.0 times the price |
| 2,000 | 1.56 | 4.0 times the price |
| 10,000 | 0.31 | 80% of the price |
| 20,000 | 0.16 | 40% of the price |

[RESEARCH] An independent sample of x402 payments on Base (August 23 to September 25, 2026) found a median payment of 0.003, about 73,000 payments and 125,000 a day across all sellers, and about 6% of buyers persisting. x402 activity on Arbitrum is small next to Base, and the public x402 explorer does not index Arbitrum. [INFERENCE] The agent-paid unit needs about 10,000 adoptions a year in one profile class before evidence cost per adoption falls below the price. No niche integration will see that soon. The unit cannot fund its own evidence.

### 3.4 The friction tax on the buyer

[REPO] To pay cents, a buyer must fund a USDC wallet on Arbitrum, run `lemma-signer` as a separate process (the bridge README asks for another user or a hardware or remote signer, because acceptance tests run as the user), and set spending caps. [MODELED] The buyer keeps `S - P - g` = 0.88 in tokens per purchase:

| Setup time | Developer cost an hour | Setup cost | Purchases to pay it back from token savings (0.88 each) |
| --- | --- | --- | --- |
| 30 min | 60 | 30 | 35 |
| 60 min | 100 | 100 | 114 |
| 120 min | 150 | 300 | 341 |

[RESEARCH] Budgets for agent work sit with organizations and are billed by consumption (Copilot, Claude, Cursor), so an agent wallet is a new budget line an administrator must approve and fund. [INFERENCE] Only repeated, unattended use pays the setup back, and repetition is exactly what agent payments have not shown. This is the least validated assumption in the whole model.

### 3.5 The warranty: cheap capital, expensive operations, unproven demand

[MODELED] The capital behind the bond is nearly free. The operations are not:

| Cost line | Per failure | Per resolution at q = 10% | Against the 0.39 price |
| --- | --- | --- | --- |
| Bond capital, 72-hour window, 10% a year | – | 0.00032 | 0.08% |
| Operator review of a failure, 2 min at 100 an hour | 3.33 | 0.33 | 85% of the price |
| Operator review of a failure, 5 min at 100 an hour | 8.33 | 0.83 | 214% of the price |
| Operator review of a failure, 10 min at 100 an hour | 16.67 | 1.67 | 427% of the price |
| Refund itself, q × P | 0.39 | 0.039 | 10% |

[INFERENCE] Three conclusions. Operator review of failures cannot be part of the per-unit path at cents per sale; the public catalog needs automated verdicts. A refund of the price is not what a buyer values, since the cost of a failed rollout is the cost of the rollout, not 0.39. And no surveyed vendor refunds a failed adoption, so the bonded refund is new and its effect on demand is unknown. The warranty's value is highest where it takes the form organizations already pay for: a maintained promise with a fix time (Docker, Chainguard, Ubuntu Pro).

### 3.6 The cost of trustlessness

[PLANNED] Five on-chain or chain-facing components exist: the facilitator, the warranty registry, the Stylus confidence engine, the ERC-8004 attester, and the indexer with its jobs. Each needs keys, an RPC plan, monitoring, and, before mainnet, an audit. [ASSUMED] A contract audit costs 25,000 to 60,000, and a legal opinion on selling to anonymous wallets and pricing warranties 5,000 to 15,000. [INFERENCE] Their economic function is to let a third party trust Lemma without trusting the company: an outside provider posting bond, a buyer claiming a refund without a support ticket, an underwriter staking behind a release. While Lemma is the only provider and evaluator, the stack is a proof and a distribution asset, valuable for the Arbitrum ecosystem and for buyers who want to check, but it earns nothing on its own. Its cost must be capped until a paying customer needs mainnet.

## 4. Evidence economics: the real unit of cost

[INFERENCE] Evidence is both Lemma's cost of goods and its moat. The business is profitable to the extent that evidence is cheap to make, paid for before it is made, and reused across many adoptions.

### What each reuse lever is worth

[MODELED] Savings per release-profile-class a year, mid case:

| Lever | Effect on the mid assumptions | Saving a year per release-profile-class | Share of the 3,128 annual evidence cost | Why it matters |
| --- | --- | --- | --- | --- |
| Vendor supplies fixtures and acceptance tests; Lemma measures | New-release labor 16 h to 8 h | 800 | 26% | Labor dominates K. The sponsor knows its SDK; Lemma keeps the measurement. |
| Outcomes extend freshness: re-run the paired benchmark only when model prices move | Refreshes 3 to 1.5 a year | 723 | 23% | Verified receipts keep the pass-rate claim fresh; the savings claim is re-measured less often. |
| Profile classes: one benchmark covers a documented class | No cost cut; more adoptions per evidence | 0 | 0% | Raises adoptions per dollar of evidence instead of cutting the dollar. |
| Shared control arm across releases for one task | Half the control runs on the second release | 21 | 1% | Compute is a small share of K, so this saves little money but some days. |
| Sequential design: stop once the interval clears the threshold | About 30% fewer runs | 25 | 1% | Same reason: small in money, useful in time. |

With the first two levers, the mid annual evidence cost falls from 3,128 to about 1,605 a year per release-profile-class; with all four cost levers, to about 1,560.

[INFERENCE] The two levers that matter are about labor and about who pays. The vendor knows its own SDK and already writes sample code; asking it to supply fixtures and an acceptance test, while Lemma keeps the measurement, halves the labor and keeps the evidence independent. Using verified outcomes to keep the pass-rate claim fresh, and re-running the paired benchmark only when model prices move, halves the refresh burden. The compute levers save days, not dollars.

### Reuse across customers

| Evidence funded by | Who reuses it | Reuse | Effect |
| --- | --- | --- | --- |
| A vendor program (public release) | Every buyer whose profile fits, at no charge | High: the release is non-rival and content-addressed | The vendor pays once; adoptions raise the fit rate and the outcome data for free |
| A team plan (private release) | Only that team's repositories | Low | Must be priced per integration, since each integration carries its own evidence |
| An enterprise deployment | The enterprise's whole estate | Medium: one integration across many repositories | Justifies a higher price per integration |
| The agent-paid unit | The same public buyers | High in principle | But the unit pays 0.39 toward a cost of thousands |

**The rule this implies.** [INFERENCE] Never make evidence Lemma's speculative expense. Every release should have a payer before its benchmark runs: a vendor, a team, or a grant with a named capability. The demand ledger (previews that ended in `build` or `decline`, published in buckets of at least five repositories) tells Lemma which capabilities to sell evidence for, and the pitch to a vendor starts with that number.

### Measure the cost first

[OBSERVED] The benchmark harness records billed model cost per run. No run exists, and nobody has recorded the hours. [INFERENCE] The first experiment in section 12 measures `K` on the two existing releases. Until then, every figure in this section is an assumption with a wide range.

## 5. The option space, including different businesses

[INFERENCE] Every model considered, with its payer, what they buy, the alternative they compare it with, and a verdict. Prices are assumptions anchored on the comparables in the revenue report.

| Code | Model | Who pays | What they buy | Their alternative | Verdict |
| --- | --- | --- | --- | --- | --- |
| A | Agent-paid resolution | The agent's owner, in USDC | One evidenced patch, at most 30% of its saving | Let the agent rebuild it | Keep as the public rail and outcome source; not the business |
| B | Marketplace fee on external providers | Providers | Distribution and a warranty rail | Their own docs and a marketplace | Reject for now: the fee is below the cost to serve |
| C | Vendor program: agent-ready certification and upkeep | The integration vendor | A maintained, evidenced release for its SDK, a badge, breakage alerts, adoption reports | Developer relations, sample repositories, an MCP server | **Build first** |
| D | Evidence as a service | A provider or vendor | One frozen benchmark and fixture set per release version | Nothing comparable; a security review fee | Only bundled into C, or with vendor-supplied tests and a deposit |
| E | Private catalog for a team | An engineering team | Its own integrations packaged, benchmarked and served to its agents | Internal templates, a developer portal | **Build second**, priced per maintained integration |
| F | Enterprise deployment with an audit trail | An enterprise | The server, catalog and evaluator inside its boundary; receipts as an audit trail | Manual review, policy tools | Later, after a team pilot converts |
| G | Agent-platform partnership | An agent vendor | Verified reuse shipped natively, without a wallet | Building it in-house | Test in conversations now |
| H | Compatibility oracle API for platforms | A platform, metered | Fit decisions and confidence at volume, billed in bulk | Its own vetting | Later; it must not charge end developers |
| I | Insurance-priced warranty and underwriting pools | Buyers and underwriters | Cover for failed adoptions, priced from outcome data | Nothing | Much later; needs hundreds of outcomes per profile and legal advice |
| J | Open verification tool funded by grants | Ecosystems | A public good | n/a | The fallback if nobody pays for evidence |

### Three businesses that are not the current one

**Agent-ready certification for SDK vendors (C).** [INFERENCE] The customer is the company whose product agents integrate. It already spends on developer relations so that developers, and now agents, integrate its product correctly. Lemma sells it something that budget cannot buy: measured, tested adoption by agents, per repository profile, kept fresh as models and SDKs change, with a public track record and a refund when it fails. [RESEARCH] The comparables are paid by the publisher: Docker's Verified Publisher program, Docker's 5,000-per-repository maintained tier, Salesforce's 999 review fee. This is a different business from the current one in every respect that matters: customer, unit, price, sales motion and cost structure. The mechanism (fit decision, evidence, warranty, outcomes) is the same.

**An outcome-grounded evaluation network for agent artifacts.** [INFERENCE] Lemma's machinery (fixtures, pinned acceptance recipes, paired benchmarks, bonded outcomes) is not specific to integration patches. It could evaluate skills, MCP servers and plugins for registries. [RESEARCH] The market wants this: Arcade graded 0.5% of 43,400 MCP servers "A", an audit found 341 malicious skills on one registry, and Anthropic tiers connectors as community or verified. But the platforms are taking vetting in-house, and Tessl runs a free registry with published task evaluations after raising 125 million. [INFERENCE] Plausible as an extension once the attester has standing, and a real risk as a competitor's move. Not a first business.

**Integration reliability insurance (I).** [INFERENCE] The data gate is strict: with only the benchmark prior, the conservative failure rate is 47%, and it falls to about 7% only after some 500 outcomes per profile. Pools look like insurance and need legal review. Too early.

**A plain SaaS without the chain.** [INFERENCE] For vendors and teams, money moves by invoice and nothing in the sale needs a chain. The chain earns its place as public proof (anyone can check an outcome), as the rail for the anonymous purchase, and as the basis for models B, G, H and I later. The recommendation is not to remove it, but to stop letting it set the cost base.

## 6. Unit economics and break-even

### Contribution per unit

[MODELED] Prices are assumptions; variable costs use the mid evidence set; contribution is before fixed costs.

| Code | Model | Unit | Revenue per unit | Variable cost per unit | Contribution | Margin | Units a month to cover 10,000 of fixed cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | Agent-paid resolution (today's design) | one resolution | 0.390 | 0.095 | 0.295 | 76% | 33,899 |
| B | Marketplace fee of 10% on a 0.39 sale | one resolution | 0.039 | 0.055 | −0.016 | negative | never |
| C | Vendor program: agent-ready certification and upkeep | one product a year | 12,000 | 4,356 | 7,645 | 64% | 16 customers |
| D | Evidence fee, one frozen benchmark | one release version | 2,500 | 1,932 | 568 | 23% | 18 |
| E1 | Team plan priced per repository (30 a month, 20 repositories, 2 private integrations) | one team a year | 7,200 | 6,976 | 224 | 3% | 536 customers |
| E2 | Team plan priced per maintained integration (500 a month each, 2 integrations, platform fee 200) | one team a year | 14,400 | 7,696 | 6,704 | 47% | 18 customers |
| F | Enterprise deployment with audit trail | one contract a year | 40,000 | 17,384 | 22,616 | 57% | 6 customers |
| G | Agent-platform partnership (white label) | one platform a year | 36,000 | 5,400 | 30,600 | 85% | 4 customers |

[INFERENCE] Four readings:

1. **Per-repository team pricing is a trap.** At 30 a repository, a 20-repository team with two private integrations leaves 3%, because each private integration carries its own evidence. Price teams per maintained integration (E2), and the same customer leaves 47%.
2. **One-off evidence fees are labor-bound.** At 2,500 a job and 16 hours of labor, covering 10,000 of fixed cost takes 18 jobs and 288 hours a month. Sell evidence inside a program, or only with vendor-supplied tests and a deposit.
3. **Platform and enterprise deals have the best contribution per sale** and the longest cycles and the highest concentration risk.
4. **The marketplace fee is negative** until a fee floor exists, and a floor above 0.055 on a 0.39 sale is 14% of the price before Lemma earns anything.

### Fixed cost bases

[ASSUMED] Three ways to run the company. People are loaded costs; the lean base pays one founder living costs only.

| Cost base | People | Infrastructure | Chain operations (RPC, keys, monitoring) | Tools | Legal, audit and insurance (amortized) | Total a month |
| --- | --- | --- | --- | --- | --- | --- |
| Lean: one founder, no salary beyond living costs | 8,000 | 300 | 100 | 100 | 500 | **9,000** |
| Small team: 2.5 FTE | 30,000 | 600 | 200 | 300 | 1,700 | **32,800** |
| Funded: 5 FTE | 60,000 | 1,500 | 500 | 1,000 | 4,000 | **67,000** |

### Customers needed to break even

[MODELED] Recurring models by contribution a month per customer; the agent-paid unit by resolutions a month.

| Model | Contribution a month per customer | Customers for lean (9,000 a month) | Customers for small team (32,800 a month) | Customers for funded (67,000 a month) |
| --- | --- | --- | --- | --- |
| C: Vendor program | 637 | 15 | 52 | 106 |
| E1: Team plan priced per repository | 19 | 483 | 1,758 | 3,590 |
| E2: Team plan priced per maintained integration | 559 | 17 | 59 | 120 |
| F: Enterprise deployment with audit trail | 1,885 | 5 | 18 | 36 |
| G: Agent-platform partnership | 2,550 | 4 | 13 | 27 |
| A: agent-paid resolutions (units a month) | 0.295 | 30,509 | 111,187 | 227,119 |

### Sensitivity: vendor programs and price

[MODELED] Contribution a month from vendor programs alone, each covering one profile class, against the lean base (9,000) and the small team (32,800).

| Vendor programs | At 6,000 a year each: contribution a month | At 12,000 a year each: contribution a month | At 24,000 a year each: contribution a month |
| --- | --- | --- | --- |
| 2 | 374 (covers neither) | 1,274 (covers neither) | 3,074 (covers neither) |
| 4 | 748 (covers neither) | 2,548 (covers neither) | 6,148 (covers neither) |
| 8 | 1,496 (covers neither) | 5,096 (covers neither) | 12,296 (covers the lean base) |
| 12 | 2,245 (covers neither) | 7,645 (covers neither) | 18,445 (covers the lean base) |
| 20 | 3,741 (covers neither) | 12,741 (covers the lean base) | 30,741 (covers the lean base) |

[MODELED] And against the evidence assumption sets, for a 12,000 program:

| Evidence assumption set | Evidence cost a year | Contribution of a 12,000 program | Margin | Programs to cover the lean base |
| --- | --- | --- | --- | --- |
| Low | 1,230 | 9,543 | 80% | 12 |
| Mid | 3,128 | 7,645 | 64% | 15 |
| High | 6,104 | 4,669 | 39% | 24 |

[INFERENCE] Two conclusions. The vendor model clears the lean base at eight programs priced at 24,000, or about twenty at 12,000; a 2.5-person team needs roughly fifty programs at 12,000, which is a sales organization, not a founder. And evidence cost swings the vendor margin from 80% to 39% across the assumption sets, so measuring `K` decides how many customers the business needs.

## 7. Scenarios: downside, base and upside

[ASSUMED] Twelve months from October 2026. Every count, price and start month is an assumption; section 14 lists them as unvalidated. Costs include the public catalog's own evidence (two releases, first benchmarks in month 1, refreshes each quarter), evidence for each program and private integration, and support at 10% of subscription revenue (20% for the enterprise contract, 15% for the platform deal).

| Scenario | Vendor programs | Teams | Enterprise | Platform deal | One-off evidence fees | Grants | Agent-paid resolutions, month 12 | Story |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Downside | one paid pilot at 1,500 | 1 at 300 a month | none | none | none | 20,000 | 20 | No vendor signs beyond one paid pilot; one team pays for six months; grants are the main income; the agent-paid rail sees a trickle. |
| Base | 3 at 12,000 a year, from month 4 | 4 at 600 a month | none | none | 2 at 2,000 | 40,000 | 300 | Three vendor programs and four team customers close over the year; two one-off evidence jobs; grants; a few hundred agent-paid resolutions a month by year end. |
| Upside | 8 at 15,000 a year, from month 3 | 10 at 900 a month | 1 at 40,000 a year from month 9 | 1 at 3,000 a month from month 7 | 4 at 2,500 | 60,000 | 995 | Eight vendor programs at a higher price, ten teams, one enterprise contract, one agent-platform deal from month 7, larger grants, and a thousand agent-paid resolutions a month by year end. |

[MODELED] Twelve-month totals:

| Scenario | Revenue, 12 months | Recurring | One-off: grants, pilots, evidence fees | Agent-paid | Variable cost | Contribution | Recurring run-rate at month 12 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Downside | 23,370 | 1,800 | 21,500 | 70 | 10,299 | 13,071 | 0 |
| Base | 79,514 | 34,800 | 44,000 | 714 | 29,868 | 49,646 | 64,800 |
| Upside | 209,771 | 137,733 | 70,000 | 2,038 | 76,377 | 133,394 | 304,000 |

[MODELED] Against the fixed cost bases. "Cash needed" is the deepest cumulative deficit before month 12. "First month" is the first month in which recurring contribution alone, without grants or one-off fees, covers the base.

| Scenario | Net against lean (108,000 a year) | Cash needed on lean | First month recurring contribution covers lean | Net against small team (393,600 a year) | Cash needed on small team | First month it covers the small team | Net against funded (804,000 a year) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Downside | −94,929 | 94,929 | not within 12 months | −380,529 | 380,529 | not within 12 months | −790,929 |
| Base | −58,354 | 58,354 | not within 12 months | −343,954 | 343,954 | not within 12 months | −754,354 |
| Upside | 25,394 | 22,593 | month 8 | −260,206 | 260,206 | not within 12 months | −670,606 |

[MODELED] The base scenario month by month:

| Month | Vendors | Teams | Evidence fees | Grants | Agent-paid | Revenue | Evidence cost | Support | Contribution | Net, lean base | Net, small team |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 3,364 | 0 | −3,364 | −12,364 | −36,164 |
| 2 | 0 | 0 | 0 | 25,000 | 0 | 25,000 | 0 | 0 | 25,000 | 16,000 | −7,800 |
| 3 | 0 | 0 | 0 | 0 | 20 | 20 | 0 | 0 | 15 | −8,985 | −32,785 |
| 4 | 1,000 | 0 | 0 | 0 | 31 | 1,031 | 2,646 | 100 | −1,722 | −10,722 | −34,522 |
| 5 | 1,000 | 600 | 2,000 | 0 | 43 | 3,643 | 3,364 | 160 | 108 | −8,892 | −32,692 |
| 6 | 2,000 | 1,200 | 0 | 0 | 55 | 3,255 | 3,364 | 320 | −443 | −9,443 | −33,243 |
| 7 | 2,000 | 1,200 | 0 | 0 | 66 | 3,266 | 1,446 | 320 | 1,484 | −7,516 | −31,316 |
| 8 | 3,000 | 1,800 | 0 | 15,000 | 78 | 19,878 | 3,846 | 480 | 15,533 | 6,533 | −17,267 |
| 9 | 3,000 | 1,800 | 2,000 | 0 | 90 | 6,890 | 2,646 | 480 | 3,742 | −5,258 | −29,058 |
| 10 | 3,000 | 2,400 | 0 | 0 | 101 | 5,501 | 3,128 | 540 | 1,809 | −7,191 | −30,991 |
| 11 | 3,000 | 2,400 | 0 | 0 | 113 | 5,513 | 1,446 | 540 | 3,500 | −5,500 | −29,300 |
| 12 | 3,000 | 2,400 | 0 | 0 | 117 | 5,517 | 964 | 540 | 3,985 | −5,016 | −28,816 |

[INFERENCE] What the scenarios say:

- **Year one is grant-supported in every case.** Grants are the largest revenue line in the downside and base cases. They fund evidence and time; they are not the business.
- **The base case is a lean business, not yet a company.** A 64,800 run-rate at month 12 and a 58,354 cash need on the lean base. Hiring to a 2.5-person team on the base case burns 343,954 in a year.
- **The upside case is a real business on a lean base**, covering it from month 8 and ending with a 304,000 run-rate. It needs eight vendor programs at 15,000, ten teams, one enterprise contract and one platform deal in twelve months, which is a strong year for a two-person sales effort.
- **The agent-paid rail is invisible in every scenario**: 70 to about 2,000 of revenue in a year. Its worth is the outcome data it produces, which every other line needs.
- **The decision the scenarios force:** stay lean until at least eight vendor programs or one platform or enterprise contract are signed. Raise money only against signed contracts, not against the mechanism.

## 8. The recommended model

[INFERENCE] **Lemma as a verified publisher of agent-ready integrations, with subscription-shaped evidence.** Organizations pay by the year for integrations that are evidenced, maintained and public; agents get the fit decision free and the patch for cents; the chain proves it.

### The stack

| Layer | Who pays | What Lemma does | Status |
| --- | --- | --- | --- |
| Vendor programs (C) | Integration vendors, by invoice, per product per year | Builds, benchmarks and maintains a labeled public release for the vendor's SDK; publishes its confidence and pass rate; sends breakage alerts and adoption reports; revokes the badge when confidence falls | First revenue |
| Private catalogs (E) | Engineering teams, per maintained integration | Packages and benchmarks the team's own integrations; serves them through the same bridge; keeps outcomes private | Second revenue |
| Platform partnerships (G) | Agent vendors, per year | Ships verified reuse inside their product, without a wallet | Test now, close later |
| The public rail (A) | Agents' owners, cents in USDC | The capped, evidence-gated purchase, on chain; the source of grounded outcomes | Keep; budget as marketing and data |
| Enterprise, oracle API, insurance (F, H, I) | Later payers | | After the first two layers earn |

### What changes in the product

| Area | Change | Why |
| --- | --- | --- |
| Catalog | A `sponsor` field on releases, shown in the catalog and the preview; sponsorship never affects ranking | Independence is the product; disclosure keeps it |
| Evidence | Record hours next to billed model cost per benchmark; accept vendor-supplied fixtures and acceptance tests; extend `staleAfter` from verified outcomes and re-run the paired benchmark on model price changes | Halves labor and refresh cost |
| Warranty | Automated verdicts by default for the public catalog (`EVALUATOR_FAILURES=auto` with rules); keep operator review for programs whose customers pay for it | Review cost leaves the per-unit path |
| Vendor dashboard | Per-sponsor views: adoptions per profile class, pass rate, confidence, breakage alerts | This is what the vendor buys; the demand ledger and catalog already hold most of it |
| Billing | Invoices and plans for vendors and teams; x402 stays for the anonymous purchase | Budgets sit with organizations |
| Private catalogs | Per-tenant releases and outcomes that never reach the public engine | The team model |
| Chain | Stay on testnet with the public track record until a paying customer needs mainnet; no audit spend before that | Cost cap |
| Marketplace | Closed | The fee is below the cost to serve |

### What stays

[REPO] The privacy rules (typed profiles, no source, buckets of five), deterministic matching, no paid ranking, evidence measured by Lemma and never by the provider, the 30% cap on anonymous purchases, and the public, free confidence and reputation numbers. These are what make the certification credible.

### Why the economics improve

- **Contribution per sale** goes from 0.295 to 7,645 (a 12,000 program) or 6,704 (a two-integration team).
- **Working capital turns positive.** The sponsor pays before the benchmark runs. Today Lemma pays and hopes.
- **Evidence reuse works for Lemma instead of against it.** A vendor-funded public release serves every fitting buyer free, which raises the fit rate and the outcome count, which raises the confidence the vendor is paying to display. That loop has an economic link at every step. The current loop asks buyers paying cents to fund evidence costing thousands.
- **Revenue matches the cost shape.** Both are per release, per year.
- **Fixed cost falls** by capping the chain stack until it earns its keep.

## 9. Who pays for what: the pricing architecture

[ASSUMED] Prices to test, not to set. Each is anchored on an alternative the payer already funds.

| Payer | Offer | Price to test | What it includes | Alternative they compare with | Cost to serve a year (mid evidence) | Margin |
| --- | --- | --- | --- | --- | --- | --- |
| Integration vendor | Verified | 6,000 a year | One evidenced public release for one profile class, a badge, two refreshes a year | A developer-relations sample repository | 3,260 | 46% |
| Integration vendor | Maintained | 12,000 a year | One profile class refreshed on SDK and model changes, breakage alerts, an adoption report | Docker's 5,000-per-repository maintained tier | 4,356 | 64% |
| Integration vendor | Premium | 24,000 a year | Two profile classes, priority re-benchmarks, a named contact, the attester's ERC-8004 record | A share of one developer-relations salary | 8,711 | 64% |
| Engineering team | Private catalog | 200 a month, plus 500 a month per maintained integration | Packaging, benchmark, serving, private outcomes; two integrations assumed | A platform seat (Roadie 24, Port 30 to 40 a seat) | 7,696 | 47% |
| Enterprise | Deployment | 40,000 a year and up | The server and evaluator inside the boundary, an audit trail, three integrations | Cortex's median contract of about 75,000; a Backstage plugin bundle at 100,000 | 17,384 | 57% |
| Agent platform | Partnership | 3,000 a month and up | Verified reuse shipped natively; the public catalog's evidence | Building it in-house | 5,400 | 85% |
| Agent's owner | The public rail | At most 30% of the measured saving | One evidenced patch with a warranty | Rebuilding it | 0.095 | 76% |

| What the vendor pays for today | Price point | Source |
| --- | --- | --- |
| Docker Hardened Images, Select tier: compliance builds with a fix-time promise | 5,000 per repository a year | earlier report, [RESEARCH] |
| Docker Verified Publisher: badge, ranking, reports | annual plans by consuming domains (price not published) | earlier report, [RESEARCH] |
| Salesforce AppExchange security review | 999 per attempt | earlier report, [RESEARCH] |
| Composio: 200,000 tool calls a month | 29 a month | earlier report, [RESEARCH] |
| One developer-relations engineer | about 150,000 a year loaded | [ASSUMED] |
| A Lemma vendor program at 12,000 a year | 8% of one developer-relations salary | [MODELED] |

**The price ladder to test.** [INFERENCE] Offer each vendor all three tiers and ask which one they would buy this quarter and why. The tier they choose, and the objections to the one above it, are the willingness-to-pay measurement. A deposit is the only answer that counts.

**How each cost is covered.**

| Cost | Covered by |
| --- | --- |
| Evidence creation (`K_new`) | The sponsor's first invoice, before the benchmark runs; vendor-supplied fixtures halve it |
| Evidence maintenance (refreshes) | The subscription's renewal; outcomes extend freshness |
| Operating costs (people, infrastructure, chain operations) | Recurring contribution from programs, teams and platforms; grants during year one |
| Chain costs per resolution | Negligible per transaction on Arbitrum; covered by the 10% support allowance in each program |
| Audits and legal | Deferred until a customer needs mainnet; then funded from that contract or a grant |

## 10. Risks

[INFERENCE] Specific to this model, with what would show each one.

| Risk | Why it is real | Early signal | Response |
| --- | --- | --- | --- |
| Vendors treat certification as marketing and do not renew | Badges without measured lift are a line item to cut | Renewal intent at month 9 of the first program | Tie the program to breakage alerts and adoption reports the vendor's team uses weekly |
| Sponsored evidence looks bought | A sponsor pays for the benchmark of its own release | Buyers or judges question the number | Lemma measures; the sponsor never grades; sponsorship is labeled; the badge is revoked by data |
| Agent platforms build verified reuse natively | Anthropic tiers connectors; Arcade grades servers; Tessl publishes uplift for free | A platform announces evidence per profile | Neutrality across agents, and evidence grounded in paid, bonded outcomes, which a directory cannot produce |
| Evidence stays expensive | Labor dominates; fixtures are hand-written | Measured `K` above 3,000 a year per class | Vendor-supplied tests; templates and generated near-miss fixtures; refresh from outcomes |
| The fit rate is too low | Two releases, exact version ranges, one language | Fit rate under 10% in the demand ledger | Broaden profile classes before adding releases |
| Concentration | Eight vendors or one platform is a small book | Any one customer above 30% of revenue | Sell teams alongside vendors |
| The chain stack absorbs the year | Five components, audits, mainnet, a buildathon deadline | Engineering weeks spent on chain work without a customer asking | Cap it: testnet plus the public record until a contract needs mainnet |
| Tax, sanctions and insurance | Selling software to anonymous wallets; pricing warranties | Any mainnet revenue | Bill vendors and teams in fiat; keep the rail on testnet until advised |
| The saving is too small to price | `S` under 0.30 on a frontier model | The first frozen benchmark | Keep the preview free; sell evidence and upkeep, not the patch |

## 11. Experiments to validate willingness to pay and profitability

[INFERENCE] Each experiment is cheap, ends with a number, and has a decision rule that would change what Lemma builds. The costs are cash only; founder time is extra. Run X1 to X5 in the first 30 days and X6 and X7 in the next 30.

| # | Question | Experiment | Cost | Metric | Decision rule |
| --- | --- | --- | --- | --- | --- |
| X1 | What does evidence really cost? | Run the economic probe and then the frozen benchmark on the two existing releases, on a frontier model. Record billed model cost and every hour of labor | 300 to 600 in model spend | `K_new`, hours, and `S` and `C` per release | `S` under 0.30: the agent-paid unit stays free. `K_new` over 3,000: vendor programs start at 12,000, not 6,000 |
| X2 | Will vendors pay, and how much? | Pitch ten vendors whose SDKs agents integrate (payments, auth, MCP tooling, x402 and Arbitrum ecosystem first) with the three-tier ladder and the demand-ledger number for their capability. Ask for a signed letter and a 25% deposit | 0 | Meetings that reach a price; deposits; the tier chosen | Two deposits at 6,000 or more within 30 days: build vendor programs. None by day 60: the vendor model is out |
| X3 | Will teams pay per integration? | Concierge offer to five engineering teams: package and benchmark one internal integration for 500 a month plus a 200 platform fee, with a 90-day term | 0 | Signed pilots at or above evidence cost | Two of five sign: build private catalogs. None: teams wait |
| X4 | Will anyone fund an agent wallet? | Ten developers install the bridge and signer with a funded testnet wallet and a real task; observe without help | 0 | Share who fund the wallet; time to first purchase; purchases per fitting preview | Under half fund it: the rail is a demo and an evidence source only |
| X5 | Will platforms pay or partner? | Three conversations with agent vendors or registries: would they ship or filter on Lemma's evidence, and at what price? | 0 | Written intent; a paid pilot | One paid pilot: pursue G. None: keep neutrality as the story only |
| X6 | Does a priced page draw organizations? | A plans page with the three vendor tiers, the team plan and an enterprise contact form, with no purchase behind it | under 200 | Inquiries from company domains; tier clicked | Silence over 30 days with traffic: demand is individuals; delay plans |
| X7 | Can evidence labor be halved? | Time the fixture and recipe work for one new release with and without vendor-supplied tests and a fixture template | 0 | Hours per release | Under 8 hours with supplied tests: the reuse lever holds; price evidence fees accordingly |

**What not to spend on until these are done.** [INFERENCE] A mainnet audit; the open marketplace; insurance pricing and pools; buyer-agent reputation features; a third release without a payer.

**Vanity metrics to exclude.** [INFERENCE] Page views, stars, testnet transactions from the team's own wallets, and previews from the benchmark harness.

## 12. Next steps: the first 90 days

[INFERENCE] Day 1 is Monday, September 28, 2026.

**Days 1 to 30: measure, then sell.**
1. Run X1 and publish `S`, `C`, `K` and the hours on the Proof page with their dates.
2. Switch the public catalog's evaluator to automated verdicts; keep review as an opt-in for paying programs.
3. Add the `sponsor` field, the per-sponsor dashboard view and invoice billing. These are small changes to code that exists.
4. Run X2, X3 and X5 in parallel, two conversations each per week. At Founder House (October 23 to 25), ask vendors and platforms directly.
5. Keep the chain stack on testnet. Do not commission an audit.

**Days 31 to 60: close the first payer.**
1. Take the first deposit to a signed program with a delivery date.
2. Run X6 and X7.
3. Decision at day 60: rank payers by deposits and accepted prices. If nobody pays evidence cost, Lemma stays an open, grant-funded verification tool, and the paid tracks stop.

**Days 61 to 90: deliver and price the second.**
1. Deliver the first program: release, evidence, badge, alerts, report. Close the loop from receipts to confidence so the second sale carries a public track record.
2. Publish the first observed unit economics: benchmark cost, hours, price, refund rate, each with its date.
3. Decision at day 90: commit the next quarter to the model that earned money after evidence cost; keep the others as experiments; set the cost base by signed recurring revenue, not by the plan.

## 13. Facts, assumptions and unvalidated numbers

| Number | Value | Label | Status |
| --- | --- | --- | --- |
| Sale rule and price ceiling formula | `min(floor(0.3 S), S - g - ceil(0.25 C))` | [REPO] | Implemented in `packages/core` |
| Control cost `C`, saving `S`, failure rate `q` | 2.50, 1.30, 0.10 | [ASSUMED] | The docs' illustrative example; never measured |
| Price `P` | 0.39 | [MODELED] | The ceiling of the example |
| Chain cost `g` | 0.03 | [ASSUMED] | Placeholder 0 in the repository; four on-chain actions per resolution |
| Facilitator, infrastructure, support per resolution | 0.001, 0.005, 0.020 | [ASSUMED] | From the revenue report |
| Benchmark matrix | 20 runs per release version | [REPO] | The protocol |
| Per-task agent cost | 0.07 to 13.04 | [RESEARCH] | Artificial Analysis and OrcaRouter, via the revenue report; some via search summaries |
| Labor per new release and per refresh | 8 to 24 hours; 2 to 6 hours | [ASSUMED] | Never recorded; X1 and X7 measure it |
| Loaded hourly rate | 100 | [ASSUMED] | |
| Refreshes a year | 2 to 4 | [ASSUMED] | Depends on model and SDK release cadence |
| Evidence cost a year per class | 1,230 to 6,104 | [MODELED] | From the assumptions above |
| Developer setup time and hourly cost | 30 to 120 minutes; 60 to 150 an hour | [ASSUMED] | X4 measures the time |
| Operator review per failure | 2 to 10 minutes | [ASSUMED] | The pipeline's default flow |
| x402 payment statistics | median 0.003; about 73,000 a day; 6% buyer persistence | [RESEARCH] | One independent sample, Base, one month |
| Vendor comparables | Docker 5,000 per repository a year; Salesforce 999 per review | [RESEARCH] | Read directly, via the revenue report |
| Platform-engineering comparables | Roadie 24 a developer; Port 30 to 40 a seat; Cortex about 75,000 a contract | [RESEARCH] | Search summaries, via the revenue report |
| Vendor program prices | 6,000 to 24,000 a year | [ASSUMED] | X2 tests them |
| Team plan prices | 500 a month per integration, 200 platform fee | [ASSUMED] | X3 tests them |
| Enterprise and platform prices | 40,000 a year; 3,000 a month | [ASSUMED] | Anchored, not tested |
| Support share of revenue | 10%, 15%, 20% | [ASSUMED] | |
| Cost bases | 9,000, 32,800, 67,000 a month | [ASSUMED] | |
| Audit and legal one-off costs | 25,000 to 60,000; 5,000 to 15,000 | [ASSUMED] | Market ranges, not quotes |
| Scenario counts and start months | see section 7 | [ASSUMED] | The base case is a judgment, not a forecast |
| Grants | 20,000 to 60,000 in year one | [ASSUMED] | Arbitrum's programs exist; awards are not |
| Agent-paid volumes | 20 to 1,000 a month | [ASSUMED] | Nothing observed |
| Everything built on the five branches | tests pass; a local-chain run passes | [PLANNED] | Not merged, not deployed, no mainnet |

[INFERENCE] The three numbers that decide the business are `K` (what evidence costs), the vendor's accepted price, and the fit rate. None has been observed. The experiments in section 11 observe all three within 60 days.

## 14. Sources

- Lemma repository: `docs/economics.md`, `docs/economic-gates.md`, `docs/benchmark-protocol.md`, `packages/catalog/economics.json`, the release manifests, `apps/bridge/README.md`, and the five feature branches `payments/x402-paid-path`, `contracts/warranty-registry`, `contracts/stylus-confidence`, `reputation/erc-8004` and `pipeline/outcome-pipeline` (September 27, 2026).
- Lemma revenue report, [`docs/business-model.md`](https://github.com/4waan/Lemma/blob/23f16e4ce32f1d05038a8b86608b3d9e1e53ef10/docs/business-model.md) and [`docs/business-model/unit-econ.mjs`](https://github.com/4waan/Lemma/blob/23f16e4ce32f1d05038a8b86608b3d9e1e53ef10/docs/business-model/unit-econ.mjs) (September 27, 2026, at commit `23f16e4` of pull request #37). Every external fact in this document is quoted from it and carries its label; see its section 18 for the 121 numbered sources, including which were read directly and which came from search summaries. The facts used here: coding-agent per-task costs and plan prices (its sources 17 to 20, 24, 29, 30); the x402 census (9); facilitator fees (56 to 59); marketplace take rates (64 to 78); Docker, Chainguard and Ubuntu Pro (10 to 14, 79 to 82); Salesforce review fees (26); platform-engineering prices (99 to 102); MCP registries and vetting (37 to 50); ERC-8004 forensics (107 to 111); Arbitrum grants and prizes (118 to 120).

## 15. Appendix: the model

**Formulas.** From `docs/economic-gates.md`:

```
maxPriceFor(S, C, g)        = min( floor(0.3 * S),  S - g - ceil(0.25 * C) )
unit contribution           = P - q * P - g - facilitator - infrastructure - support
break-even sales            = K / unit contribution
evidence cost a year        = K_new + refreshes * K_refresh
K_new                       = 20 * cost per task + hours_new * hourly
K_refresh                   = 20 * cost per task + hours_refresh * hourly
vendor contribution         = price - evidence a year - 0.10 * price - adoptions * (g + infrastructure + support)
team contribution           = fees - integrations * evidence a year - 0.10 * fees
scenario contribution       = revenue - evidence costs - support - agent-paid variable cost
net against a cost base     = contribution - 12 * monthly base
cash needed                 = the deepest cumulative deficit before month 12
```

**Inputs.** Section 13 lists every input with its label. The scenario schedules are in section 7.

**Rerun.** `node docs/profitability-analysis/model.mjs` prints every table in this report. The script has no dependencies.
