# Lemma revenue model and monetization strategy

Subtitle: Who can pay for verified reuse by coding agents, what the market evidence says, which models fit Lemma's rules, and what to test in the next 90 days.

## 1. Executive summary

**How to read this report.** Every statement carries a label. [REPO] is a fact read from the Lemma repository at commit `fe2d117`. [RESEARCH] is an external fact with a numbered source. [OBSERVED] is something counted directly. [ASSUMED] is an input chosen for a model. [ESTIMATED] is a rough figure. [MODELED] is the output of a stated model. [INFERENCE] is my reading. [PLANNED] is work described by the internal build plan and being built on branches that were not merged on September 27, 2026; it is not repository behavior. No Lemma amount in this report has ever settled on a chain. The paid path targets test USDC on Arbitrum Sepolia, so every Lemma amount today is a **testnet** amount. Modeled amounts assume mainnet USDC at 1 USDC = 1 USD, as the repository does [1].

**What Lemma sells.** [REPO] A Compatibility Resolution: one digest-pinned integration patch, matched to one repository profile, with a pinned acceptance recipe and a bonded warranty [2, 3]. The preview that decides `reuse | adapt | build | decline` is free. A sale needs frozen benchmark evidence and a price of at most 30% of the measured model-cost saving, which must also leave the buyer at least 25% cheaper after chain cost. In the documented worked example, the highest allowed price is 0.39 USDC [1].

**Where Lemma stands.** [OBSERVED] At commit `fe2d117`: two skeleton releases priced at 0, 27 compatibility fixtures, a placeholder chain cost of 0 and no benchmark runs [4, 5]. [REPO] The payment path is paused, and the warranty contract is a scaffold only [6, 7]. No revenue has been earned, no saving has been measured and no buyer has paid. [PLANNED] As of September 27, 2026, the paid path, the warranty registry, a compatibility confidence engine and on-chain reputation are being built on separate branches, not yet merged [8].

**The central finding.** [MODELED] The agent-paid unit is a good proof and a weak revenue engine. At 0.39 USDC per resolution, with Lemma as the only provider, 10,000 USD a month needs 25,642 paid resolutions a month. As a 10% marketplace fee, it needs 256,411 (section 10). [RESEARCH] The agent payment market is also thin. An independent sample of x402 payments on Base from August 23 to September 25, 2026 found a median payment of 0.003 USD, and only about 6% of buyers came back [9].

**Where money is made in adjacent markets.** [RESEARCH] The artifact is free and the maintained promise is paid for. Docker gives its hardened images away and charges 5,000 USD per repository per year for the tier with a fix-time promise [10, 11]. Chainguard sells a catalog kept under a CVE fix-time promise and reportedly grew annual recurring revenue sevenfold to 40 million USD [12, 13]. Publishers pay Docker for a verified badge and reports [14]. [INFERENCE] Among the vendors surveyed for this report, none was found to refund money when adopting a code artifact fails, so Lemma's bonded refund appears to be new.

**Recommendation.** [INFERENCE]

1. Keep the x402 purchase as Lemma's public, verifiable rail and its source of evidence. Do not plan the company around its margin.
2. Earn the first money from the payers who feel the integration problem at scale:
   - **integration vendors**, through sponsored and commissioned releases, verified-integration badges and breakage alerts;
   - **engineering teams**, through private catalogs on a seat or repository plan.
3. Build the **compatibility intelligence layer** as the moat. Lemma becomes the trusted attester whose paid, bonded and tested outcomes feed ERC-8004 reputation and the Stylus confidence engine. Give the public numbers away. Sell evidence and attestation for third-party releases, and later price warranties from the data, like insurance.
4. Keep the marketplace closed until evidence is cheap and outcomes are plentiful.

**Kill and pivot rules.** [INFERENCE] By day 30: if the measured saving `S` is below 0.30 USDC on a frontier model, or fewer than 10% of previews fit, stop investing in the agent-paid unit. By day 60: if no vendor or team will pay at least the cost of evidence, keep Lemma as an open verification tool funded by grants, and stop the paid tracks.

| Question | Short answer |
| --- | --- |
| Who pays first? | Integration vendors and engineering teams, not individual developers. |
| What is really sold? | A maintained, evidenced promise that an integration fits, not code. |
| What does the agent pay? | At most 30% of the measured saving: cents per resolution. A rail, not the business. |
| What is the moat? | Outcomes per release and profile that need a paid purchase, a pinned test and a bond. Hard to fake, slow to copy. |
| What is given away? | The fit decision, the public confidence number and the reputation feed. |
| What must be true? | `S` is large enough (experiment E1), the fit rate is high enough (E5), and some payer covers evidence cost (E3, E4). |

<!-- pagebreak -->

## 2. What Lemma is, economically

### The business model map

[REPO] This map is derived from the bridge, server, core and docs, not assumed. Each step names what moves and what Lemma learns [2, 1].

```
Developer          "Add x402 payment gating to my MCP server."
   |
   v
Coding agent       Reads the Lemma rule (.cursor/rules, .claude/rules or AGENTS.md)
   |               and calls lemma_preview with a typed capability id, never free text.
   v
Bridge (local)     Scans manifests and lockfiles only. Sends a typed profile: language,
   |               runtime, module system, package manager, frameworks, and versions of
   |               the dependencies the catalog matches on. Never source or paths.
   v
Resolver           Deterministic match against the digest-pinned catalog:
   |               reuse | adapt | build | decline, with reason codes. Only reuse and
   |               adapt can carry an offer, and only with fresh evidence and a price
   |               within maxPriceFor. build and decline are free, and are counted
   |               as unmet demand, published only in buckets of at least five
   |               repositories (k-anonymity with k = 5).
   v
Purchase           Bridge checks network, token, recipient, amount and daily cap, then
   |  (planned)    pays through x402 (USDC on Arbitrum; Arbitrum Sepolia test USDC
   |               today). The facilitator settles and pays gas. The warranty
   |               registry reserves provider bond. Recovery never pays twice: the
   |               resolution id is the idempotency key.
   v
Apply and verify   Patch applied all or nothing. The pinned acceptance recipe runs
   |               without a shell. Outcome passed | failed | abandoned, signed as an
   |               Adoption Receipt.
   v
Value              The agent reaches passing tests with fewer tokens and attempts.
                   A failed adoption in the claim window is refunded from the bond.
                   Lemma learns compatibility history per (release, profile).
```

### The objects that money and evidence attach to

| Object | What it is | Economic role |
| --- | --- | --- |
| Capability Release | A versioned integration: supported profiles, fixtures, acceptance recipe, provenance, license, price, warranty terms, expiry | The unit of supply |
| Compatibility Resolution | One release matched to one repository profile, delivered as a digest-checked patch | The unit of sale |
| Adoption Receipt | The buyer-signed outcome of the acceptance run | The unit of outcome evidence; feeds the warranty and compatibility history |
| Benchmark evidence | Frozen control and treatment runs per profile, with a stale date | The license to sell: no evidence, no price |
| Provider bond | USDC reserved per active warranty | Turns the warranty into money at stake |

[REPO] In the MVP, Lemma is the only provider, the evaluator is a team-operated key, and the server is first-party [15].

### What exists and what is planned

| Part | Status at `fe2d117` |
| --- | --- |
| Shared schemas, pricing rule, spending policy | [REPO] Built in `packages/core` |
| Catalog: two skeleton releases (payment gating for an MCP server; an x402-paying MCP client), 27 fixtures, placeholder payloads, price 0 | [OBSERVED] Built, not sellable [4] |
| Deterministic resolver and free preview over MCP and HTTP | [REPO] Built |
| Bridge: scan, preview, apply, verify, receipts | [REPO] Built; the purchase tool is paused |
| Server: Postgres or memory store, demand counting, read API, dashboard | [REPO] Built |
| Benchmark harness: run records and evidence derivation | [REPO] Built; no runs yet |
| x402 settlement with a self-hosted facilitator | [REPO] Paused [6]. [PLANNED] Being built on a separate branch [8] |
| Warranty registry contract | [REPO] Scaffold only [7]. [PLANNED] Being built on a separate branch [8] |
| Compatibility confidence engine (Stylus) and ERC-8004 reputation | [PLANNED] Not in the repository. Being built on separate branches [8] |
| Chain cost and price floor | [OBSERVED] Placeholder: chain cost "0", status "placeholder" [5] |
| Third release: an Arbitrum x402 facilitator for a Node service | [REPO] Not started; one no-release fixture |

[PLANNED] rows describe work on branches that were not merged on September 27, 2026. Check the repository for their current state.

**The consequence for this report:** no revenue has been earned, no saving has been measured, and no buyer has paid. Every number about buyers is assumed, estimated or modeled, and is labeled so.

### What Lemma knows at each point

| Moment | Lemma has | Lemma deliberately does not have |
| --- | --- | --- |
| Preview | Capability id, profile class, the decision and reason codes | Source code, file paths, other dependency names, the developer's identity |
| Offer | Price, network, token, recipient, expiry, evidence digest | Which model the buyer runs |
| Purchase | Buyer wallet address, resolution id, settlement | Anything about the workspace |
| Apply and verify | Outcome (passed, failed, abandoned), signed by the buyer | Test output (only a digest), the diff as applied |
| Demand | Daily buckets of asks, published only with at least five distinct repositories | Per-repository history |

[REPO] The demand threshold is `DEMAND_MIN_PROFILES = 5` [16]. The docs call demand a roadmap input, and use it to rank what to build or benchmark next [1].

## 3. Value created versus value captured

### The claim, in Lemma's own terms

[REPO] A release may be sold only when a frozen benchmark shows that an agent with Lemma reaches passing acceptance tests at a lower all-in cost than the same agent alone. The price is bounded by [1]:

```
maxPriceFor(S, C, g) = min( floor(0.30 * S),  S - g - ceil(0.25 * C) )
```

`C` is the control arm's median model cost to reach green. `S` is the conservative (lower-quartile) model-cost saving. `g` is the chain cost of a resolution. The price may never exceed 30% of the measured saving, and the buyer must end at least 25% cheaper all-in. In the documented worked example (`C = 2.50`, `S = 1.30`, `g = 0.01`, all illustrative), the ceiling is 0.39 USDC, and the buyer's all-in cost falls from 2.50 to 1.60 USDC, 36% lower.

### How the example compares with real agent costs

[RESEARCH] Per-task costs of coding agents span two orders of magnitude:

- Cursor with its own Composer 2.5 model cost 0.07 USD per task on the Artificial Analysis Coding Agent Index in May 2026. Claude Code with Opus 4.7 at maximum effort cost 4.10 USD, and Codex with GPT-5.5 cost 4.82 USD [17].
- On version 1.5 of the same index (September 2026, not directly comparable), Claude Code with Opus 5.5 at maximum effort cost 13.04 USD per task [18].
- Anthropic publishes a Claude Code average of 13 USD per active developer day and 150 to 250 USD a month [19].
- Gartner reports that 23% of tech leaders pay 200 to 500 USD per developer per month for coding-agent tokens [20].

[INFERENCE] The worked example's `C = 2.50` sits inside the range for frontier agents. Against a cheap in-house model at 0.07 USD per task, there is almost nothing to save, and nothing can be sold.

### Where the value actually comes from

[INFERENCE] The benchmark measures one thing: model cost to reach passing tests. That is the most measurable slice of value, not the largest.

| Value strand | Who feels it | Measured by Lemma? | Monetizable? |
| --- | --- | --- | --- |
| Model tokens not spent rebuilding | Whoever pays the agent's bill | Yes: `S`, per profile, per model | Yes, capped at 30% of `S` |
| Wall-clock time of the agent run | The developer waiting | Partly: the benchmark records wall time | Indirectly; people value time far above tokens |
| Developer attention: fewer wrong attempts to review | The developer | No | Yes, and probably the largest strand for professionals |
| Reliability: pinned tests and a known-good profile | The developer and their team | Partly: pass rates from verified receipts | Yes, as a warranty and a track record |
| Correctness on sensitive integrations (payments) | The team and its users | No | Yes, for teams that carry the risk |
| Compatibility knowledge: "does this fit my exact versions?" | The developer | Yes: the decision and reason codes | Given away on purpose: the free preview is what makes agents ask |
| Outcome history and confidence per profile | Future buyers, providers, vendors | Yes, over time | Later, as evidence, attestation and warranty pricing |

**Created versus captured.** [INFERENCE] If the worked example holds, each resolution creates at least 1.30 USDC of model saving plus unmeasured time and reliability value, and Lemma may capture at most 0.39 USDC. Marketplaces that bring buyers typically take 12% to 30% of a sale's whole price (section 6.4). Lemma takes at most 30% of the smallest measurable strand of value. That is a deliberate buyer-first choice for a market that does not trust agent purchases yet. It is also the biggest limit on revenue per transaction, and the reason this report looks beyond the per-resolution price.

### Do not accept the assumption uncritically

[INFERENCE] Three ways the value could be smaller than the design assumes:

1. **The saving is per profile and decays.** Evidence is tied to one model and price sheet and carries a stale date. A cheaper model, a new SDK major or a better agent skill can erase `S` before the evidence pays back.
2. **The control arm may improve faster than the treatment arm.** As agents get better at reading upstream docs, rebuilding gets cheaper. Lemma's saving is the difference of two falling numbers.
3. **Adoption friction is a cost the benchmark leaves out.** Funding a USDC wallet, installing a bridge and a rule, and trusting a third-party patch are real costs that never appear in `C`.

