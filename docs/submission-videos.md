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

## The demo video storyboard, about 4:45

The demo answers the judge's questions in this order: the problem, the user, the gap, the insight, then the live proof (transaction, state change, a failure on purpose, durability), then the cuts, the trade-offs, what is not covered, and the future. Each judge question appears on screen as a chip in the top-left corner while it is answered, so a judge can tick them off.

### Screen layouts

| Layout | What fills the screen |
| --- | --- |
| **Agent** | Claude Code full screen, font 18 pt, in the fixture repository. |
| **Split** | tmux in three panes: left 60%, Claude Code (the agent); top right, the server's log through `jq`, showing only events (`settlement`, `activation`, `outcome`, `refund`); bottom right, the signer's log, later the evaluator's terminal. Each pane has a title bar: "Agent", "Lemma server", "Buyer signer" or "Evaluator". |
| **Browser** | The dashboard or Arbiscan full screen, zoomed to 125%. |
| **Proof** | Terminal on the left half, Arbiscan on the right half, showing the same transaction hash. |
| **Card** | An animated full-screen card in the brand: dark background, mint accents, Lexend. |

### Overlays used throughout

- **Question chip:** top left, mint outline, for example "Who has this problem?". It slides in when a beat starts and fades when it ends.
- **State tracker:** top right, from 1:45 to 3:50, three rows: release score, buyer USDC, bond in the registry. When a number changes it flashes, with the change in green or red ("−0.25", "+0.25").
- **Transaction counter:** under the tracker, "On-chain: 0 of 6", counting settlement, activation and outcome for each of the two purchases. The refund adds a seventh, shown as "+ refund".
- **Hash match:** when a transaction appears, a mint box draws around the hash in the terminal, then the same box around the hash on Arbiscan.
- **Zoom:** a slow 1.0 to 1.4 push-in on the line that matters, for example the `reuse` answer or "Success" on Arbiscan.
- **Time-skip card:** "≈ 1 minute later" over a fast blur, wherever the chain or the evaluator makes us wait.
- **Captions:** every spoken line, burned in at the bottom.

### Shot list

