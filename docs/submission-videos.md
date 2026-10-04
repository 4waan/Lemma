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

The demo carries the judge's questions and the proof. The pitch carries the business. They share the one-line hook and nothing else.

| | Pitch video | Demo video |
| --- | --- | --- |
| Question it answers | Why does this become a business, and why now? | What did we decide, and does it hold up on Arbitrum? |
| Content | Vision, the waste at scale, the product in plain words, why now, business model, how it grows, traction, team, the ask | The wedge, the gap, why on chain and Stylus, what we cut, the trade-offs, then one live run with its transactions, state changes, a failure on purpose, and what is not covered yet |
| Criteria it scores | Product-market fit, real problem solving, innovation | Smart contract quality, deployed on Arbitrum, real problem solving |
| Viewer | Arbitrum Foundation ecosystem and grants people choosing who goes to Founder House | Technical judges checking the build and the decisions |
| What is on screen | Animation only, with a light music bed and two voices | The real product: the agent, the terminal, the dashboard, Arbiscan |
| Technical words | None beyond "x402", "USDC" and "Arbitrum" | As many as the step needs |
| Length | About 2:30 | About 4:35, never past 5 |
| Speakers | Aryan Singh Rathore and Awaan Mustafa Siddiqui, alternating | Aryan frames the problem and the close; Awaan drives the product |

## The pitch video, about 2:30

An animated video in the brand (dark background, mint accents, Lexend headings) with a light music bed. Aryan and Awaan record the voice-over on top. About 340 words.

| Time | Speaker | What to say | What is shown |
| --- | --- | --- | --- |
| 0:00 | Aryan | "Software is starting to pay software. Coding agents already write a big share of our code, and with x402 they can pay for what they use. So what should they buy? I'm Aryan, co-founder of Lemma." | Agents as small nodes, USDC moving between them. Three lines appear: "Agents write code. Agents can pay. What should they buy?" |
| 0:14 | Aryan | "Today, nothing. Every agent rebuilds the same integrations from scratch: payments, auth, the same glue code, team after team. Eighty-four percent of developers use or plan to use AI tools, and their agents keep repeating work someone already finished." | A grid of terminals multiplying, all building the same integration, token counters climbing. A stat card: "84% of developers use or plan to use AI tools", source "Stack Overflow Developer Survey 2025". |
| 0:34 | Awaan | "I'm Awaan. Lemma turns solved work into something an agent can buy. Before writing code, the agent asks Lemma. If a tested integration fits the project, it buys it for cents, applies it, and runs the tests. If they fail, it gets its money back." | Four plain icons in a row: Ask, Buy, Apply, Guaranteed. |
| 0:56 | Awaan | "And this only works now. Agents plug into tools through MCP in every major editor. x402 lets them pay in USDC. And Arbitrum makes it cheap to pay per task and to back every sale on chain." | Three "why now" tiles: MCP (Cursor, VS Code, Claude Code, Codex, Goose), x402 and USDC, Arbitrum. |
| 1:12 | Aryan | "The model is simple. Developers who solved an integration publish it with a bond behind it. Agents pay per use, never more than thirty percent of what it saves them. Providers earn every time their work is reused, Lemma will keep a ten percent fee, and a release that fails is refunded from its provider's bond." | Three parties, provider, Lemma and agent, with arrows for bond, payment, the 90/10 split and the refund. A small label: "fee after validation". |
| 1:35 | Aryan | "And every free check tells us what agents need next. We start with what Arbitrum's agent builders need most, x402 payments, then build whatever agents ask for. More outcomes, better scores, more trust." | A flywheel: free checks, demand, new releases, outcomes on chain, better scores, more agents. |
| 1:52 | Awaan | "It's live today. One click installs Lemma in Cursor, VS Code, Goose, Claude Code and Codex. And on Arbitrum Sepolia, an agent made two real purchases: one passed, one failed and was refunded on chain." | Editor names as chips. Two transaction cards: "passed" and "refunded 0.25 testnet USDC". |
| 2:10 | Aryan | "We're Aryan and Awaan, and we built all of this in under two weeks. At Founder House, we want to sign our first outside providers and paying teams, and take Lemma to Arbitrum One. Lemma: agents stop paying to rediscover solved work." | Two founder cards. The ask as three lines. The logo, the dashboard URL and the GitHub link. |

## The demo video, about 4:35