Three ways it could be larger:

1. **Spend per task is rising, not falling.** [RESEARCH] Token prices fell (Opus from 15/75 USD per million input/output tokens in 2025 to 4/20 USD for Opus 5.5), but tokens per task grew faster: Opus 5.5 costs 21% more per task than Opus 5 despite a 20% lower token price [21, 22, 18]. Anthropic's published per-developer averages roughly doubled from 2025 to 2026 [23, 19]. [INFERENCE] If that holds, `S` in dollars may grow with agent ambition, not shrink.
2. **Failure cost is asymmetric.** A wrong payment integration is expensive. The benchmark counts tokens, not the cost of shipping a bug.
3. **Repeat use and unattended agents.** A team that adopts one release across many repositories pays for evidence once. Background agents that nobody watches gain most from a verified patch with tests.

<!-- pagebreak -->

## 4. Who can pay

[INFERENCE] Each candidate payer, judged on what Lemma does now and could do soon. "Budget" names the line the money would come from.

| Payer | Their problem | Uses today | Budget | Willingness to pay | How to charge |
| --- | --- | --- | --- | --- | --- |
| Individual developer | The agent rebuilds a known integration and burns tokens | Docs, the agent itself, a package | Personal agent spend | Low per unit; cents sit below their attention | Only through the agent, invisibly |
| Professional developer or small startup | The same, plus reliability on payment code | The same, plus a senior review | Team tool budget | Medium: pays for time and a tested patch | A plan, not a wallet |
| Engineering or platform team | Every repository re-derives the same integration; drift; no proof it still fits | Internal templates, golden paths, portals | Platform or developer-productivity budget | High for their own integrations; medium for a public catalog | Per seat or per repository |
| Enterprise | The above, plus audit: what did agents apply, and did it pass | Manual review, policy tools | Security or platform budget | High, slow to close | Annual contract |
| Integration vendor (the company whose SDK is integrated) | Agents integrate its product wrongly or not at all | Docs, DevRel, sample repos, MCP servers | Developer relations, growth | Plausibly high: it already pays for distribution | Per release version, per adoption, per year |
| Agent vendor or platform | Its agents look better with verified reuse and burn fewer tokens | Its own skills, plugins, directories | Partnerships | Unclear; may absorb the feature | Partnership or white label |
| Component creator | A channel to sell verified, warrantied work to agents | npm, GitHub, marketplaces | Their revenue | Depends on Lemma's demand | Supply side: a fee or a share |
| Open-source maintainer | Paid when agents reuse their work | Sponsors, grants | None | n/a | A payee, not a payer |
| Agency or consultancy | Deliver the same integration to many clients, with proof | Internal snippets | Delivery margin | Medium | Team plan |
| Chain, facilitator, wallet | Agent transaction volume on their rails | Grants, hackathons | Ecosystem grants | High for grants, low for recurring | Grants and prizes |

**Budgets sit with teams, not individuals.** [RESEARCH] GitHub Copilot moved every plan to usage-based credits on June 1, 2026, and its Business and Enterprise seats are bought by the organization [24, 25]. Claude Team and Enterprise admins cap spend per organization, group or member [19]. [INFERENCE] A wallet held by an agent is a new budget line that an admin must approve and fund. In the x402 sample above, only about 6% of buyers persisted [9].

**Vendors already pay for verified distribution.** [RESEARCH] Docker's Verified Publisher program is paid by the publisher: annual plans priced by consuming domains, with a badge, search ranking, scanning and reports [14]. Salesforce charges 999 USD per security review attempt for paid listings [26].

**Not every user is a customer.** [INFERENCE] The individual developer is the user but a poor payer: their willingness to pay per resolution is measured in cents, and the friction of a USDC wallet exceeds it. The two strongest payers feel the integration problem at scale: **engineering organizations** (many repositories, one standard) and **integration vendors** (many developers, one product). The same machinery serves both, and neither needs to hold USDC.

## 5. Current product and architecture implications

[REPO] What the architecture makes cheap, what it makes hard, and what it forbids, as it bears on money [1, 2].

#### Cheap because of the design

- **A preview costs almost nothing.** The resolver is deterministic and reads the catalog. Lemma can give the compatibility answer away, which is what earns the agent's first call.
- **One release, many buyers.** A release is content-addressed and sold unchanged to every buyer whose profile fits. Marginal delivery is a signed bundle and, in the paid path, up to four on-chain actions.
- **Evidence can cover a profile class.** The docs plan to publish, per capability, the dependency names the catalog matches on, so one benchmark covers a documented class of repositories.
- **Receipts become data with no extra work.** Verified receipts grouped by release and profile estimate the failure rate `q`, which the docs plan to use to stop offering failing profiles, set bond or price per profile, and build provider reputation.

#### Hard because of the design

- **Evidence cost comes first.** [REPO] The frozen benchmark is a 20-run matrix: three matched tasks with three control and three treatment runs each, plus one no-match task in both arms [27]. Its cost is paid before the first sale, and again when evidence goes stale. The docs say a profile is worth curating only if about `N*` buyers adopt it before then [1].
- **The price basis is narrow.** `maxPriceFor` only knows model cost. A price that reflects time or reliability needs a new basis and a new rule.
- **The chain is inside the price.** Up to four on-chain actions per resolution. The docs warn that "a planned 10% Lemma fee (0.1 P) can be smaller than facilitator gas" at sub-dollar prices [1].
- **The buyer must hold USDC and a separate signer.** The bridge README asks for the wallet key to live "with a signer that runs as another user, or on a hardware or remote signer", because acceptance tests run as the user [28]. This is correct engineering and a real onboarding cost.
- **First-party supply only.** The MVP excludes open provider registration, auctions, dynamic pricing and retroactive rewards [2].

#### What the design forbids

- No token or NFT, so no token-based monetization.
- No model prose in matching, pricing or payment, so no persuasive upsell inside the agent conversation, and no paid ranking.
- No source upload by default, so no usage data richer than the typed profile.

### What the compatibility intelligence layer adds

[PLANNED] Per the build plan, branches being built as of September 27, 2026 (not merged) add two public signals, both fed only by settled, tested outcomes [8]:

- **Compatibility confidence.** One integer-only Rust crate runs on the server (as WebAssembly) and in a Stylus contract on Arbitrum, so the server's number and the public number cannot disagree. Per release and profile, it keeps time-decayed pass and fail sums (30-day half-life), starts from the benchmark's treatment arm as a prior, and reports the 90% Wilson lower bound (a cautious estimate of the pass rate that stays low while results are few) in basis points, with the effective sample size.
- **ERC-8004 reputation.** For each finalized outcome, one published Lemma attester address posts feedback on the provider's agent: value 100 for passed or 0 for failed, `tag1 = "lemma.adoption"`, `tag2` = the capability, and a public evidence file with its hash. A buyer agent can opt in to receive the same kind of feedback.
- **Privacy rule.** Evidence files never name the buyer, payer, preview id, settlement or nonce. The registry never stores a buyer address.

[INFERENCE] The economic consequence is sharp: **whatever Lemma puts on chain becomes a public good.** Anyone can read the confidence value and the pass rate for free. Lemma cannot sell the public number. It can sell what the number rests on: being the attester that others trust, fresh and private evaluations, and prices derived from the data, such as warranty premiums and bond sizes. Section 7 works this out.