| Time | Judge's question (chip) | What is shown, and how it moves | What is said |
| --- | --- | --- | --- |
| 0:00–0:08 | — | **Card.** The Lemma mark draws itself; the line "Tested integrations your coding agent can reuse, on Arbitrum" types out; a small "Arbitrum Sepolia" badge fades in. | Aryan: "This is Lemma, on Arbitrum." |
| 0:08–0:22 | What is the problem? | **Card, split in three.** Three terminal windows side by side, labelled Team A, B and C. Each types "Adding x402 payment gating…" and the same files appear in each. A token counter in each window climbs (12k, 31k, 58k). Window C ends in red: "✗ 2 tests failed". | "Coding agents keep rebuilding integrations that someone already built and tested. They pay for it in tokens, and it can still fail." |
| 0:22–0:34 | Who has this problem? | **Agent.** The fixture TypeScript MCP server in Claude Code. A callout labels `package.json`: "TypeScript · MCP server · Node 22". The developer types: "add x402 payment gating on Arbitrum Sepolia". | "Our user is a developer whose agent has to add x402 payments to a TypeScript MCP server. Today the agent starts from zero, or copies something from GitHub." |
| 0:34–0:50 | What is missing today? | **Card.** Three question cards drop in: "Does it fit my repo?", "Is it safe to apply?", "Is buying cheaper than building?". Then a grid builds row by row: code search (code ✓, fit ✗, refund ✗), post-failure coverage (fit ✗, refund ✓), Lemma (fit before payment ✓, price capped by saving ✓, refund from a bond ✓). The Lemma row lights mint. | "Code search gives code, not fit. Coverage products refund after something breaks. Nobody answers these three questions before you pay." |
| 0:50–1:05 | What is our insight? | **Browser:** the Benchmark page calculator. The cursor drags the saving; the price cap moves with it; a highlight box rings "at most 30%". | "Our insight: price a release by what it saves. At most thirty percent of the saving a benchmark measured, the buyer keeps at least a quarter, and with no evidence it can't be sold." |
| 1:05–1:25 | How is it better? | **Agent.** The agent calls `lemma_preview` before writing any code. Zoom on the tool call: the profile fields only (capability, runtime, packages). A padlock icon pops over the file tree: "source stays here". Then the answer: `reuse`, the price, evidence, limits, warranty terms; push in on "reuse". | Awaan: "Before writing code, the agent asks Lemma. Only this profile leaves the machine, never the source. The answer is deterministic: no model decides a match or a price. Here it's reuse." |
| 1:25–1:45 | Why on chain? Why Arbitrum? | **Card, then Browser.** A diagram: a coin labelled "USDC, no ETH needed" moves from the agent to the provider; a vault labelled "Warranty registry (Solidity)" holds the bond; one Rust crate splits into two arrows, "Stylus contract" and "Lemma server", both ending at the same score. Then a cut to the two contracts on Arbiscan, with their addresses ringed. | "A refund promise means little if the seller holds the money, so a contract holds the bond. On Arbitrum the agent pays USDC and never needs ETH. We wrote the score once in Rust: the Stylus contract and our server run the same code, so they always agree." |
| 1:45–1:55 | Show the state | **Browser.** Catalog page: the release card's score ringed. Arbiscan: the buyer's USDC and the registry's USDC ringed. The **state tracker** appears top right with all three values. | "Three numbers to watch: the score, the buyer's balance, and the bond." |
| 1:55–2:15 | Show the transaction | **Split.** Left: the agent calls `lemma_buy_resolution`. Bottom right: the signer logs one signature. Top right: the server logs the settlement. **Proof:** the hash ringed in the terminal, then on Arbiscan with "Success" and the USDC transfer buyer → provider, 0.25. Tracker: buyer −0.25. Counter: 1 of 6. | "The agent pays 0.25 testnet USDC over x402. The key lives in a separate signer that checks the limits itself, and the facilitator pays the gas." |
| 2:15–2:30 | Is it durable? | **Split.** The agent is stopped (Ctrl+C) right after paying, then restarted; it calls `lemma_apply_resolution`; the bridge answers that it recovered the purchase. Arbiscan: the buyer's transfers, still one payment, ringed. | "We cut the agent off right after it paid. On restart the bridge recovers the purchase for free. It never pays twice." |
| 2:30–2:45 | Show the state change | **Time-skip card**, then **Browser:** the resolution page (`#/resolutions/<id>`) changes from "pending" to "active"; the activation hash ringed, opened on Arbiscan. Counter: 2 of 6. | "Now the warranty is active: the provider's bond reserves the price for this purchase." |
| 2:45–3:05 | Show the state change | **Split.** The agent applies the patch (the files it writes scroll by), then `lemma_verify_adoption` runs the tests: green "passed". **Time-skip card.** The resolution page shows "passed" with the outcome hash; the Catalog score changes. Tracker: score up, in green. Counter: 3 of 6. | "Applied whole or not at all, the tests passed, and the outcome is recorded on chain. The Stylus contract just moved the score." |
| 3:05–3:25 | One failure on purpose | **Split.** A second fixture repository. A callout: "Same profile, but its tests will fail". Preview, buy (counter: 4 of 6), activation (5 of 6), apply, verify: red "failed". Bottom-right pane becomes the **Evaluator**: `npm run evaluator -w @lemma/server -- list`, then `-- decide <id> failed`. The outcome transaction (6 of 6). Tracker: buyer −0.25, score down, in red. | "Now the case that matters: the patch fits, but this project's tests fail. Our evaluator reviews it and confirms the failure, on chain." |
| 3:25–3:45 | Show the state change | **Split**, then **Proof.** The agent calls `lemma_claim_refund` and the answer reads "refunded". Arbiscan: the withdrawal transaction, 0.25 USDC from the registry to the refund address. Tracker: bond −0.25 in red, and a fourth row appears, "refund address +0.25", in green. Counter: "+ refund". | "The agent claims the refund. The contract pays it from the bond to the buyer's refund address, and the buyer still holds no ETH." |
| 3:45–4:00 | Is it durable? | **Agent, in two halves.** Left half: an agent whose limit is 0.10 USDC tries to buy; the answer is refused with `EXCEEDS_PER_RESOLUTION`, and the signer's log is empty. Right half: an unsupported repository gets a free `build` answer, with no price and no offer. Two red "✗ nothing signed" and "✗ nothing sold" stamps. | "Over the spending limit, nothing is signed. Not a fit, nothing is sold, and checking is always free." |
| 4:00–4:12 | What did we cut? | **Card.** A list with strike-through animating across each item: "Marketplace", "Mainnet", "Fee split", "Public reputation registration". Under it: "First prove the loop: pay → apply → test → refund." | Awaan: "We cut on purpose: no marketplace, no mainnet, no fee split, to prove this loop first." |
| 4:12–4:24 | What did we trade off? | **Card.** A three-column table builds row by row: trade-off, why, what replaces it. "A team key judges failures / ship now / independent evaluators". "Matching reads metadata only / your code never leaves / fewer repositories covered". "One owner key on the contracts / ship now / a multisig". | "And the trade-offs, out loud: a team key judges failures for now, matching reads only metadata so it never sees your code, and one key owns the contracts until a multisig." |
| 4:24–4:34 | What isn't covered yet? | **Card.** An amber list: "Independent evaluators", "Mainnet custody", "Reorg detection in the indexer", "Sandboxed tests on macOS". | "Not covered yet: independent evaluators, mainnet custody, reorg detection, and test sandboxing on macOS." |
| 4:34–4:45 | What comes next? | **Browser:** the home page's On Arbitrum Sepolia section, then a **Card** roadmap line lighting node by node: measured benchmarks, outside providers, independent evaluators, audit, Arbitrum One. End on the logo, the dashboard URL and the GitHub link. | Aryan: "Next: measured benchmarks so releases go on sale, outside providers, an audit, then Arbitrum One. Lemma: agents stop paying to rediscover solved work." |