The demo follows Ben Greenberg's article: the decisions first, spoken over the real product rather than slides, then one live run on Arbitrum Sepolia, then the limits. Record at 1080p or higher, with the terminal font at 18 pt or more and the browser zoomed to 125%. Cut every wait; for an on-chain wait, show a "1 minute later" card instead of real time.

| Time | Judge's question | What is shown | What is said |
| --- | --- | --- | --- |
| 0:00 | The problem, one user | The fixture TypeScript MCP server in Claude Code or Cursor, with the prompt "add x402 payment gating on Arbitrum Sepolia". | Aryan: "This is Lemma, on Arbitrum. Our user is a developer whose coding agent has to add x402 payments to a TypeScript MCP server. Without Lemma, the agent starts from zero, burns tokens, and can still fail the tests." |
| 0:20 | What exists, the gap, the unmet need | The agent about to write code; a code search full of similar repositories. | "Copying from GitHub gives code, not fit. Coverage products refund after something breaks. What the developer needs is an answer before paying: does this fit my repository, is it safe, is buying cheaper than building?" |
| 0:40 | Team insight | The Benchmark page calculator. | "Our insight: price a release by what it saves. It costs at most thirty percent of the saving a benchmark measured, the buyer still saves a quarter or more, and without evidence it can't be sold." |
| 1:00 | Solved better | `lemma_preview` runs before any code: the profile fields it sends, then the `reuse` answer with price, evidence, limits and warranty terms. | Awaan: "The first check is free. Only this profile leaves the machine, never the source, and the answer is deterministic: no model decides a match or a price." |
| 1:20 | Why on chain, why Arbitrum, why Stylus | The two contracts on Arbiscan; `contracts/stylus` and `packages/confidence` side by side. | "A refund promise means little if the seller holds the money, so a registry contract holds the bond. The agent pays USDC and never holds ETH. We wrote the score once in Rust: the Stylus contract and our server run the same crate, so they always agree." |
| 1:40 | State before | The release's score on the Catalog page; the buyer's USDC and the registry's bond on Arbiscan. | "Three numbers to watch: the score, the buyer's balance, the bond." |
| 1:55 | Show the transaction | The bridge's checks (network, asset, recipient, limit, window); the signer signs; the settlement on Arbiscan. | "The key lives in a separate signer that enforces the limits itself. Paid in USDC over x402, and the facilitator paid the gas." |
| 2:15 | Durability | The paid answer dropped on purpose and recovered; still one payment on Arbiscan. | "We lost the answer after paying. The bridge recovers it and never pays twice." |
| 2:30 | Show the state change | The resolution page goes from pending to active; the activation transaction reserves the price from the bond. | "The warranty is live: the provider's bond now backs this purchase." |
| 2:45 | State change | Apply, tests pass, the receipt is signed, the outcome transaction records into the Stylus engine, and the score changes on the Catalog. | "Applied whole or not at all, tests passed, and the Stylus contract updated the score." |
| 3:05 | One failure on purpose | A second repository fails its tests; the evaluator decides failed. | "Now the case that matters: the patch fits, but this project's tests fail." |
| 3:25 | Transaction and state change | `lemma_claim_refund`; the withdrawal on Arbiscan; the refund address up 0.25 testnet USDC and the bond down by the same. | "Refunded from the bond, on chain, and the buyer never needed ETH." |
| 3:40 | Durability | A purchase over the spend limit refused before signing; an unsupported repository gets a free `build` answer with no price. | "Over the limit, nothing is signed. Not a fit, nothing is sold." |
| 3:55 | Priorities and trade-offs | Text over the dashboard: what we cut and the trade-offs, each with its reason. | "We cut the marketplace and mainnet to prove this loop first. A team key judges failures for now; matching reads metadata only, so it covers fewer projects but never sees code; the contracts have one owner key until a multisig." |
| 4:10 | Failure modes not covered yet | Text on screen. | "Not covered yet: independent evaluators, mainnet custody, reorg detection in our indexer, and sandboxed tests on macOS." |
| 4:20 | Future plan | The home page's On Arbitrum Sepolia section, the roadmap, the links. | Aryan: "Next: measured benchmarks so releases go on sale, outside providers, an audit, then Arbitrum One." |

Check an empty buyer balance before recording. If the bridge does not handle it cleanly, add it to the 4:10 list.

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