[INFERENCE] The architecture today is a **verified publisher with a metered delivery rail**, not a marketplace. Its natural first monetization is whatever pays for evidence: the buyer per unit (today's design), a sponsor per release, or a team per period.

<!-- pagebreak -->

## 6. Adjacent markets and comparables

[RESEARCH] Facts in this section come from three fact sheets compiled on September 26 and 27, 2026. The build environment's network blocked most vendor sites. Sources marked "read directly" in section 18 were fetched and read. Sources marked "search summary" come from search-result text only and should be spot-checked before they are quoted elsewhere. Where a fact was not found, this section says so.

### 6.1 What coding-agent work costs, and who holds the budget

| Product | Price points | How usage is billed |
| --- | --- | --- |
| Cursor | Pro 20 USD; Teams Standard 40 and Premium 120 USD per user (from June 1, 2026) | Plans include model usage at API prices; overage billed in arrears [29] |
| GitHub Copilot | Pro 10, Pro+ 39, Max 100 USD; Business 19 and Enterprise 39 USD per user | Usage-based credits on every plan since June 1, 2026; one credit is 0.01 USD [24, 25] |
| Claude Code | Pro 20 USD; Team 25 or 125 USD per seat; Enterprise 20 USD per seat plus usage | Allowance per window, then usage at API rates; admins cap spend [30, 19] |
| OpenAI Codex | Included in ChatGPT plans | Credits since April 2, 2026; a typical session costs 0.50 to 2 USD [31] |
| Devin | Core 20 USD plus 2.25 USD per compute unit | About 15 minutes of agent work per unit [32] |

- **Direction of spend.** [RESEARCH] Copilot, Codex, Windsurf and Cursor all moved to consumption billing in 2026 [25, 31, 33, 34]. Gartner projects coding-agent token costs will exceed average developer salary by 2028 [20].
- **Token prices keep falling for the same capability.** [RESEARCH] Epoch AI finds a median fall of about 50 times a year, with a range of 9 to 900 times [35]. A new top price tier of 10/50 USD per million tokens now exists at both Anthropic and OpenAI [21, 36].

[INFERENCE] Budgets for agent work are growing and are billed by consumption, and teams and platforms hold them. A Lemma price that lowers the cost of a task fits how buyers now think. A new wallet does not.

### 6.2 Agent tool and MCP marketplaces

- **Directories are free and pay creators nothing.** [RESEARCH] The official MCP Registry holds metadata only and is still in preview [37]. Claude's connectors directory opened a submission portal on September 25, 2026 with safety scans and "community" versus "verified" tiers, with no fee or revenue share stated [38]. Anthropic's skills marketplace is free [39]. PulseMCP lists 21,800+ servers for free; its business model was not found [40].
- **Tool calls are priced in fractions of a cent.** [RESEARCH] Composio charges 29 USD for 200,000 tool calls a month [41]. Context7 charges 5 USD per 1,000 search calls after its included quota [42].
- **Where creators are paid, they keep 70% to 80%.** [RESEARCH] Apify Store creators keep 80% and can charge per event [43]. Apify paid out 563,000 USD in September 2025 and more than 4 million USD since launch [44]. RapidAPI took a flat 25%; it was once valued at 1 billion USD, and Nokia bought its technology assets on November 13, 2024 [45].
- **Trust is scarce, and platforms are taking over vetting.** [RESEARCH] Arcade, which bought the Smithery registry on August 5, 2026, graded only 0.5% of 43,400 MCP servers "A" [46, 47]. A February 2026 audit found 341 of 2,857 skills on the ClawHub registry were malicious [48]. Tessl runs a free skills registry with task evaluations and published uplift (for example 47% to 96% on one skill) and has raised 125 million USD [49, 50].

[INFERENCE] Distribution for agent tools is free, and vetting is becoming a platform feature. Lemma cannot charge for being listed. It can charge for evidence that others do not produce: measured savings and test-based outcomes per profile.

### 6.3 Agent payment rails

- **x402 volume is real but thin, and concentrated on Base.** [RESEARCH] Cumulative x402 volume reached about 165 million transactions and about 50 million USD by late April 2026, more than 90% on Base [51, 52]. In the 30 days to July 2026: 75 million transactions and 24 million USD, about 0.32 USD each [53]. The public counter reportedly has not changed since March [54]. CoinDesk wrote on March 11, 2026 that "demand is just not there yet" [55].
- **An independent sample is smaller still.** [RESEARCH] Base payments from August 23 to September 25, 2026: a median payment of 0.003 USD, 61% under one cent, about 73,000 payments and 125,000 USD a day. Repeat sellers make 64% of payments but 1% of dollars. About 6% of buyers persist, against 58% of sellers [9].
- **Settlement fees.** [RESEARCH] Coinbase's facilitator: the first 1,000 settlements a month free, then 0.001 USD each [56]. PayAI, since September 21, 2026: 1,000 free settlements per receiving wallet for life, then gas plus 30% [57]. Stripe's x402 preview: 1.5% per charge with a 0.01 USD minimum [58]. An open-source Arbitrum facilitator charges 0.5% plus 0.1 USDC by default [59].
- **Governance is consolidating.** [RESEARCH] The x402 Foundation, under the Linux Foundation, lists 40 members including Visa, Mastercard, Stripe and Google [60, 61]. OpenAI retired its Instant Checkout in March 2026 after fewer than 15 Shopify merchants went live [62].

[INFERENCE] Fees dominate below about 0.05 USD per payment. Lemma's 0.39 USDC price sits above that zone, which is good. But the buyer side of agent payments barely repeats, and x402 activity on Arbitrum is small next to Base. x402scan, a public x402 explorer, does not index Arbitrum [63].

### 6.4 Developer marketplaces and app stores: take rates

| Platform | Take rate | What the platform adds |
| --- | --- | --- |
| Unity Asset Store | 30% | Buyers from the engine; refunds only if not downloaded within 14 days [64, 65] |
| Fab (Epic) | 12% (was 30% until 2018) | Buyers from the engine; sellers kept 100% until the end of 2024 to seed supply [66, 67] |
| Envato Market | 50% from July 1, 2026, plus a buyer fee | Heavy discovery [68] |
| WooCommerce Marketplace | 30% | Application, review of security and compatibility, a test toolkit [69] |
| GitHub Marketplace | 5% | Verified publisher, and at least 100 installs before paid plans [70, 71] |
| Shopify App Store | 0% on the first 1 million USD of lifetime revenue, then 15% | Buyers from the host product [72] |
| Atlassian Marketplace | Forge 15% rising to 17%; Connect 15% rising to 25% (October 1, 2026) | Buyers from the host product; the lower rate steers vendors to Forge [73] |
| Salesforce AppExchange | 15% standard, 25% OEM; 999 USD per security review attempt | Buyers from the host product, and a paid review gate [74, 26] |
| JetBrains Marketplace | 15% (5% in the first year of paid plugins) | Licensing and tax [75] |
| AWS and Microsoft marketplaces | About 3% (AWS 1.5% to 3% on private deals) | A billing channel on the buyer's cloud bill [76, 77] |
| Apify Store | 20% (creators keep 80%) | Metered, per-event billing [43] |
| Gumroad | 10% plus 0.50 USD | Payments and tax only [78] |

[INFERENCE] Five lessons for Lemma:

1. **The take rate matches what the platform adds.** About 30% where the platform brings buyers and handles refunds; 12% to 25% where a host product brings buyers; 1.5% to 5% for billing channels.
2. **Fixed fees rule out tiny card prices.** On a 1 USD sale, Gumroad's 10% plus 0.50 USD takes 60% (my arithmetic from [78]). Sub-dollar prices survive only where usage is metered and billed in bulk.
3. **Supply is seeded with low rates, and rates rise later.** Fab paid sellers 100% at launch; Shopify, and Atlassian for qualifying apps, waive the first million; JetBrains went from 5% to 15%.
4. **Buyers come from a host product.** Marketplaces without one faded: RapidAPI ended in an asset sale.
5. **Quality is policed at the door, not by outcomes.** Review gates, install minimums and narrow refund windows. No surveyed platform documents a seller-posted bond or a refund tied to results.

### 6.5 Verified software, warranties and indemnities

- **Chainguard.** [RESEARCH] Sells a catalog of 1,000+ container images "maintained under a CVE SLA": critical CVEs fixed in 7 days, others in 14 [79, 12]. The free starter tier has 5 images and no SLA [80]. Annual recurring revenue reportedly grew sevenfold to 40 million USD in fiscal 2025; it raised 280 million USD at a 3.5 billion USD valuation in October 2025 [13, 81]. No credit or refund terms were found.
- **Docker Hardened Images.** [RESEARCH] Free under Apache-2.0 since December 17, 2025. The Select tier (compliance builds, customizations) costs 5,000 USD per repository per year, with critical CVEs fixed in under 7 days on paid tiers [10, 11].
- **Ubuntu Pro.** [RESEARCH] Ten years of patching for 25 USD per workstation or 500 USD per server per year [82].
- **Tidelift.** [RESEARCH] A subscription catalog backed by paid maintainers, including "licensing verification and indemnification" [83]. Sonar announced its acquisition on December 17, 2024 [84].
- **IP indemnity is the main software "warranty".** [RESEARCH] Anthropic defends API customers against copyright claims from January 1, 2024 [85]. GitHub extends defense clauses to Copilot suggestions for Business and Enterprise [86].
- **Refunds on failure exist only in labor markets.** [RESEARCH] Algora holds bounty payments until release and charges a 9% platform fee plus 4% [87]. Upwork charges clients 5% [88]. Units spent on failed Devin sessions are reportedly not refunded [89].

[INFERENCE] The artifact is free; the maintained, dated promise is what customers pay for. Software warranties today are fix-time promises and legal indemnities, not money back. Lemma's bonded refund on a failed adoption has no direct comparable. That is a differentiator and an untested demand (experiment E7).

### 6.6 Evidence and evaluation businesses

- **Evidence sells to model makers and governments.** [RESEARCH] Scale AI reports more than 1 billion USD of new business in 2025 [90], and a Pentagon contract ceiling raised to 500 million USD [91]. LMArena was valued at 1.7 billion USD in January 2026 with a run-rate above 30 million USD a year and labs such as OpenAI, Google and xAI as clients [92]. Vals AI raised 40 million USD at a 400 million USD valuation in August 2026 [93].
- **Independence is the product.** [RESEARCH] Epoch AI was criticized for disclosing OpenAI's funding of a benchmark late [94]. LMArena was criticized for letting labs test variants privately [95]. OpenAI stopped reporting SWE-bench Verified in February 2026 after finding flawed tests in at least 59.4% of an audited hard subset [96].
- **Enterprises pay per seat and per trace to produce their own evidence.** [RESEARCH] Braintrust Pro costs 249 USD a month; LangSmith Plus costs 39 USD per seat a month [97, 98].

[INFERENCE] Lemma's benchmark evidence is narrow (a few integrations, one model at a time). It will not sell to labs soon. Its value is as the license to sell a release and as a trust signal. It must be measured by Lemma, never by the provider, as the docs already require [1].

### 6.7 Platform engineering and golden paths

- [RESEARCH] Backstage is open source and free; Spotify's plugin bundle is listed at 100,000 USD per 12 months [99]. Roadie charges 24 USD per developer per month with a 50-seat minimum [100]. Port is free up to 15 seats, then 30 or 40 USD per seat [101]. Cortex's median contract is about 75,000 USD a year [102].

[INFERENCE] Teams pay per seat for standardization and governance. The templates themselves are free. A private Lemma catalog competes for this budget.

### 6.8 Open-source funding

- [RESEARCH] GitHub Sponsors passed 100 million USD in total, across 70,000+ maintainers and organizations (July 2026) [103]: about 1,400 USD per maintainer over its whole life (the fact sheet's arithmetic). The Open Source Pledge asks companies for 2,000 USD per full-time developer per year [104]. 60% of maintainers are unpaid [105]. Bountysource stopped paying bounties in 2023 and its parent filed for bankruptcy [106].

[INFERENCE] Maintainer money is thin and works like charity. "Pay the maintainers" (idea G in `docs/arbitrum.md`) is a strong story and a supply lever. It is a cost, not a revenue line.

### 6.9 Agent reputation on chain: ERC-8004

- **The standard.** [RESEARCH] ERC-8004 is a Draft with three registries: identity (an ERC-721 agent id), reputation and validation [107]. Anyone except the agent's owner or operator may post feedback. There is no payment check. `getSummary` refuses to run without a list of reviewers: the spec's own answer to sybils (many fake identities run by one party) is "trust specific reviewers" [107].
- **On Arbitrum.** [RESEARCH] The Arbitrum Foundation says ERC-8004 went live on Arbitrum on February 5, 2026, and names "reputation scoring algorithms" among what Stylus opens up [108]. The registries are deployed on Arbitrum Sepolia and One as proxies the ERC-8004 team can upgrade [109].
- **Usage is large and mostly ungrounded.** [RESEARCH] A forensic study of the live registries counts 419,155 feedback events. One agent received 66.05% of all Base feedback, from 60 worker wallets. The validation registry had 12 requests, 7 responses and 1 validator, who was the agent's own owner [110]. A paper quoted in the contracts repository finds 73.5%, 59.2% and 90.6% of reviewers show coordinated sybil behavior on Ethereum, BSC and Base, and that "feedback records are rarely grounded in verifiable interactions" [111].
- **Test-based outcomes are scarce.** [RESEARCH] ERC-8183 (agentic commerce, Draft) recommends mapping job outcomes into ERC-8004 feedback [112]. Test-graded outcomes appear only in hackathon projects [113]; the research found none for coding patches.
- **Stylus economics.** [RESEARCH] Arbitrum's docs say compute is "10-100x" cheaper in Stylus, but "storage operations cost roughly the same as in the EVM" [114]. Another entry in this buildathon measured 256-bit fixed-point math as about three times dearer per operation in WebAssembly [115].

[INFERENCE] A public reputation layer exists, but its signals are cheap to fake. Grounded, test-based outcomes are exactly what it lacks, and what Lemma produces. The value to Lemma is trust and distribution, not a fee on the public number.

### 6.10 What the comparables teach Lemma

| Lesson | Evidence | What it means for Lemma |
| --- | --- | --- |
| The maintained promise sells; the artifact is free | Docker, Chainguard, Ubuntu Pro (6.5) | Sell the evidenced fit promise and its upkeep, not the patch |
| Budgets sit with teams and platforms | Copilot, Claude, Cursor plans (6.1) | Charge organizations; keep the agent wallet as a rail |
| Tiny payments barely repeat | x402 sample: 0.003 USD median, 6% of buyers persist (6.3) | Do not forecast revenue from agent micropayments |
| Vendors pay for verified distribution | Docker Verified Publisher, Salesforce review fee (4, 6.4) | Sponsored releases, badges and evidence fees are plausible |
| Evidence is worth its independence | SWE-bench flaws, LMArena and Epoch critiques (6.6) | Lemma measures; providers never grade themselves |
| Reputation signals are cheap and ungrounded | ERC-8004 forensics (6.9) | Lemma's grounded outcomes are scarce; become the trusted reviewer |
| Nobody refunds a failed adoption | Survey of 6.5 | The bonded warranty is new; test whether buyers care (E7) |

<!-- pagebreak -->

## 7. The option space

[INFERENCE] Every monetization model worth considering, in five families. Each entry says who pays, for what, how it fits Lemma's rules, and a verdict: **Now** (fits the current build), **Test** (run an experiment first), **Later** (needs scale or history), or **Reject**. Section 13 draws the money flows of the strongest combinations.

### 7.1 Transaction models: the buyer pays per use

**A1. Per-resolution price, Lemma as provider (today's design).** The agent's owner pays `P ≤ maxPriceFor` in USDC through x402 [1].
- Fits every rule: deterministic, evidence-gated, capped for the buyer.
- Weak as revenue: cents per sale (section 10), and buyer persistence in agent payments is low (section 6.3).
- **Verdict: Now, as a rail and an evidence source, not as the business.**

**A2. Model-aware or time-aware price.** The bridge sends a privacy-safe model-price class, and the resolver prices the saving for the buyer's own model, as the docs already propose [1]. A time-aware variant adds the value of agent minutes saved.
- Fairer, but each model class multiplies evidence cost. A buyer-declared value of time is a contract term, not an anonymous x402 input.
- **Verdict: Later**, once one model class clearly dominates demand.

**A3. Pay only after the tests pass.** Payment is held until the acceptance run passes or the claim window closes, instead of refunded afterwards. x402 contributors have proposed an escrow scheme [116].
- Stronger buyer promise, simpler warranty. Depends on an unsettled spec, and it delays provider revenue.
- **Verdict: Later**, if E7 shows the warranty drives purchases.

**A4. Marketplace take rate.** External providers publish bonded releases; Lemma keeps a fee, planned at 10% [3].
- At a 0.39 USDC price, 10% is 0.039 USDC, which the docs warn "can be smaller than facilitator gas" [1]. It needs a fee floor and open provider registration, which the MVP excludes.
- **Verdict: Later.** Marketplaces seed supply with low rates and raise them once sellers stay (section 6.4).

### 7.2 Supply-side models: vendors and providers pay

**B1. Sponsored and commissioned releases.** The vendor whose SDK agents integrate pays Lemma to build, benchmark and maintain a release for its product. Buyers pay nothing or only chain cost. Adoption receipts become the vendor's report.
- The vendor already pays for developer relations and sample code. Lemma sells correct adoption by agents, measured.
- Keeps the sale rule meaningful: if `maxPriceFor` is 0, the integration is not worth recommending, sponsored or not.
- Risk: independence. A sponsor must never grade its own release, and sponsorship must be labeled in the catalog.
- **Verdict: Test now (E4).** The strongest early payer.

**B2. Evidence fees (benchmark as a service).** A provider or vendor pays a fixed fee per release version for Lemma to run the frozen benchmark and fixtures. A pass licenses the release to be sold or recommended.
- Anchored by Salesforce's 999 USD per security review attempt [26]. The fee covers the evidence cost `K`, which Lemma must measure first.
- Keeps the rule that Lemma, not the provider, measures `S` [1].
- **Verdict: Test** once the harness has a measured cost per run (E1).

**B3. Provider listing fees.** A fee to be listed at all.
- Directories are free everywhere in this market (section 6.2), and listing alone gives the agent nothing.
- **Verdict: Reject** as a standalone fee; fold it into B2.

**B4. Verified-integration badges.** The vendor pays yearly to show "verified by Lemma" for named profiles in its docs and README, with the live confidence value and a link to the evidence.
- The comparable is Docker's Verified Publisher program, paid by the publisher [14]. The price anchor is Docker's 5,000 USD per repository per year for its maintained tier [11].
- The badge must be earned by evidence and revocable by data: when confidence falls below the floor, the badge turns off automatically. Otherwise it is advertising.
- **Verdict: Test (E9)** after the first sponsored release.

### 7.3 Subscription models: organizations pay

**C1. Team plan with a private catalog.** An engineering team pays per seat or per repository. Lemma packages and benchmarks the team's own integrations as private releases, served to their agents through the same bridge.
- Money moves off chain, in fiat. Receipts and warranty accounting can still run per resolution.
- Competes with platform-engineering budgets: Roadie at 24 USD per developer, Port at 30 to 40 USD per seat (section 6.7).
- Private outcomes stay private: they never reach the public confidence engine.
- **Verdict: Test now (E3).**

**C2. Enterprise deployment and audit trail.** The server, catalog and evaluator run inside the customer's boundary, with their own releases and bond. Adoption receipts become an audit trail of what agents applied and whether it passed.
- Long sales cycle; needs security review and support.
- **Verdict: Later**, after a team pilot converts.

### 7.4 The compatibility intelligence layer

[PLANNED] What the build plan adds, on branches being built as of September 27, 2026 and not merged: per release and profile, a confidence value (a 90% lower bound on the pass rate, with the benchmark as prior and a 30-day half-life) computed identically on the server and in a Stylus contract; ERC-8004 feedback from Lemma's attester for each finalized outcome; public evidence files [8].

[INFERENCE] **Principle: give the public signal away, sell what it rests on.** The on-chain confidence value and the ERC-8004 pass rate are readable by anyone for free. Charging for them would fail, and it would weaken the trust signal that brings agents and vendors to Lemma. Four things remain sellable.

**D1. Attestation for third-party releases.** A provider or marketplace pays Lemma to act as the evaluator for its release: run the pinned acceptance recipe on real adoptions, finalize outcomes, and post grounded ERC-8004 feedback from Lemma's attester.
- ERC-8004's own sybil answer is to trust specific reviewers [107], and live feedback is mostly ungrounded (section 6.9). A reviewer whose outcomes rest on a paid purchase, a bond and a pinned test is scarce.
- Price per attested outcome or per release per month. The fee must not depend on the verdict.
- Risk: wash adoption, where a provider buys its own patch to inflate its record. Publish distinct-buyer counts next to every pass rate, and count at most a few outcomes per buyer per profile per month [8].
- **Verdict: Later**, after Lemma's own releases have a public record (E10 tests whether anyone would filter on Lemma's attester).

**D2. Confidence as a data product.** The same crate computes confidence for private catalogs (C1) and for vendors' internal release channels. Sold inside plans, not per query.
- Bulk historical data (per-profile outcome counts, drift over time) could sell to vendors and researchers later. Evidence businesses sell mainly to labs and governments (section 6.6), and Lemma's data is narrow, so this is small.
- **Verdict: Now inside C1; Later as a separate product.**

**D3. Breakage alerts for vendors.** When a vendor ships a new SDK version, Lemma's fixtures and new outcomes show which profile classes broke, before the vendor's users notice. The vendor pays for alerts and a dashboard.
- Uses what Lemma already records: drift turns `reuse` into `adapt`, and the confidence falls. Priced per product per year, bundled with B1 or B4.
- **Verdict: Test** with the first sponsor.

**D4. Warranty priced like insurance.** Today the warranty refunds the price, backed by provider bond. With outcome data, the warranty can be priced as a premium: expected refunds from the conservative failure rate, plus a risk load (a safety margin on top of expected losses; formula in section 9, numbers in section 10).
- Steps: first, set bond and price per profile from confidence (the docs' lever 7). Then offer a warranted tier at `P + premium`, or a larger cover for teams (for example the cost of a failed rollout, not just the price). Much later, **underwriting pools**: third parties stake USDC behind a release's bond and earn premiums, and Lemma takes a fee (idea N in `docs/arbitrum.md`).
- The data gate is strict. With only the benchmark prior (three of three treatment runs passed), the 90% lower bound on the pass rate is 52.6%, so a conservative premium would be most of the price. It falls to about 10% of the price after roughly 500 outcomes (section 10, table F).
- Pools look like insurance and need legal advice before real money.
- **Verdict: bond and price per profile Later (needs outcomes); pools much later.**

### 7.5 Other models

**X1. Demand bounties.** Anyone puts USDC behind a capability agents keep asking for; the first provider to ship a benchmarked release claims it; Lemma takes a fee (idea K in `docs/arbitrum.md`). The demand ledger already ranks unmet asks.
- A good supply signal. Bounty platforms have a mixed record: Bountysource failed while holding funds, and Algora moved toward recruiting (section 6.5, [106, 117]). Funds must sit in a contract, never with Lemma.
- **Verdict: Later.**

**X2. Upstream maintainer share.** Each sale splits on chain, and a share goes to the open-source project the release is based on (idea G). A cost and a supply lever, not revenue.
- **Verdict: Now as a story and a small share, if it does not push the price above the ceiling.**

**X3. Agent-platform partnership or white label.** An agent vendor ships Lemma's verified releases natively and pays per resolution or per year.
- Distribution without a wallet. The risk is that the platform builds it itself.
- **Verdict: Test** in conversations at the Founder House (October 23 to 25) [6].

**X4. Grants and prizes.** [RESEARCH] Arbitrum's Trailblazer program offers 1 million USD in grants for AI on Arbitrum [118]. This buildathon's top three share 70,000 USD, plus a 15,000 USD category [119]. At the NYC Founder House, an escrow payments project won 60,000 USD and an agent-underwriting project 50,000 USD [120].
- Funds evidence in the early stage. Not a business.
- **Verdict: Now.**

#### Rejected models

- **Paid ranking or advertising.** It breaks the deterministic, published ranking and the rule that no prose or payment steers matching [1].
- **A token.** Excluded by the MVP boundary [2].
- **Selling per-repository demand data.** The bridge sends only a typed profile, and demand is published only in buckets of at least five repositories [16]. Selling finer data would break the privacy promise that makes agents ask.
- **A public facilitator business.** A public facilitator pays gas for anyone's settlements. [PLANNED] Lemma's facilitator stays private to its own tool [8]. Facilitator fees are also racing to zero (section 6.3).

<!-- pagebreak -->

### 7.6 Summary of the option space

| Code | Model | Payer | Revenue unit | Fits the rules | Verdict |
| --- | --- | --- | --- | --- | --- |
| A1 | Per-resolution price | Agent owner (USDC) | ≤ 30% of `S` per sale | Yes | Now, as rail |
| A2 | Model- or time-aware price | Agent owner | Per sale | Yes, with more evidence | Later |
| A3 | Pay after tests pass | Agent owner | Per sale, deferred | Yes | Later |
| A4 | Marketplace take rate | Providers | % of `P`, with a floor | Yes, once supply opens | Later |
| B1 | Sponsored release | Integration vendor | Per release version, per adoption | Yes, labeled | **Test now** |
| B2 | Evidence fee | Provider or vendor | Per release version | Yes | Test |
| B3 | Listing fee | Provider | Per listing | Adds nothing | Reject |
| B4 | Verified-integration badge | Integration vendor | Per release per year | Yes, if revocable by data | Test |
| C1 | Team plan, private catalog | Engineering team | Per seat or repository | Yes | **Test now** |
| C2 | Enterprise deployment | Enterprise | Per year | Yes | Later |
| D1 | Attestation for third parties | Provider, marketplace | Per outcome or per month | Yes, verdict-neutral fee | Later |
| D2 | Confidence data | Teams, vendors | Inside plans | Yes | Now inside C1 |
| D3 | Breakage alerts | Integration vendor | Per product per year | Yes | Test |
| D4 | Insurance-priced warranty, pools | Buyers, underwriters | Premium, pool fee | Yes, with legal review | Later |
| X1 | Demand bounties | Anyone | Fee on bounties | Yes, funds in contract | Later |
| X2 | Maintainer share | (cost) | n/a | Yes | Now, small |
| X3 | Platform partnership | Agent platform | Per resolution or year | Yes | Test |
| X4 | Grants and prizes | Ecosystems | One-off | Yes | Now |

<!-- pagebreak -->

## 8. Marketplace economics

[REPO] Answers to the usual marketplace questions, from the repository, with inferences marked [3, 1].

| Question | Today | Later, if Lemma opens supply |
| --- | --- | --- |
| Who creates releases? | Lemma, from open-source upstreams (the skeletons cite `coinbase/x402` at a pinned commit, Apache-2.0) [4] | Providers, under a registration process the MVP excludes |
| Who sets prices? | The provider (Lemma), at or below `maxPriceFor`; no auctions or dynamic pricing | The same rule, plus a price floor and a Lemma fee |
| Can suppliers compete? | No; one provider | Yes. The resolver already ranks matches: sellable first, then expected net saving `S − P`, then version and digests |
| Does Lemma take a percentage? | No; a 10% fee is planned | A fee with a floor, and rules for who pays gas |
| Does Lemma commission supply? | In effect: Lemma builds and benchmarks every release | Commissioning stays the realistic route, given evidence cost |
| Can one release be sold many times? | Yes; content-addressed and sold unchanged per fitting profile | Yes |
| What keeps quality up? | Fixtures (exact, boundary, near-miss, unsupported), an acceptance recipe, frozen evidence, expiry and stale dates, the bond | The same, plus evidence attestation: Lemma, not the provider, measures `S` |
| What does verification cost? | It is the bottleneck: fixtures plus a frozen 20-run matrix per release version [27] | Sequential designs and shared control arms lower it |
| How does evidence affect price? | Directly: no evidence, no sale; stale evidence, no sale; the price is a function of measured `S` | The same, plus confidence per profile |
| What happens when a release fails? | The receipt records `failed`; an eligible failure within the claim window (72 hours in the skeletons) is refunded from the bond; the evaluator decides [4] | The same, with bond and price per profile |
| Who bears refunds and rework? | The provider (Lemma), through the bond. The buyer's rework is not compensated beyond the price | Providers; later, underwriters |
| How does reputation develop? | Verified receipts per release and profile estimate `q` | Public confidence and ERC-8004 pass rates, per provider and capability |
| Can providers earn recurring revenue? | Only by selling one release many times before it expires | Recurring demand per profile class, sponsorships, badges |
| How does Lemma avoid becoming a code download store? | A deterministic fit decision against exact versions, evidence that it saved money for this profile, and a warranty with money behind it | The same three, plus outcomes that only Lemma can aggregate |

**Comparables.** [RESEARCH] Every surveyed marketplace polices quality at the door, with review gates, install minimums and narrow refund windows. None documents a seller-posted bond or a refund tied to results (section 6.4). [INFERENCE] Lemma's outcome-based quality control is its most distinctive marketplace feature, and also its most expensive one.

### Liquidity

[INFERENCE] A two-sided marketplace needs enough supply to make the first call worth it, and enough demand to make a release worth benchmarking. Lemma breaks the chicken-and-egg problem in three ways:

- **Demand is measured before supply exists.** Every `build` or `decline` answer is counted, and the Demand page ranks unmet asks. That is a purchase-intent signal for what to benchmark next, at no cost to the buyer.
- **Supply is narrow on purpose.** The first catalog covers x402 and MCP integrations. Liquidity is not "many releases" but "the few integrations agents ask for most, with a high fit rate".
- **The fit rate is the liquidity metric.** The question is not how many listings exist, but what share of previews end in `reuse` or `adapt`. Three releases with a 60% fit rate in their target audience are liquid. Three hundred with a 2% fit rate are not.

**The consequence.** Lemma should not behave like an open marketplace for a long time. It should behave like a publisher that uses demand data to decide what to publish, and commissions supply where it lacks the expertise. The Arbitrum builder community is the natural first audience: the first releases are x402 integrations that many entries in this buildathon built by hand [6].

## 9. Pricing mechanisms and formulas

### What the economic gates already decide

[REPO] [1]

- **Charge on token savings?** Yes, today: the price basis is the measured model-cost saving `S`.
- **A share of savings?** Yes, capped: at most 30% of `S`, and at most what leaves the buyer 25% better off after gas.
- **A fixed price?** One list price per release version, fixed until a new version with new evidence.
- **Depends on repository compatibility?** Yes, but binary: a profile is sold or not. The price does not vary across fitting profiles of one release.
- **Different prices for different buyers?** Not today. The spending policy checks that the challenge equals the quote. A model-price class is proposed.
- **Chain cost?** Subtracted inside `maxPriceFor`; a floor is planned.
- **Estimated versus realized savings?** The price uses the lower quartile of paired savings, so most buyers should realize more. Realized savings per buyer are never measured: receipts record pass or fail, not cost.

### Formulas worth considering

[INFERENCE] Each formula keeps `maxPriceFor` as the ceiling for the anonymous agent purchase, because that ceiling is what makes the sale defensible.

**F1. List price at the ceiling (today).**

```
P = min( provider list price, maxPriceFor(S, C, g) )
```

Simple, provable, small: cents per resolution.

**F2. Model-aware price.** `S_m` and `C_m` are measured for the buyer's model class `m`.

```
P(m) = min( list, maxPriceFor(S_m, C_m, g) ),  and P(m) >= price floor
```

Fair, but evidence cost grows with the number of model classes.

**F3. Value including time.** `T` is the measured wall-clock time saved; `τ` is the buyer's declared value of an agent-minute.

```
P = min( 0.30 * (S + τ * T),  S + τ * T - g - 0.25 * C )
```

Captures the strand developers care about. Because `τ` is a buyer input, it belongs in a plan or contract, not in an anonymous x402 purchase.

**F4. Two-part tariff for teams** (a fixed fee per period plus a price per use). A period fee `F` per seat or repository covers evidence and the bridge; resolutions cost `p0 = 0` or a nominal amount. Money moves off chain; receipts and warranty accounting stay per resolution. The natural shape for teams and enterprises.

**F5. Sponsor-funded price.** The vendor pays `V` per verified release version and `v` per adoption; the buyer pays nothing or chain cost only. `maxPriceFor > 0` still gates whether the release deserves a recommendation.

**F6. Marketplace fee with a floor.** `f` is the fee rate; `g_L` is the chain cost Lemma pays; `m` is a minimum margin.

```
fee = max( f * P,  g_L + m )     and the provider receives P - fee
```

[MODELED] Without the floor, a 10% fee on a 0.39 USDC sale (0.039 USDC) is below the modeled cost per resolution of chain, facilitator, infrastructure and support (0.056 USDC, section 10, table C).

**F7. Evidence fee.** `K` is the measured cost of one frozen benchmark and fixture set; `r` is the re-benchmark rate per year; `k` is a margin.

```
evidence fee per release version  >= K * (1 + k)
upkeep per release version a year >= r * K * (1 + k)
```

Anchor: Salesforce's review fee is 999 USD per attempt [26].

**F8. Warranty premium, priced like insurance.** `W` is the warranty amount (equal to `P` in the MVP), `c` the confidence engine's lower bound on the pass rate (in basis points), `θ` a risk load, `ρ` the yearly cost of bond capital, and `T_claim` the claim window in days.

```
q_hat   = 1 - c / 10,000
premium = q_hat * W * (1 + θ)  +  W * ρ * T_claim / 365
```

Using the lower bound, not the point estimate, makes the premium conservative when data is thin. Over a 72-hour window the capital term is tiny (about 0.0003 USDC per resolution at 10% a year, section 10). The failure rate drives the price.

**F9. Confidence-gated sale and bond.** Once a profile has at least `n_min` effective outcomes, stop offering it when `c` falls below a floor `c_min` (a new sale blocker; the docs' lever 7). Set the bond per profile so it always covers reserved warranties, and raise the price or the bond where `q_hat` is high.

### How much to capture

[INFERENCE] The 30% cap is a strong buyer-first stance. Marketplaces that bring buyers typically take 12% to 30% of the whole price, and verified-software vendors charge thousands per repository for a maintained promise (section 6). The cap should stay for the anonymous agent purchase, where trust is the scarce thing. For teams and sponsors the question changes: they pay for standardization, distribution and evidence, not for a share of tokens. Price those against their alternatives (a platform seat, a developer-relations budget, a review fee), not against `S`.

<!-- pagebreak -->

## 10. Unit economics

[MODELED] Every table in this section except 10.1 comes from one script, `docs/business-model/unit-econ.mjs` in the repository, rerun on September 27, 2026. It has no dependencies: `node docs/business-model/unit-econ.mjs` prints every figure in tables A to G, and all its inputs are in section 10.2 and at the top of each table. It uses the repository's own formulas [1]:

```
maxPriceFor(S, C, g)        = min( floor(0.3 * S),  S - g - ceil(0.25 * C) )
buyer all-in reduction      = (S - P - g) / C
provider margin per sale    = P * (1 - q) - g_provider - K / N
break-even volume N*        = K / (P * (1 - q) - g_provider)
```

Tables A, B, C and F are in USDC. Tables D, E and G are in USD, treating 1 USDC as 1 USD as the repository does. None of these amounts has settled on any chain; the only chain Lemma targets today is a testnet.

### 10.1 What is observed today

| Item | Value | Source |
| --- | --- | --- |
| Releases in the catalog | 2, both skeletons | [OBSERVED] release manifests [4] |
| Price of each release | 0 | [OBSERVED] release manifests |
| Compatibility fixtures | 27, across three capabilities | [OBSERVED] `packages/catalog/fixtures` |
| Releases with benchmark evidence | 0 | [OBSERVED] release manifests |
| Chain cost `g` and price floor | 0 and 0, status "placeholder" | [OBSERVED] `packages/catalog/economics.json` [5] |
| Claim window | 72 hours | [OBSERVED] release manifests |
| Paid resolutions, receipts, refunds, revenue | None | [REPO] the paid path is not built at this commit |

### 10.2 Inputs

| Input | Value | Label and basis |
| --- | --- | --- |
| Control cost to green `C` | 2.50 | [ASSUMED] the docs' worked example, "an illustrative assumption, not a measurement" [1] |
| Conservative saving `S` | 1.30 | [ASSUMED] same worked example |
| Chain cost `g` | 0.01 and 0.03 | [ASSUMED] 0.01 from the worked example; 0.03 as a cautious figure for four actions. [ESTIMATED] `docs/arbitrum.md` puts one USDC payment at well under a cent on Arbitrum [6] |
| Eligible failure rate `q` | 0.10 | [ASSUMED] worked example |
| Evidence cost `K` per release profile version | 30, 150, 600 | [ASSUMED] 30 is the docs' worked-example value [1]. 150 and 600 are chosen to include curation and review time, which nobody has measured. [ESTIMATED] Model spend alone: 20 runs at the per-task costs in section 3 (0.07 to 13.04 USD) cost about 1.40 to 261 USD (my arithmetic) |
| Facilitator fee | 0.001 | [RESEARCH] Coinbase's fee after the free tier [56] |
| Infrastructure, support and evaluator time per resolution | 0.005 and 0.020 | [ASSUMED] |
| Team seat price | 15 and 25 per month | [ASSUMED], near Copilot Business at 19 and Roadie at 24 (section 6) |
| Sponsor fee per release version | 1,500 to 5,000 | [ASSUMED], below Docker's 5,000 per repository per year [11] |
| Evidence fee | 999 | [ASSUMED], equal to Salesforce's review fee [26] |
| Warranty risk load `θ`, cost of bond capital `ρ` | 50%, 10% a year | [ASSUMED] |

### 10.3 Table A: the worked example, and cheaper models [MODELED]

Ceilings and margins are exact: the script computes them in atomic USDC, with the same integer rule as core's `maxPriceFor`, and never rounds them up.

| Scenario | `C` | `S` | `g` | Ceiling `P` | Buyer all-in cut | Margin before evidence (`q` = 0.10) | `N*` at `K` = 30 | `N*` at `K` = 150 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Worked example (docs) | 2.500 | 1.300 | 0.010 | 0.390 | 36% | 0.341 | 88 | 440 |
| Chain cost 0.03 | 2.500 | 1.300 | 0.030 | 0.390 | 35% | 0.321 | 94 | 468 |
| Model prices halve once | 1.250 | 0.650 | 0.030 | 0.195 | 34% | 0.1455 | 207 | 1,031 |
| Model prices halve twice | 0.625 | 0.325 | 0.030 | 0.0975 | 32% | 0.05775 | 520 | 2,598 |
| Bigger task, same ratio | 10.000 | 5.200 | 0.030 | 1.560 | 36% | 1.374 | 22 | 110 |
| Weak saving (S = 0.3 C) | 2.500 | 0.750 | 0.030 | 0.095 | 25% | 0.0555 | 541 | 2,703 |

[INFERENCE] The price scales with the task. Bigger, costlier integrations are where the unit sale works; small tasks on cheap models never pay back evidence.

### 10.4 Table B: revenue from the agent-paid unit alone [MODELED]

| Lemma's share per resolution | Resolutions a month for 10,000 USD | For 100,000 USD |
| --- | --- | --- |
| Lemma is the provider and keeps P = 0.39 | 25,642 | 256,411 |
| Marketplace fee of 10% (0.039) | 256,411 | 2,564,103 |
| Marketplace fee of 20% (0.078) | 128,206 | 1,282,052 |

### 10.5 Table C: contribution per resolution, Lemma as provider [MODELED]

| Line | USDC |
| --- | --- |
| Price `P` | 0.390 |
| Refunds: `q × P` | −0.039 |
| Chain cost `g` (four actions; to be measured) | −0.030 |
| Facilitator fee (hosted tier, if used) | −0.001 |
| Infrastructure per resolution | −0.005 |
| Support and evaluator time per resolution | −0.020 |
| **Contribution before evidence** | **0.295** |

Contribution after spreading evidence cost `K` over `N` sales of one profile version:

| Evidence cost `K` | `N` = 50 | `N` = 200 | `N` = 1,000 |
| --- | --- | --- | --- |
| 30 | −0.305 | 0.145 | 0.265 |
| 150 | −2.705 | −0.455 | 0.145 |
| 600 | −11.705 | −2.705 | −0.305 |

### 10.6 Table D: a team plan, per month [MODELED]

Assumes 2 to 6 resolutions per seat a month, chain cost 0.03 per resolution, and 40% of revenue set aside for evidence.

| Seats | Price per seat | Revenue | Resolutions | Chain cost | Benchmarks funded at `K` = 150 | At `K` = 600 |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 15 | 150 | 20 | 0.60 | 0.4 | 0.1 |
| 10 | 25 | 250 | 40 | 1.20 | 0.7 | 0.2 |
| 50 | 15 | 750 | 150 | 4.50 | 2.0 | 0.5 |
| 50 | 25 | 1,250 | 300 | 9.00 | 3.3 | 0.8 |

### 10.7 Table E: a sponsored release [MODELED]

Costs are evidence `K = 600` plus chain, infrastructure and support per adoption (0.055).

| Fee per version | Fee per adoption | Adoptions | Revenue | Cost | Contribution | Margin |
| --- | --- | --- | --- | --- | --- | --- |
| 2,500 | 0 | 200 | 2,500 | 611.00 | 1,889.00 | 76% |
| 1,500 | 1.00 | 500 | 2,000 | 627.50 | 1,372.50 | 69% |
| 5,000 | 0.50 | 2,000 | 6,000 | 710.00 | 5,290.00 | 88% |

<!-- pagebreak -->

### 10.8 Table F: the warranty priced like insurance [MODELED]

Formula F8 with `W = 0.39`, `θ = 50%` and the engine's 90% Wilson lower bound. The prior is one task's treatment arm: 3 of 3 runs passed. Rows add 30 outcomes at a 90% pass rate, or 100, 500 or 2,000 at 95%, all counted as recent. Bond capital over a 72-hour window at 10% a year adds only 0.00032 USDC per resolution. The model uses floating point; the engine's integer math can differ in the last digit.

| History | Passes / runs | Point pass rate | 90% lower bound | Failure rate used | Expected refund | Premium | Premium / P |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Benchmark prior only | 3 / 3 | 100% | 52.6% | 47.4% | 0.185 | 0.277 | 71% |
| Prior + 30 outcomes | 30 / 33 | 91% | 79.3% | 20.7% | 0.081 | 0.121 | 31% |
| Prior + 100 outcomes | 98 / 103 | 95% | 90.4% | 9.6% | 0.038 | 0.056 | 14% |
| Prior + 500 outcomes | 478 / 503 | 95% | 93.2% | 6.8% | 0.027 | 0.040 | 10% |
| Prior + 2,000 outcomes | 1,903 / 2,003 | 95% | 94.1% | 5.9% | 0.023 | 0.034 | 9% |

### 10.9 Table G: what it takes to reach a revenue target [MODELED]

Revenue, not contribution; tables C and E give the costs.

| Model and assumed price | Revenue per unit | Units a month for 10,000 USD | For 100,000 USD |
| --- | --- | --- | --- |
| Agent-paid resolution at 0.39 | 0.39 | 25,642 | 256,411 |
| 10% marketplace fee on 0.39 | 0.039 | 256,411 | 2,564,103 |
| Team seat at 25 a month | 25 | 400 seats | 4,000 seats |
| Evidence fee at 999 per release version | 999 | 11 | 101 |
| Sponsored release at 2,500 per version | 2,500 | 4 | 40 |
| Badge at 5,000 per release per year | 416.67 a month | 24 badges | 240 badges |

### What the numbers say

[INFERENCE] Four readings of the tables:

1. **The unit sale pays back evidence only at volume.** Break-even needs 88 to 2,703 sales per profile version (table A), before the evidence goes stale.
2. **Vendors pay more per deal; teams pay more steadily.** One 2,500 USD sponsorship equals two months of a 50-seat plan at 25 USD (tables D and E).
3. **The warranty is cheap in capital and expensive in data.** Bond capital costs about 0.03 cents per resolution. The conservative failure rate falls from 47% to about 7% only after some 500 outcomes (table F).
4. **To reach 10,000 USD a month:** 4 sponsorships, 11 evidence fees, 24 badges, 400 seats, or 25,642 agent-paid resolutions (table G).

<!-- pagebreak -->

## 11. Long-term business models by stage

[INFERENCE] The mechanism stays the same at every stage. What changes is who pays for evidence.

| Stage | Easiest to monetize | What grows in value | Who pays |
| --- | --- | --- | --- |
| **Early**: one provider, a few releases, testnet then mainnet | Little. Grants and prizes fund evidence. The x402 unit sale proves the mechanism and produces the first outcomes. A concierge offer to a few teams and one vendor tests willingness to pay. | The demand ledger: which capabilities agents ask for, by profile class. The first public outcomes. | Grants; design partners |
| **Growth**: tens of releases, mainnet, verified outcomes | Sponsored releases, badges and breakage alerts for vendors; team plans with private catalogs. The agent-paid unit stays as the public rail. | Compatibility history per release and profile; public confidence and reputation; a catalog agents trust because its fit rate is high. | Vendors; teams |
| **Scale**: hundreds of releases, several agents, commissioned providers | Evidence fees, attestation for third-party releases, marketplace fees with a floor, enterprise contracts. Bond and price per profile from confidence. | Network effects: more outcomes make prices and bonds more accurate; more profiles let one benchmark cover more buyers; the rule installed in many repositories makes Lemma the default first call. | Providers; enterprises; agent platforms |
| **Mature** | Private deployments with their own releases, bond and outcomes as an audit trail. Insurance-priced warranties and, with legal clearance, underwriting pools. | Proprietary data about each customer's own estate; the attester's standing as a trusted reviewer. | Enterprises; underwriters |

### Defensibility and its limits

- **Proprietary data.** Verified outcomes per release and profile are hard to copy: each needs a paid purchase, a pinned test and a bond. Demand buckets are weaker, since any MCP tool can count asks.
- **Public signals are copyable, the grounding is not.** Anyone can read Lemma's on-chain confidence and reputation. What a competitor cannot copy quickly is the stream of new grounded outcomes and the reviewer standing of Lemma's attester.
- **Switching costs.** Low for buyers (a rule and a config). Higher for teams whose private catalog and receipts live in Lemma, and for vendors whose badges point to Lemma's evidence.
- **Commoditization.** The fit check is deterministic and could be reimplemented. Evidence and the warranty are the moat, and they cost money to build.
- **Better models and cheaper tokens.** They shrink `S` per task, although rising tokens per task push the other way (section 3). This is the main reason to move the price basis for paying customers toward reliability, time and distribution.
- **Platform dependency.** The rule and bridge depend on agents honoring rules and MCP. An agent vendor could ship "verified reuse" natively. Lemma's answer is neutrality across agents and evidence per profile. The bridge already targets Cursor, Claude Code and any MCP client.
- **Payment and chain dependency.** x402, USDC and Arbitrum are three external dependencies. Payment terms are typed data, so another rail could be added. The warranty registry and the Stylus engine are chain-specific. ERC-8004 is a Draft whose contracts its team can upgrade, so Lemma treats it as a public mirror and keeps bonds and refunds in its own contract.
- **Regulatory and tax.** Selling software for stablecoins to anonymous wallets raises sales-tax, VAT and sanctions-screening questions once amounts matter. Team and sponsor billing in fiat avoids most of them. Warranty pools look like insurance. Both need advice before mainnet revenue.

## 12. Risks and kill arguments

[INFERENCE] The strongest argument against each model, and the evidence that would settle it.

| Condition | What it kills | Strongest form of the argument | Evidence that would settle it |
| --- | --- | --- | --- |
| Rebuilding becomes nearly free | Token-based pricing | Token prices fall fast (section 6.1). `S` is a difference of two falling numbers. At `S` under 0.30 USDC, the ceiling is under 0.09 USDC, below any sensible floor. | `S` per release across model generations. If it halves each generation, token pricing is dead within two. |
| Generated code becomes reliable enough | The warranty's value | If agents pass the acceptance tests first time, verification adds little. | Control-arm pass rates and attempts to green, per task, over time. |
| Developers refuse third-party patches | All buyer-paid models | Teams already refuse unvetted dependencies; malicious skills are common (section 6.2). | Share of `reuse` answers that end in `apply`. |
| Transaction values are too small | Per-resolution revenue | 0.39 USDC per sale; 0.039 at a 10% fee. 10,000 USD a month needs tens of thousands of sales. | Fitting previews per month in the demand ledger. |
| Payment friction exceeds the price | Agent-paid x402 | A funded wallet, a separate signer and caps cost more attention than the price. Only about 6% of x402 buyers persist (section 6.3). | Drop-off between `reuse` answers and purchases. |
| Verification costs too much | Supply | A frozen 20-run matrix per release version, repeated when stale, before the first sale. | Measured cost per benchmark against sales per release. |
| Supply quality is poor | Marketplace models | Providers inflate `S` or ship brittle patches. | Pass rate and refund rate per release. |
| Liquidity never develops | Marketplace models | A few releases fit few repositories; agents stop asking. | Fit rate per preview; repeat previews per repository. |
| Wash adoption games reputation | Compatibility intelligence | A provider buys its own patch to inflate its pass rate; ERC-8004 feedback is already mostly sybil (section 6.9). | Distinct-buyer counts per profile; the share of outcomes from new or linked wallets. |
| Nobody trusts Lemma's attester | Attestation and badges | A reviewer is only worth its standing. Marketplaces may prefer their own vetting, and a common ERC-8004 client does not include Arbitrum chains by default [121]. | Whether other marketplaces or agents filter on Lemma's attester (E10). |
| The public signal cannot be sold | Data products | Anything on chain is free to read and copy. | Revenue from D1 to D3 comes from services, not from the number. If vendors will not pay for alerts or badges, the layer is marketing only. |
| Agent platforms build it natively | Everything but neutrality | Anthropic already safety-scans and tiers connectors; platforms bundle tools (section 6.2). | Announcements; whether they publish evidence per profile. |
| Developers prefer open source | Paid units | The upstream is Apache-2.0 and the agent can read it. | The control arm measures exactly this. If `S` is small, open source wins. |
| Savings are hard to measure | The pricing rule | Noisy samples, model drift, billing delays. | Confidence intervals from the frozen benchmark. If the lower quartile is near zero, the rule prices nothing. |

**The two that matter most:** transaction values are too small, and payment friction exceeds the price. Both belong to the agent-paid unit, and both are avoided by charging a team or a vendor instead. Most of the rest are properties of the product, and the benchmark, receipts and confidence engine are the right instruments to detect them.

<!-- pagebreak -->

## 13. Model architectures and their money flows

[INFERENCE] Six architectures, from today's design to a mature market. Arrows show who pays whom. "Chain" means an Arbitrum transaction; "invoice" means ordinary fiat billing.

### M1. Agent-paid resolution (today's design)

```
Agent owner wallet --- USDC price P, x402 (chain) ------> Provider (Lemma)
Provider (Lemma) ----- bond W reserved (chain) ---------> Warranty registry
Warranty registry ---- refund W on an eligible failure -> Agent owner wallet
Lemma's facilitator -- gas g: settlement, activation, outcome, expiry -> chain
Lemma keeps P - g - refunds - its share of evidence cost K / N
```

### M2. Open marketplace with a take rate

```
Agent owner --- USDC P (chain) ---> split: provider gets P - fee
                                           Lemma gets fee = max(f * P, g_L + m)
Provider --- bond (chain) ---> Warranty registry --- refund ---> Agent owner
Provider --- evidence fee (invoice) ---> Lemma, which measures S itself
```

### M3. Sponsored releases

```
Integration vendor --- V per version + v per adoption (invoice) ---> Lemma
Lemma --- builds, benchmarks, maintains a labeled release ---> public catalog
Agent owner --- nothing, or chain cost only ---> (settlement)
Adoption receipts and breakage alerts --- report ---> Integration vendor
```

### M4. Team plan with a private catalog

```
Engineering org --- F per seat or repository per month (invoice) ---> Lemma
Lemma --- private releases, evidence, private confidence ---> the org's agents
Resolutions metered inside the plan; x402 optional; outcomes stay private
```

### M5. Compatibility intelligence

```
Provider or marketplace --- evidence fee, attestation fee (invoice) ---> Lemma
Integration vendor --- badge and alerts per year (invoice) ------------> Lemma
Warranty registry --- record(outcome) (chain) ---> Stylus confidence engine
Lemma attester --- feedback 100 or 0 (chain) ---> ERC-8004 reputation registry
Anyone --- reads confidence and pass rates for free (chain) ---> public
```

### M6. Warranty and underwriting market (later)

```
Agent owner --- P + premium (chain) ---> Provider and pool
Underwriters --- stake USDC (chain) ---> bond pool --- refund on failure ---> buyer
Premium ---> underwriters (1 - u), Lemma (u)
Confidence engine ---> premium and bond size per profile
```

### Comparison

| Model | Who pays | Revenue per unit (section 10) | Time to first revenue | Main cost | Biggest risk | Fit with Lemma's rules |
| --- | --- | --- | --- | --- | --- | --- |
| M1 Agent-paid resolution | Agent owner, USDC | 0.39, contribution 0.295 before evidence | Weeks (paid path on testnet first, mainnet later) | Evidence `K`; chain `g` | Volume and wallet friction | Exactly as designed |
| M2 Marketplace | Providers via fee | 0.039 at 10% | A year or more | Curation, attestation, support | Liquidity; fee below costs | Needs open registration, excluded in the MVP |
| M3 Sponsored releases | Integration vendor | 1,500 to 5,000 per version | One to three months | Evidence and upkeep | Independence; few sponsors | Yes, if labeled and graded by Lemma |
| M4 Team plan | Engineering org | 15 to 25 per seat a month | One to three months | Packaging private releases | Competes with free templates | Yes; money off chain |
| M5 Compatibility intelligence | Providers, vendors | 999 per evidence fee; about 417 a month per badge | Three to six months | Evaluator time; attester upkeep | The public number cannot be sold; trust must be earned | Yes; public reads stay free |
| M6 Underwriting market | Buyers, underwriters | A premium share | A year or more | Legal review; outcome data | Regulation; thin data | Yes, with no token |

**The recommended stack.** [INFERENCE] M1 as the public rail, M3 and M4 as the first revenue, M5 built alongside as the moat. M2 and M6 wait for data. The stack keeps every rule: the anonymous agent purchase stays capped and evidence-gated, public signals stay free, and the money that funds evidence comes from organizations that have budgets.

<!-- pagebreak -->

## 14. Recommended experiments

[INFERENCE] Each experiment is cheap, runs before the full business exists, and has a result that would change a belief.

| # | Hypothesis | Experiment | Metric and hoped-for signal | What would change our belief |
| --- | --- | --- | --- | --- |
| E1 | The saving is real and big enough to price | Run the stage-4 economic probe, then the frozen benchmark, on the two releases with real payloads | `S`, `C`, lower quartile, pass rates, and the cost of the benchmark itself. Hope: `S ≥ 1.00 USDC` on a frontier model, benchmark under a few hundred USD | `S < 0.30 USDC`, or a lower quartile near zero: token pricing cannot carry the product |
| E2 | Developers let an agent pay cents without asking | Ten developers install the bridge with a funded testnet wallet and a real task | Purchases per `reuse` answer; time to first purchase; caps chosen. Hope: over half buy on the first fitting preview | Most never fund the wallet or disable purchases: x402 is a demo rail, not a revenue rail |
| E3 | Teams pay for a private catalog | Concierge offer to five engineering teams: Lemma packages and benchmarks one internal integration for their repositories at a quoted monthly price | Signed pilots; price accepted. Hope: two of five sign at a price that covers evidence within three months | None sign, or only below evidence cost |
| E4 | Vendors pay for verified adoption | Pitch three vendors whose SDKs agents integrate often (payments, auth, MCP tooling): a sponsored, benchmarked release, free to buyers, with receipts as the report | Meetings that reach a quote; a signed sponsorship. Hope: one vendor pays for one release | None pays even at cost: sponsorship is not a channel |
| E5 | The fit rate is high enough | Ship the free preview publicly with the rule; count previews, decisions and reasons per profile class for a month | Fit rate (`reuse` + `adapt` over all previews); top unmet capabilities. Hope: over 30% in the target audience | Under 10%: the catalog is too narrow to justify more benchmarks |
| E6 | Price is not the barrier | Sell one release at 25%, 50% and 100% of the ceiling to three cohorts on mainnet | Conversion per price; revenue per fitting preview. Hope: conversion flat across prices | Conversion collapses above a low price: the barrier is trust, not money |
| E7 | The warranty changes behavior | Offer the same release with and without a visible bond and claim window to two cohorts | Conversion and apply rate. Hope: the warranty raises both | No difference: the bond is a cost with no demand effect |
| E8 | Organizations want plans | A pricing page with a team plan and an enterprise contact form, no purchase behind it | Clicks to plans; contact forms from company domains | Silence: demand is individuals, and plans wait |
| E9 | Vendors pay for badges and alerts | After E4, offer the sponsor a badge with live confidence plus breakage alerts at a yearly price | Accepted price; renewal intent | Declined: the intelligence layer is marketing, not revenue |
| E10 | Others trust Lemma's attester | Ask three agent marketplaces or registries whether they would filter or rank by Lemma's ERC-8004 feedback | Written intent to integrate | None would: keep reputation as Lemma's own trust signal only |

**Priority.** [INFERENCE] The numbers are labels, not a ranking. Section 15 sets the order: E1 and E5 first (days 1 to 30), with the first E3, E4 and E10 conversations at Founder House; then E3, E4, E2 and E8 (days 31 to 60); then E9 once a sponsor exists (days 61 to 90). E6 and E7 need priced sales on mainnet and have no fixed slot in the 90 days.

Avoid vanity metrics: page views, GitHub stars, testnet transactions from the team's own wallets, and previews from the benchmark harness itself (exclude them by client).

## 15. A 30/60/90-day validation plan

[INFERENCE] Day 1 is Monday, September 28, 2026. The plan assumes the buildathon deadline of October 4, 2026, Founder House Singapore on October 23 to 25 [6], and that the paid path, the warranty registry and the reputation and confidence layer ship on testnet in the first weeks.

#### Days 1 to 30 (to October 27): prove the unit

- Ship real payloads for the two releases, the x402 paid path, a thin warranty registry, confidence and reputation on Arbitrum Sepolia.
- Run the economic probe (E1). Record `S`, `C`, benchmark cost and the model, and publish them on the Proof page with their dates.
- Ship the free preview publicly with the rule for Cursor, Claude Code and AGENTS.md (E5). Start the demand ledger.
- Interview ten developers and five team leads with the demo, not a deck. Ask what they would pay for, and what they would never let an agent do.
- At Founder House, ask agent platforms and vendors directly (E3, E4, E10 conversations).
- **Decision at day 30:** if `S` is under 0.30 USDC or the fit rate under 10%, stop investing in the agent-paid unit and go to the team and vendor tracks only.

#### Days 31 to 60 (to November 26): find the payer

- Run E3 (concierge team pilots) and E4 (vendor sponsorship) in parallel, two conversations each per week.
- Mainnet with tiny caps for design partners (E2). Measure purchases per fitting preview.
- Put up the fake-door pricing page (E8): free previews, a team plan, enterprise.
- **Decision at day 60:** rank the payers by signed intent and accepted price. If none will pay evidence cost, keep Lemma open and grant-funded, and stop the paid tracks.

#### Days 61 to 90 (to December 26): run the first paid model

- Take the winning payer to a first paid engagement: a sponsored release, a team pilot, or a priced release on mainnet.
- Close the loop from receipts to confidence, so the second sale carries a public track record. Offer the sponsor a badge and alerts (E9).
- Publish the first unit economics with observed numbers: benchmark cost, price, chain cost, refund rate, each with its date.
- **Decision at day 90:** commit the next quarter to the model that earned revenue above zero after evidence cost. Keep the others as experiments.

## 16. Metrics and KPIs

[INFERENCE] In the order they become observable.

| Stage | Metric | Definition | Why it matters |
| --- | --- | --- | --- |
| Free preview | Previews per week; distinct repositories | Demand counters (buckets of at least five) | Demand exists before supply |
| Free preview | Fit rate | (`reuse` + `adapt`) / all previews, per capability and profile class | Liquidity |
| Free preview | Top unmet asks | Ranked demand buckets | What to benchmark next |
| Evidence | Cost per benchmark | Billed cost of the frozen matrix, plus curation hours | The supply-side unit cost `K` |
| Evidence | `S`, `C`, lower quartile, pass rates, per model | From `ProfileEvidence` | The price basis and its trend |
| Paid path | Purchases per fitting preview | Purchases / (`reuse` + `adapt`) | Buyer conversion |
| Paid path | Revenue and measured chain cost `g` per resolution | From settlements | Contribution per unit |
| Paid path | Apply rate; refund rate; abandoned rate | From receipts and warranty outcomes | Trust in what was bought; warranty cost |
| Intelligence | Effective sample size and confidence per sold profile | From the confidence engine | Whether confidence can price bonds and warranties |
| Intelligence | Distinct buyers per profile; outcomes per buyer | From finalized outcomes | Wash-adoption check next to every pass rate |
| Intelligence | Outside readers of Lemma's attester | Integrations that filter by it | Whether the reviewer role has value |
| Teams | Pilots signed; price per seat or repository | Contracts | The team model |
| Vendors | Sponsored releases; badges; adoptions per sponsored release | Contracts and receipts | The vendor model |
| Health | Evidence staleness | Share of releases past `staleAfter` | Re-benchmark burden |
| Health | Payback per release | Cumulative contribution / evidence cost | Whether `N*` buyers ever arrive |

## 17. Open questions for real-world validation

[INFERENCE] Questions that neither the repository nor the research can answer yet, with what would answer each.

1. **What is `S` on a frontier model in autumn 2026, and which way is it moving?** Token prices fall while tokens per task rise (section 3). Nothing in this report can replace the first frozen benchmark.
2. **Will any developer fund an agent wallet?** The paid path's whole demand side rests on this, and it has never been observed.
3. **Is the fit rate high enough outside curated fixtures?** Two releases, exact version ranges, one language.
4. **What does a benchmark cost, in dollars and days?** The harness records billed cost; no run exists yet.
5. **Will vendors sponsor, and at what price?** No vendor has been asked.
6. **Will teams pay for private catalogs before the public catalog proves anything?** The concierge pilot answers this.
7. **How much of the value is time and reliability rather than tokens?** Interviews plus wall-clock measurements in the benchmark give a first estimate.
8. **Will anyone outside Lemma use its attester's feedback?** The value of the reputation layer depends on it.
9. **How many outcomes per profile will arrive before evidence goes stale?** Table F shows confidence needs hundreds; the 30-day half-life means they must arrive steadily.
10. **Can wash adoption be detected well enough to publish pass rates?** Distinct-buyer counts help; linked wallets are hard to see without breaking buyer privacy.
11. **What are the tax, compliance and insurance obligations** of selling to anonymous wallets and of pricing warranties? Needs advice before mainnet revenue.
12. **Do agent platforms intend to build verified reuse themselves?** Ask them directly at Founder House.
13. **What is the refund rate under real drift?** The warranty's cost is unknown until outcomes exist.

<!-- pagebreak -->

## 18. Sources

Sources are numbered in the order they are first cited. "Read directly" means the page or file was fetched and read. "Search summary" means only a search engine's summary of the page could be read, because the build environment's network blocked the site; spot-check those before quoting them elsewhere. "Internal document" means a working document that is not in the repository, so readers cannot check it; what it describes is planned work, not repository behavior. Repository sources were read at commit `fe2d117` on September 27, 2026.

1. Lemma repository, docs/economic-gates.md (unit economics, sale rule, worked example, levers). (Repository file)
2. Lemma repository, README.md (product thesis, MVP boundary, planned releases). (Repository file)
3. Lemma repository, docs/economics.md (what is sold, pricing rule, warranty, planned 10% fee). (Repository file)
4. Lemma repository, packages/catalog/releases/*/0.1.0-skeleton/manifest.json and packages/catalog/fixtures (prices, provenance, claim window, fixture count). (Repository file)
5. Lemma repository, packages/catalog/economics.json (placeholder chain cost and price floor). (Repository file)
6. Lemma repository, docs/arbitrum.md (integration status, including the paused payment path; chain cost estimate; integration ideas G, K, N; Founder House dates). (Repository file)
7. Lemma repository, contracts/README.md and contracts/src (a Foundry scaffold that describes the warranty registry; no contract source yet). (Repository file)
8. Lemma build plan and integration spec for the week of September 27, 2026 (internal working documents, not in the repository). The work lands on the branches payments/x402-paid-path, contracts/warranty-registry, contracts/stylus-confidence and reputation/erc-8004. (Internal document)
9. savecharlie, x402-census: independent sample of x402 payments on Base, August 23 to September 25, 2026. <https://github.com/savecharlie/x402-census> (Read directly)
10. Docker press release: hardened images free, open and transparent. <https://www.docker.com/press-release/docker-makes-hardened-images-free-open-and-transparent-for-everyone/> (Read directly)
11. Docker Hardened Images plans. <https://hub.docker.com/hardened-images/plans> (Read directly)
12. Chainguard Academy, FedRAMP considerations (CVE fix times). <https://raw.githubusercontent.com/chainguard-dev/edu/main/content/chainguard/containers/security-and-compliance/fedramp-considerations/index.md> (Read directly)
13. Fortune, April 23, 2025: Chainguard's Series D at a 3.5 billion USD valuation. <https://fortune.com/2025/04/23/exclusive-chainguard-secures-356-million-series-d-as-valuation-soars-to-3-5-billion> (Search summary)
14. Docker documentation, Docker Verified Publisher subscription. <https://raw.githubusercontent.com/docker/docs/main/content/manuals/subscription-billing/plans/docker-verified-publisher.md> (Read directly)
15. Lemma repository, docs/security-model.md (accepted MVP trust: team-operated evaluator, first-party provider). (Repository file)
16. Lemma repository, apps/server/src/demand.ts (DEMAND_MIN_PROFILES = 5). (Repository file)
17. Artificial Analysis, Cursor Composer 2.5 and the Coding Agent Index (May 2026). <https://artificialanalysis.ai/articles/cursor-composer-2-5-coding-agent-index> (Search summary)
18. OrcaRouter, Claude Opus 5.5 on the Coding Agent Index v1.5 (September 2026). <https://www.orcarouter.ai/blog/claude-opus-5-5-coding-agent-index> (Search summary)
19. Anthropic, Claude Code documentation: costs. <https://code.claude.com/docs/en/costs> (Read directly)
20. Gartner press release, June 24, 2026: AI coding costs will surpass average developer salary by 2028. <https://www.gartner.com/en/newsroom/press-releases/2026-06-24-gartner-predicts-ai-coding-costs-will-surpass-average-developer-salary-by-2028-as-token-consumption-surges> (Search summary)
21. Anthropic, API pricing. <https://platform.claude.com/docs/en/about-claude/pricing> (Read directly)
22. TechCrunch, September 22, 2026: Anthropic releases Opus 5.5 with lower prices. <https://techcrunch.com/2026/09/22/anthropic-releases-opus-5-5-with-lower-prices-and-fable-level-performance/> (Search summary)
23. Anthropic, Claude Code costs (2025 version). <https://docs.anthropic.com/en/docs/claude-code/costs> (Search summary)
24. GitHub Copilot plans. <https://github.com/features/copilot/plans> (Read directly)
25. GitHub community discussion 192948: usage-based billing for Copilot from June 1, 2026. <https://github.com/orgs/community/discussions/192948> (Read directly)
26. Salesforce, security review fees. <https://developer.salesforce.com/docs/atlas.en-us.packagingGuide.meta/packagingGuide/security_review_fees.htm> (Search summary)
27. Lemma repository, docs/benchmark-protocol.md (the frozen 20-run matrix). (Repository file)
28. Lemma repository, apps/bridge/README.md (buyer key custody). (Repository file)
29. Cursor, Teams pricing, June 2026. <https://cursor.com/blog/teams-pricing-june-2026> (Search summary)
30. Claude plans and pricing. <https://claude.com/pricing> (Read directly)
31. CloudZero, OpenAI Codex pricing; Morph, Codex pricing. <https://www.cloudzero.com/blog/openai-codex-pricing/> (Search summary)
32. Lindy, Devin pricing. <https://www.lindy.ai/blog/devin-pricing> (Search summary)
33. CloudZero, Windsurf pricing. <https://www.cloudzero.com/blog/windsurf-pricing/> (Search summary)
34. LowCode Agency, Cursor AI pricing. <https://www.lowcode.agency/blog/cursor-ai-pricing> (Search summary)
35. Epoch AI, LLM inference price trends. <https://epoch.ai/data-insights/llm-inference-price-trends> (Search summary)
36. CloudZero, OpenAI pricing (GPT-6 Astra, Sol, Luna). <https://www.cloudzero.com/blog/openai-pricing/> (Search summary)
37. Model Context Protocol, official MCP Registry. <https://github.com/modelcontextprotocol/registry> (Read directly)
38. Anthropic, Build plugins for Claude (connectors directory submissions, September 25, 2026). <https://claude.com/blog/build-plugins-for-claude> (Read directly)
39. Anthropic, Agent Skills repository. <https://github.com/anthropics/skills> (Read directly)
40. PulseMCP server directory. <https://www.pulsemcp.com/servers> (Search summary)
41. Scalekit, Composio pricing change; Composio pricing. <https://composio.dev/pricing> (Search summary)
42. Upstash Context7, pricing change pull request 3248. <https://github.com/upstash/context7/pull/3248> (Read directly)
43. Apify documentation, monetize your Actor and pay per event. <https://docs.apify.com/platform/actors/publishing/monetize> (Search summary)
44. National Law Review press release: Apify bets 1 million USD on independent developers. <https://natlawreview.com/press-releases/apify-bets-1m-independent-developers-building-ais-missing-tools> (Search summary)
45. RapidAPI payouts help page; TechCrunch, November 13, 2024: Nokia acquires Rapid. <https://techcrunch.com/2024/11/13/nokia-acquires-rapid-the-api-company-once-valued-at-1b/> (Search summary)
46. Forbes, August 10, 2026: Arcade acquires Smithery. <https://www.forbes.com/sites/janakirammsv/2026/08/10/arcade-acquires-smithery-to-own-the-agent-tool-supply-chain/> (Search summary)
47. Dealroom news: Arcade acquires Smithery. <https://app.dealroom.co/news/feed/arcade-acquires-smithery-to-control-mcp-registry-and-runtime-layer> (Search summary)
48. Koi Security: 341 malicious skills found on ClawHub. <https://www.koi.ai/blog/clawhavoc-341-malicious-clawedbot-skills-found-by-the-bot-they-were-targeting> (Search summary)
49. Tessl launches its spec-driven framework and registry. <https://tessl.io/blog/tessl-launches-spec-driven-framework-and-registry> (Search summary)
50. Tessl, Skills are software and they need a lifecycle. <https://tessl.io/blog/skills-are-software-and-they-need-a-lifecycle-introducing-skills-on-tessl> (Search summary)
51. Ricosworks, blockchain payment flow analysis, AI agent payments market update (secondary). <https://github.com/Ricosworks1/blockchain-payment-flow-analysis/releases/tag/market-update-ai-agent-payments-73m-settlement-sept-2026> (Read directly)
52. Presenc, x402 protocol adoption tracker 2026. <https://presenc.ai/research/x402-protocol-adoption-tracker-2026> (Search summary)
53. CoinDesk, July 15, 2026: Visa, Mastercard and Ripple join the x402 standard. <https://www.coindesk.com/tech/2026/07/15/visa-mastercard-and-ripple-join-the-standard-letting-ai-agents-pay-in-stablecoins> (Search summary)
54. Daniel McGlynn, The x402 counter has shown the same four numbers since March. <https://www.danielmcglynn.com/the-x402-counter-has-shown-the-same-four-numbers-since-march/> (Search summary)
55. CoinDesk, March 11, 2026: demand for the Coinbase-backed payments protocol is not there yet. <https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet> (Search summary)
56. Coinbase Developer Platform, x402 facilitator. <https://docs.cdp.coinbase.com/x402/core-concepts/facilitator> (Search summary)
57. PayAI, payai-x402-skill pull request 4 (pricing from September 21, 2026). <https://github.com/PayAINetwork/payai-x402-skill/pull/4> (Read directly)
58. The Block: Stripe adds x402 integration for USDC agent payments. <https://www.theblock.co/post/389352/stripe-adds-x402-integration-usdc-agent-payments> (Search summary)
59. hummusonrails, x402 facilitator for Arbitrum (default fees). <https://github.com/hummusonrails/x402-facilitator> (Read directly)
60. x402 Foundation, x402 repository (README, network docs, SDK changelogs). <https://github.com/x402-foundation/x402> (Read directly)
61. Linux Foundation press release: operational launch of the x402 Foundation. <https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications> (Search summary)
62. CNBC, March 24, 2026: OpenAI revamps shopping in ChatGPT after Instant Checkout. <https://www.cnbc.com/2026/03/24/openai-revamps-shopping-experience-in-chatgpt-after-instant-checkout.html> (Search summary)
63. Merit Systems, x402scan (facilitator configuration). <https://github.com/Merit-Systems/x402scan> (Read directly)
64. Unity Asset Store provider agreement. <https://unity.com/legal/provider> (Search summary)
65. Unity Asset Store terms (refunds). <https://unity.com/legal/as-terms> (Search summary)
66. Epic Games: Unreal Engine Marketplace moves to an 88/12 revenue share. <https://www.unrealengine.com/en-US/blog/epic-announces-unreal-engine-marketplace-88-12-revenue-share> (Search summary)
67. CG Channel, October 2024: Epic Games launches the Fab marketplace. <https://www.cgchannel.com/2024/10/epic-games-launches-its-new-fab-marketplace-in-october-2024/> (Search summary)
68. Envato Author Hub: changes to Envato Market revenue share and exclusivity. <https://author.envato.com/hub/changes-to-envato-market-revenue-share-and-exclusivity-what-you-need-to-know/> (Search summary)
69. WooCommerce Marketplace, getting started for vendors. <https://developer.woocommerce.com/docs/woo-marketplace/getting-started/> (Search summary)
70. GitHub Docs, receiving payment for app purchases. <https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/receiving-payment-for-app-purchases> (Search summary)
71. GitHub Docs, requirements for listing an app. <https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app> (Search summary)
72. Shopify, App Store revenue share. <https://shopify.dev/docs/apps/launch/distribution/revenue-share> (Search summary)
73. Atlassian, updates to Marketplace revenue share 2026. <https://www.atlassian.com/blog/development/updates-to-marketplace-revenue-share-2026> (Search summary)
74. Salesforce, AppExchange checkout revenue share. <https://developer.salesforce.com/docs/atlas.en-us.packagingGuide.meta/packagingGuide/appexchange_checkout_rev_share.htm> (Search summary)
75. JetBrains Marketplace, revenue sharing and fees. <https://plugins.jetbrains.com/docs/marketplace/revenue-sharing-and-fees.html> (Search summary)
76. AWS, January 2024: simplified and reduced Marketplace listing fees. <https://aws.amazon.com/about-aws/whats-new/2024/01/aws-marketplace-simplified-reduced-listing-fees/> (Search summary)
77. GeekWire, 2021: Microsoft drops commercial marketplace fees from 20% to 3%. <https://www.geekwire.com/2021/microsoft-drop-commercial-marketplace-fees-3-20-latest-dig-platform-rivals/> (Search summary)
78. Gumroad pricing. <https://gumroad.com/pricing> (Search summary)
79. Chainguard Academy, containers pricing reference. <https://raw.githubusercontent.com/chainguard-dev/edu/main/content/chainguard/containers/reference/pricing/index.md> (Read directly)
80. Chainguard Academy, Catalog Starter. <https://raw.githubusercontent.com/chainguard-dev/edu/main/content/chainguard/containers/reference/catalog-starter.md> (Read directly)
81. PR Newswire: Chainguard announces 280 million USD growth financing. <https://www.prnewswire.com/news-releases/chainguard-announces-280-million-growth-financing-from-general-catalyst-to-usher-in-next-era-of-trusted-open-source-software-302592279.html> (Search summary)
82. Canonical, Ubuntu Pro pricing. <https://ubuntu.com/pricing/pro> (Read directly)
83. pytest documentation, Tidelift subscription. <https://raw.githubusercontent.com/pytest-dev/pytest/main/doc/en/tidelift.rst> (Read directly)
84. Sonar press release: Sonar to acquire Tidelift. <https://www.sonarsource.com/company/press-releases/sonar-to-acquire-tidelift/> (Search summary)
85. Anthropic, expanded legal protections and API improvements. <https://www.anthropic.com/news/expanded-legal-protections-api-improvements> (Read directly)
86. GitHub, Copilot product-specific terms. <https://github.com/customer-terms/github-copilot-product-specific-terms> (Read directly)
87. Algora source code: payments.ex and user.ex (held charges, fees). <https://raw.githubusercontent.com/algora-io/algora/main/lib/algora/payments/payments.ex> (Read directly)
88. Upwork client pricing. <https://www.upwork.com/pricing/client> (Search summary)
89. Cursor Alternatives, Devin FAQ (third party). <https://cursor-alternatives.com/blog/devin-faq/> (Search summary)
90. Scale AI, Scale's next era: building for 2026. <https://scale.com/blog/scales-next-era-building-for-2026> (Search summary)
91. Scale AI, Pentagon CDAO 500 million USD agreement. <https://scale.com/blog/scale-ai-pentagon-cdao-500-million-agreement> (Search summary)
92. TechCrunch, January 6, 2026: LMArena lands a 1.7 billion USD valuation. <https://techcrunch.com/2026/01/06/lmarena-lands-1-7b-valuation-four-months-after-launching-its-product/> (Search summary)
93. Tech Funding News: a16z leads a 40 million USD round in Vals AI. <https://techfundingnews.com/a16z-leads-40m-vals-ai-round-at-400m-valuation-to-test-ai-on-real-world-tasks/> (Search summary)
94. TechCrunch, January 19, 2025: benchmarking organization criticized for late disclosure of OpenAI funding. <https://techcrunch.com/2025/01/19/ai-benchmarking-organization-criticized-for-waiting-to-disclose-funding-from-openai> (Search summary)
95. arXiv 2504.20879, The Leaderboard Illusion. <https://arxiv.org/abs/2504.20879> (Search summary)
96. OpenAI, why we no longer evaluate SWE-bench Verified. <https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/> (Search summary)
97. Braintrust pricing. <https://www.braintrust.dev/pricing> (Search summary)
98. Inference.net, LangSmith pricing. <https://inference.net/content/langsmith-pricing/> (Search summary)
99. Platform Engineering Cost, Backstage cost. <https://platformengineeringcost.com/backstage-cost> (Search summary)
100. Roadie pricing. <https://roadie.io/pricing/> (Search summary)
101. Port pricing. <https://www.port.io/pricing> (Search summary)
102. Vendr marketplace, Cortex. <https://www.vendr.com/marketplace/cortex> (Search summary)
103. GitHub Blog, July 21, 2026: 100 million USD for open source. <https://github.blog/open-source/maintainers/100-million-for-open-source-a-milestone-built-by-the-community/> (Search summary)
104. Open Source Pledge, join page. <https://raw.githubusercontent.com/opensourcepledge/opensourcepledge.com/main/src/pages/join.astro> (Read directly)
105. Tidelift, 60% of maintainers are still not paid for their work. <https://dev.to/tidelift/60-of-maintainers-are-still-not-paid-for-their-work-35jo> (Search summary)
106. boehs.org, Bountysource. <https://boehs.org/node/bountysource> (Search summary)
107. ERC-8004 specification (Draft). <https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-8004.md> (Read directly)
108. Arbitrum Foundation, AI and Stylus: the builder's new toolkit, February 25, 2026 (read in the author's mirror, file src/content/blog/ai-and-stylus-the-builders-new-toolkit.md). <https://github.com/hummusonrails/personal-site> (Read directly)
109. ERC-8004 contracts repository (deployments, upgradeable registries). <https://github.com/erc-8004/erc-8004-contracts> (Read directly)
110. marsakahenry14-lab, erc8004-forensics README and findings. <https://github.com/marsakahenry14-lab/erc8004-forensics> (Read directly)
111. ERC-8004 contracts issue 99 (quotes arXiv 2606.26028). <https://github.com/erc-8004/erc-8004-contracts/issues/99> (Read directly)
112. ERC-8183 specification (agentic commerce, Draft). <https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-8183.md> (Read directly)
113. Handsel hackathon project, ERC-8004 integration. <https://github.com/abelcml/AI-x-Etherum-Hackthon> (Read directly)
114. Arbitrum docs source, Stylus gentle introduction. <https://github.com/OffchainLabs/arbitrum-docs/blob/master/docs/stylus/gentle-introduction.mdx> (Read directly)
115. Equinox, a Stylus options AMM (README, gas measurements). <https://github.com/nodesproof/equinox> (Read directly)
116. x402 escrow scheme proposal, issue 2222. <https://github.com/x402-foundation/x402/issues/2222> (Search summary)
117. Algora source code: home page (open source tech recruiting). <https://raw.githubusercontent.com/algora-io/algora/main/lib/algora_web/live/home_live.ex> (Read directly)
118. Arbitrum Foundation: Trailblazer, 1 million USD in grants for AI on Arbitrum. <https://blog.arbitrum.foundation/trailblazer-1m-grants-to-power-ai-innovation-on-arbitrum/> (Search summary)
119. Arbitrum Foundation, Builder's Block 023: prizes at Open House Singapore; eGamers: Arbitrum launches a buildathon with a podium spot for Robinhood Chain. <https://blog.arbitrum.foundation/builders-block-023-415k-in-prizes-at-open-house-singapore-apply-now/> (Search summary)
120. Arbitrum Foundation: NYC Founder House concludes with awards to winning teams. <https://blog.arbitrum.foundation/nyc-founder-house-concludes-with-340k-in-awards-to-winning-teams/> (Search summary)
121. Agent0 SDK, chain configuration (agent0-ts contracts.ts). <https://github.com/agent0lab/agent0-ts> (Read directly)

<!-- pagebreak -->

## If I were building Lemma

[INFERENCE] One page, in my own voice.

**I would stop treating the x402 sale as the business.** It is the proof: a public, capped, evidence-gated purchase that anyone can check on Arbiscan (testnet today). It produces the outcomes everything else needs. At 0.39 USDC a sale it will not pay salaries, and I would not plan as if it could.

**I would run the benchmark before anything else.** One frozen probe on a frontier model answers the question that decides the rest: is `S` big enough to price? If it is under 0.30 USDC, I would drop per-sale pricing and keep the preview free.

**I would sell to integration vendors first.** They already spend on developer relations, sample repositories and MCP servers so that agents use their product correctly. Lemma gives them something those budgets cannot buy: measured, tested adoption by agents, per profile, with a refund when it fails. The first catalog is x402 integrations, so the first vendors to call are in the x402 and Arbitrum ecosystem. I would ask one of them for one sponsored release at a price that covers the benchmark, with receipts and breakage alerts as the report.

**I would run a concierge pilot with two engineering teams.** Package one internal integration each as a private release, benchmark it, and charge per month. If neither pays at least the evidence cost, teams wait.

**I would make the attester the brand, and give the numbers away.** Public confidence and ERC-8004 pass rates build trust, and trust is what the market lacks: most on-chain reputation today is ungrounded. I would publish distinct-buyer counts next to every pass rate from day one, never let a sponsor grade itself, and charge for evaluations and alerts, never for reading the number.

**I would not open the marketplace for at least a year.** Liquidity comes from a high fit rate on a few releases, not from many listings. Open supply comes after evidence is cheap and the attester is trusted.

**I would price the warranty from data only when there is data.** Until a profile has hundreds of outcomes, the warranty stays a refund of the price, backed by bond. Insurance-style premiums and underwriting pools come later, after legal advice.

**My kill rules.** Day 30: `S` under 0.30 USDC or fit rate under 10% ends the agent-paid track. Day 60: no vendor or team paying evidence cost ends the paid tracks, and Lemma becomes an open, grant-funded verification tool. Day 90: commit to whichever model earned money after evidence cost.

**The one-line version:** give agents the fit answer for free, let them buy the patch for cents, and charge the organizations that need agents to integrate correctly at scale.