### What to set up before recording

1. **The server** runs on the recording machine against Arbitrum Sepolia: `e2e/live/serve.ts` with the demo catalog, `EVALUATOR_FAILURES=review`, and `WARRANTY_ACTIVATION_BATCH_SECONDS=0` with `WARRANTY_ACTIVATION_JITTER_SECONDS=0`.
2. **The signer:** `lemma-signer serve`, with its log in the bottom-right pane.
3. **Claude Code:** the bridge is configured with `LEMMA_API_URL` pointing at that server, the three spending variables, and `LEMMA_REFUND_TO`. A second configuration sets `LEMMA_MAX_USDC_PER_RESOLUTION=100000` for the refusal shot.
4. **Three fixture repositories:** one the release fits whose tests pass, one it fits whose tests fail, and one it does not fit.
5. **Funds:** at least 0.50 testnet USDC on the buyer for two purchases (top up from Circle's faucet), and at least 0.50 USDC of free bond in the registry.
6. **Browser tabs:** dashboard Catalog, Benchmark, the resolution page, Arbiscan for the buyer, the registry, and the refund address.
7. **Rehearse the lost-answer shot** (stop the agent right after the signer logs). If it does not recover cleanly in rehearsal, cut that beat and keep the spend-limit refusal.
8. **Test an empty buyer balance.** If the bridge handles it cleanly, mention it at 3:45; if not, add it to the 4:24 list.
9. **Record each beat as its own take.** Assemble them in an editor (DaVinci Resolve, CapCut or Descript), then add the overlays and the cards.

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
