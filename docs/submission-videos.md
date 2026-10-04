# Submission Videos

How to record the two videos for the Arbitrum Open House Singapore online buildathon on HackQuest. Facts in the first section come from the buildathon's HackQuest page, read on 2026-10-04. The rest is our plan. [Demo Script](demo-script.md) is still the source for claims we can and cannot make.

## What the buildathon asks for

- **Deadline:** submissions close **2026-10-04 23:59 SGT** (15:59 UTC, 21:29 IST). Winners are announced on 2026-10-12. The top three teams get a place at Founder House in Singapore, 23 to 25 October.
- **Prizes:** the Overall Prize pays 40,000, 20,000 and 10,000 USDC. The Promising Products Track pays 7,000, 5,000 and 3,000 USDC. Up to 30,000 USDC goes out as milestone grants. Every prize is paid against development milestones.
- **Qualifying rule:** the project must be deployed on an Arbitrum chain. Arbitrum Sepolia counts.
- **Judging criteria:** smart contract quality, product-market fit, innovation and creativity, and real problem solving. Projects that integrate Paxos' USDG get extra consideration. At least one of the three Overall prizes goes to a Robinhood Chain project, and at least one goes to an Arbitrum project.
- **HackQuest project fields:** a **Pitch Video**, a **Demo Video**, the GitHub repository, progress during the hackathon, and fundraising status. Each video can be an uploaded file or a YouTube or Loom link. HackQuest sets no length for this buildathon; its general guide asks for a demo of 2 to 5 minutes that shows the contract interaction and the UI ([HackQuest best practices](https://www.hackquest.io/blog/Best-Practices-for-Successful-Web3-Hackathon-Project-Submissions)).
- **Buildathon form fields:** frontend link, core contract addresses (`network: address — label`, at most 300 characters), factory contracts, token contract, which code was written during the buildathon (at most 300 characters), and sponsor technologies.

## Hard constraints

- **Demo video:** required. HackQuest's checklist says at most 5 minutes, and a missing demo video, contract address or explorer link "can lead to disqualification". The demo must show the contract interaction, the UI and the working features ([HackQuest best practices](https://www.hackquest.io/blog/Best-Practices-for-Successful-Web3-Hackathon-Project-Submissions)).
- **Pitch video:** its own field on the project. Neither this buildathon nor HackQuest sets a length or a content rule for it. Past winners kept it between 2 and 5 minutes.
- **Both:** an uploaded file or a public YouTube or Loom link. HackQuest asks for a new upload for each hackathon, so don't reuse another event's video. Neither may need a login to watch.
- **Not checked:** the buildathon's Terms and Conditions PDF sits behind a browser check and could not be read here. Open it before you submit: <https://openhouse.arbitrum.io/singapore_version_open_house_buildathon_terms___conditions.pdf>.

## What the judges say they look for

Ben Greenberg (@hummusonrails), Arbitrum DevRel and a frequent Open House judge, wrote the most useful guide ([article](https://x.com/hummusonrails/status/2098064078438866979), linked from Builder's Block #026):

- Judges assume AI wrote much of the code. They score your decisions: a narrow problem for a named user, why it must be on chain and on Arbitrum, what you cut, and which tradeoffs you made, said out loud.
- "Run it live where you can. A recording only proves the run you chose to record." Judges ask what happens with another wallet, an empty balance, two users at once, or a transaction that fails halfway.
- "The demo itself should hit a real network, and include one failure on purpose. Show the transaction. Show the state change. Then show what the user sees when something goes wrong, and say which failure modes you have not covered yet."
- The README should say what works and what does not, with explorer links, and tests should cover the hard path.

## What past winners sent

Lengths from the winners' HackQuest project pages, read on 2026-10-04:

| Buildathon | Winner | Pitch | Demo |
| --- | --- | --- | --- |
| NYC, 1st | Tilt Protocol | 2:42 | 3:25 |
| London, 1st open | Verus | 4:45 | 4:50 |
| London, 2nd open | Capricorn | 3:13 | 3:34 |
| London, 1st agentic | ReineiraOS, "bonded x402" | 2:39 | 1:58 |
| London, 3rd agentic | Pact Network, refunds for x402 payments | 2:11 | 1:37 |

Two London agentic winners are close to Lemma: ReineiraOS backs agent commitments with a bond, and Pact Network refunds an agent when a paid x402 API fails. The judges have seen both, so the pitch must say what is different: Lemma answers "does this fit, and is it worth buying" **before** any money moves, and its bond covers a tested integration in the buyer's own repository, not an API call. Pact's pitch followed problem, customer interviews, how it works, business model, market size, traction, ask. Its demo was a dashboard, one call failing live, and the refund landing.

## How the two videos differ

| | Pitch video | Demo video |
| --- | --- | --- |
| Question it answers | Why should this exist, and why are we the team to build it? | Does it work on Arbitrum, and does it hold up when something goes wrong? |
| Criteria it scores | Product-market fit, real problem solving, innovation | Smart contract quality, deployed on Arbitrum, innovation |
| Viewer | Arbitrum Foundation ecosystem and grants people choosing who goes to Founder House and gets milestone money | Technical judges checking the build |
| What is on screen | An animated video with a light music bed and two voices over it | The real product: the agent, the terminal, the dashboard, Arbiscan |
| Tone | The decisions: the wedge, why on chain and on Arbitrum, what we cut, what we traded | Proof: one task end to end, every transaction and state change on screen, one failure on purpose |
| Length | About 2:30 | 3:30 to 4:00, never past 5 |
| Mistake to avoid | Spending a minute on architecture | Spending a minute on slides |

Both videos have to stand alone. A judge may watch only one, so each opens with the one-line hook and says "on Arbitrum" in its first 20 seconds.

## The judge's questions, and which video answers each

Every question from Ben Greenberg's article has one home. A question the pitch answers gets one line in the demo at most, and the other way round.

| Judge's question | Pitch | Demo | Lemma's answer |
| --- | --- | --- | --- |
| The problem, one narrow one | 0:10 | 0:00 | Agents pay to rebuild integrations someone already built and tested, and can still fail the tests. |
| One identifiable group of users | 0:10 | 0:00 | A developer whose coding agent must add x402 payments to a TypeScript MCP server (the first capability in the catalog). |
| What they do today | 0:10 | — | The agent builds from zero, or copies old code from GitHub without knowing whether it fits. |
| Specific unmet need | 0:30 | — | An answer before spending: does it fit my repository, is it safe to apply, is buying cheaper than building? |
| Gap in current solutions | 0:30 | — | Code search gives code, not fit. Coverage products such as Pact Network refund after a failure. Nobody answers before payment, or prices by measured saving. |
| Solved better than what exists | 0:48 | 0:15 to 2:50 | Fit checked before payment, price capped by measured saving, failure refunded from a bond. |
| Team capability and insight | 1:35 | — | Your team line (to fill in), and the insight: price a release by the saving a benchmark measured, and never sell without that evidence. |
| Why on chain | 1:12 | 1:20 | A refund promise means little if the seller holds the money. The registry contract holds the bond and pays refunds; outcomes are public. |
| Why Arbitrum, why Stylus | 1:12 | 2:05 | The agent pays USDC and holds no ETH; a whole purchase costs under 0.00002 testnet ETH of gas. The score is written once in Rust: the Stylus contract and the server run the same crate, so the catalog and the chain always agree. |
| Priorities: what we cut | 1:52 | — | One first-party provider, not a marketplace. Testnet only. No fee split. ERC-8004 registration waits for a public server URL. |
| Trade-offs, said out loud | 1:52 | 3:20 | A team key decides failures (independent evaluators later). Matching reads metadata only, so it covers fewer repositories but never sees source. The contracts have one owner key (a multisig later). |
| Show the transaction | — | 1:20 to 2:50 | Settlement, warranty activation, outcome, refund, each opened on Arbiscan. |
| Show the state change | — | 0:45, 2:05, 2:50 | Release score, the buyer's balance and the registry's bond, shown before and after. |
| One failure on purpose | — | 2:20 | A repository whose tests fail, refunded from the bond. |
| Durability: what is handled | — | 3:05 | Lost paid answer recovered without paying twice; a purchase over the spend limit refused before signing; wrong recipient refused; two bridges cannot both spend; a failed apply rolls back. |
| Failure modes not covered yet | — | 3:20 | Independent evaluation, mainnet custody, reorg detection in the indexer, sandboxed tests on macOS. Check an empty buyer balance before recording; if it is not handled cleanly, list it here. |
| Future plan | 2:15 | 3:35 | Measured benchmarks so releases go on sale, outside providers, independent evaluators, ERC-8004 reputation, an audit, then Arbitrum One. |

## The pitch video, about 2:30

An animated video built from the brand (dark background, mint accents, Lexend headings), with a light music bed. Two people record the voice-over on top. Speaker 1 carries the problem, the users, the team and the proof; Speaker 2 carries the product, Arbitrum and the decisions. About 330 words, so read at an even pace.

| Time | Speaker | What to say | What is shown |
| --- | --- | --- | --- |
| 0:00 | 1 | "Coding agents keep paying to rebuild integrations that someone already built and tested. Lemma lets them reuse that work, with a refund if it fails." | Three agent terminals building the same "x402 payment gating" side by side, token counters climbing, one ending in "tests failed". Cut to the Lemma logo. |
| 0:10 | 1 | "I'm [Name 1], with [Name 2]. Our user is a developer whose agent has to add x402 payments to a TypeScript MCP server. Today the agent starts from zero, or copies old code from GitHub. Either way it burns tokens, and it can still fail the tests." | A user card: "TypeScript MCP server · Claude Code or Cursor · needs x402 payments". Two paths, "build from zero" and "copy from GitHub", both ending at "tests may fail". |
| 0:30 | 1 | "What's missing isn't code. It's an answer before you spend: does this fit my repo, is it safe to apply, and is buying cheaper than building? Code search gives you code, not fit. Coverage products refund you after a failure. Nobody answers before you pay." | Three question cards, then a comparison grid: code search, post-failure coverage, Lemma, against "checks fit before payment", "price capped by saving", "refund from a bond". |
| 0:48 | 2 | "I'm [Name 2]. The agent sends a short profile: language, versions, packages, never source. Lemma answers deterministically: reuse, adapt, build or decline. If a tested patch fits, the agent buys it for cents in USDC over x402, applies it whole or not at all, and runs its tests locally. A failure is refunded from the provider's bond." | A profile card leaves the repository (the source stays behind a lock), reaches Lemma, and "reuse" lights up. Then the four steps light in turn: check, buy, apply and test, covered. |
| 1:12 | 2 | "It's on chain because a refund promise means little if the seller holds the money. A registry contract holds the bond and pays refunds. On Arbitrum, the agent pays in USDC and never holds ETH. And we wrote the score in Rust for Stylus, so the same code runs on chain and in our server, and they always agree." | Three cards: warranty registry (Solidity), USDC over x402, score engine (Stylus, Rust). One Rust crate splits into "Stylus contract" and "server wasm", both showing the same score. "A whole purchase: under 0.00002 testnet ETH of gas." |
| 1:35 | 1 | "[One sentence: who we are and what we've built before that makes us the team for this.] Our insight: price a release by what it saves. It costs at most thirty percent of the saving a benchmark measured. No evidence, no sale." | Two team cards with names and roles. A bar: measured saving, the 30% price cap, what the buyer keeps. Labelled "worked example". |
| 1:52 | 2 | "We cut on purpose: one provider, not a marketplace, and testnet only, to prove the loop first. And the trade-offs, out loud: a team key judges failures for now. Matching reads only metadata, so it covers fewer projects but never sees your code. And one owner key, until a multisig." | "Cut" list with strike-through: marketplace, mainnet, fee split. A table "trade-off → why → next": team evaluator → independent evaluators; metadata only → privacy; one owner key → multisig. |
| 2:15 | 1 | "It's live today: two real purchases on Arbitrum Sepolia. One passed. One failed, and was refunded on chain. Next: measured benchmarks, outside providers, independent evaluators, an audit, then Arbitrum One. Lemma: agents stop paying to rediscover solved work." | Two transaction cards, "passed" and "refunded 0.25 testnet USDC", with Arbiscan hashes. A roadmap line. The logo, the dashboard URL and the GitHub link. |

## The demo video, about 3:45

A screen recording with a voice-over, ideally one live run on Arbitrum Sepolia. Record at 1080p or higher, with the terminal font at 18 pt or more and the browser zoomed to 125%. Cut every wait; for an on-chain wait, show a "1 minute later" card instead of real time. Speaker 2 can narrate the whole demo, or the two can split it at the failure.

| Time | What is shown | What is said |
| --- | --- | --- |
| 0:00 | The fixture repository in Claude Code or Cursor, with the bridge connected. The prompt: "add x402 payment gating on Arbitrum Sepolia". | "Lemma on Arbitrum: one agent task, start to finish. Our user's agent needs x402 payments on this MCP server." |
| 0:15 | The agent calls `lemma_preview` before writing code. The request's profile fields, then the `reuse` answer: price, evidence, limits, warranty terms. | "First, a free check. Only this profile leaves the machine, never the source. Same profile, same answer: no model decides a match or a price." |
| 0:45 | **State before.** The release's card on the Catalog page with its score; the buyer's USDC and the registry's bond on Arbiscan. | "Remember three numbers: the release's score, the buyer's balance, and the bond." |
| 1:00 | The bridge's checks (network, asset, recipient, limit, window); the signer signs; the agent holds no ETH. | "The key lives in a separate signer that enforces the spend limits itself. The model never touches it." |
| 1:20 | **Transaction:** the settlement on Arbiscan, USDC from the buyer to the provider. | "Paid in USDC over x402. The facilitator paid the gas." |
| 1:35 | **Durability:** the paid answer is dropped on purpose, then recovered, with still only one payment on Arbiscan. | "We lost the answer after paying. The bridge recovers it, and never pays twice." |
| 1:50 | **Transaction and state change:** the resolution page goes from pending to active; the activation transaction reserves the price from the bond. | "The warranty is live: the provider's bond now backs this purchase." |
| 2:05 | Apply and test; the receipt is signed; the page shows passed; the outcome transaction records into the Stylus engine; **the score changes** on the Catalog. | "Applied whole or not at all, tests passed, and the Stylus contract updated the score from this outcome." |
| 2:20 | **The failure on purpose:** a second repository fails its tests; the evaluator decides failed. | "Now the case that matters: the patch fits, but this project's tests fail." |
| 2:50 | **Transaction and state change:** `lemma_claim_refund`, the withdrawal on Arbiscan, the refund address up 0.25 testnet USDC, the bond down by the same amount. | "Refunded from the bond, on chain. The buyer never needed ETH." |
| 3:05 | A purchase over the spend limit, refused before anything is signed; an unsupported repository gets a free `build` answer with no price. | "Over the limit, nothing is signed. Not a fit, nothing is sold." |
| 3:20 | Text on screen: what is handled, and what is not covered yet. | "Not covered yet: a team key decides failures, it's testnet only, and the indexer doesn't detect reorgs." |
| 3:35 | The home page's On Arbitrum Sepolia section, the roadmap, the links. | "Next: measured benchmarks, outside providers, an audit, then Arbitrum One." |

### Where each part of the demo comes from

Decide this before you record. The hosted server previews for free but sells nothing yet ([README](../README.md#where-it-stands)).

1. **Best: run the live purchase again on Arbitrum Sepolia.** If the machine and role keys from the 2026-10-01 run still exist, run `e2e/live/serve.ts` and `e2e/live/agent.ts adopt pass`, then `adopt fail` and `refund`, as in [e2e/README.md](../e2e/README.md#live-run-on-arbitrum-sepolia). Set `WARRANTY_ACTIVATION_BATCH_SECONDS=0` so activations don't wait an hour. This gives new transactions, recorded on video.
2. **Fallback: the recorded run.** Show the live free preview against the hosted server, then walk through the 2026-10-01 transactions on Arbiscan and the [deployment record](deployments/arbitrum-sepolia.md). Then run `npm run e2e` in a terminal, sped up, as the full flow on a local chain, and say plainly that it is a local chain with a stand-in engine.

Either way, say on screen that the amounts are testnet USDC and that the release sold uses made-up benchmark evidence labelled `demo-1`.

## Claims to keep straight in both videos

- Say "testnet USDC" for every amount that moved on chain. The dashboard's own pages keep saying "USDC"; the narration and captions add "testnet".
- The pricing table is a worked example, not a measured saving. No frozen benchmark result exists yet.
- One first-party provider, not a marketplace. A team key is the evaluator for failures.
- ERC-8004 reputation is built and tested locally but not registered on the testnet yet.
- The Stylus engine ran on Arbitrum Sepolia. In `npm run e2e` it is a Solidity stand-in.

## Recording checklist

- Script every line and read it at an even pace; two minutes of speech is about 300 words.
- Record the screen at 1080p, 30 fps, with notifications off, a clean browser profile, and no wallet extension or key on screen.
- Before each take, check that no terminal output prints a key, an RPC URL with a key in it, or a personal path. Blur any that slip through.
- Add captions; many judges watch without sound.
- Upload both to YouTube as unlisted (or Loom), check that they play signed out, and paste the links into the HackQuest Pitch Video and Demo Video fields.
- Put the same links in the README so the repository and the submission point to each other.

## Form answers to paste

- **Frontend:** `https://lemma-production-8383.up.railway.app`
- **Core contracts:** `Arbitrum Sepolia: 0x0B0FdF70AD27B3404Bd4C7f317f56c2388305F14 — Warranty registry` and `Arbitrum Sepolia: 0x0ede0baf8b11b256fb1c3bfd678a2087188d44b6 — Stylus score engine`
- **Factory or pool contracts:** N/A
- **Token contract:** N/A. Lemma uses Circle's USDC and issues no token.
- **Written during the buildathon:** all of it. The repository starts on 2026-09-24 with its first commit, and every pull request since is in the history.
- **Sponsor technologies:** OpenZeppelin (the registry builds on OpenZeppelin contracts).
