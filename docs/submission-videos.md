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
| Content | Vision, the waste at scale, the product in plain words, why now, business model, how it grows, traction, team, the ask | The wedge, the gap, why on chain and Stylus, then the 1 October run on Arbiscan with its transactions, state changes and the failure that was refunded, what still holds today, what we cut, the trade-offs, and what is not covered yet |
| Criteria it scores | Product-market fit, real problem solving, innovation | Smart contract quality, deployed on Arbitrum, real problem solving |
| Viewer | Arbitrum Foundation ecosystem and grants people choosing who goes to Founder House | Technical judges checking the build and the decisions |
| What is on screen | Animation only, with a light music bed and two voices | The real product: the agent, the terminal, the dashboard, Arbiscan |
| Technical words | None beyond "x402", "USDC" and "Arbitrum" | As many as the step needs |
| Length | About 3:09 | About 4:30, never past 5 |
| Speakers | Aryan Singh Rathore and Awaan Mustafa Siddiqui, alternating | Aryan frames the problem and the close; Awaan drives the product |

## The pitch video: ten questions, about 3:09

The pitch runs as questions and answers. Each question fills the screen for two seconds with a soft chime and no voice, then shrinks to a chip in the top-left corner while Aryan or Awaan answers it. A row of ten dots along the bottom shows which question is being answered. Built in Remotion, rendered at 1920×1080 and 30 fps, with a light music bed and burned-in captions. About 370 spoken words. The project, its renders and the voice-recording steps are in [`media/pitch-video`](../media/pitch-video/README.md).

| Time | On screen: the question | Speaker | What is said | What is shown during the answer |
| --- | --- | --- | --- | --- |
| 0:00–0:05 | — | — | (music only) | The Lemma mark draws itself; "Lemma, in ten questions" fades in; an "Arbitrum" badge. |
| 0:05–0:23 | **1. What's changing in software?** | Aryan | "Software is starting to pay software. Coding agents already write a big share of our code, and with x402 they can pay for what they use. So what should they buy? I'm Aryan, co-founder of Lemma." | Small agent nodes appear and connect; USDC coins travel between them. Three lines stack: "Agents write code." "Agents can pay." "What should they buy?" |
| 0:23–0:43 | **2. What's the problem?** | Aryan | "Today, nothing. Agents rebuild the same integrations from scratch, team after team. They burn tokens, and the result can still fail its tests. Eighty-four percent of developers now use or plan to use AI tools, so this waste grows every day." | One terminal splits into 4, then 16, all typing the same integration; token counters climb; a few flash red "✗ tests failed". A stat card: "84%", source "Stack Overflow Developer Survey 2025". |
| 0:43–0:58 | **3. Who feels it first?** | Aryan | "Developers building paid agent tools. Their agent has to add x402 payments to an MCP server: the same few files every time, and easy to get wrong." | A user card builds: "TypeScript MCP server", "Claude Code or Cursor", "needs x402 payments". The same three file names repeat across several faded repositories. |
| 0:58–1:20 | **4. What is Lemma?** | Awaan | "I'm Awaan. Lemma turns solved work into something an agent can buy. Before writing code, the agent asks Lemma. If a tested integration fits the project, it buys it for cents, applies it, and runs the tests. If they fail, it gets its money back." | Four plain icons light up in turn as they are named: Ask, Buy, Apply and test, Money back. |
| 1:20–1:37 | **5. Why now, and why Arbitrum?** | Awaan | "Agents now plug into tools through MCP in every major editor. x402 lets them pay in USDC. And Arbitrum is cheap enough to settle every purchase, and back it with a bond, on chain." | Three tiles slide in: "MCP" with the five editor names, "x402 and USDC", "Arbitrum: purchases and bonds on chain". |
| 1:37–2:02 | **6. How does it make money?** | Aryan | "Developers who solved an integration publish it with a bond behind it. Agents pay per use, never more than thirty percent of what it saves them. Providers earn every time their work is reused, Lemma will keep a ten percent fee, and a release that fails is refunded from its provider's bond." | Three parties, provider, Lemma and agent. Arrows animate: the bond into a vault; the payment from the agent; a 90/10 split; a refund arrow back from the vault. A bar shows the saving with the 30% cap marked. A small label: "fee after validation". |
| 2:02–2:20 | **7. How does it grow?** | Aryan | "Every free check tells us what agents need next. We start with x402 payments for Arbitrum's agent builders, then build whatever agents ask for most. More outcomes mean better scores, and better scores bring more agents." | A flywheel turns once per phrase: free checks, demand, new releases, outcomes on chain, better scores, more agents. |
| 2:20–2:38 | **8. What's real today?** | Awaan | "Lemma is live. One click installs it in Cursor, VS Code, Goose, Claude Code and Codex. On Arbitrum Sepolia, an agent made two real purchases: one passed, one failed and was refunded on chain." | Five editor chips. Two transaction cards slide in: "Purchase 1: passed" and "Purchase 2: refunded 0.25 testnet USDC", each with its Arbiscan hash. A small label: "Arbitrum Sepolia testnet, 2026-10-01". |
| 2:38–2:48 | **9. Who's building it?** | Awaan | "Aryan and I. We built all of Lemma in under two weeks, during this buildathon." | Two founder cards: "Aryan Singh Rathore, Co-founder" and "Awaan Mustafa Siddiqui, Co-founder". A line: "First commit 24 Sep 2026". |
| 2:48–3:03 | **10. What do we need?** | Aryan | "At Founder House, we want to sign our first outside providers and paying teams, and take Lemma to Arbitrum One. Lemma: agents stop paying to rediscover solved work." | Three ask lines tick in: "First outside providers", "First paying teams", "Arbitrum One". Then the closing line in large type. |
| 3:03–3:09 | — | — | (music swells and fades) | The logo, the dashboard URL and the GitHub link. |

Each answer is timed to about 2.4 spoken words a second. If a take runs long, the answer's scene stretches to fit and the next question starts after it.

### How the pitch gets made

1. **Visuals:** the Remotion project in `media/pitch-video` renders the cards, the question chips, the animations and the captions. Remotion is free for individuals and companies of up to three people, so the two of us need no license.
2. **Music:** an original bed synthesized from the same timeline (`scripts/music.mjs`), with a chime on each question and a dip under each answer, so it has no licensing questions.
3. **Voice:** Aryan and Awaan each record their answers while watching the guide render (`lemma-pitch-guide.mp4`, a teleprompter with countdowns), one file per answer, `q1.m4a` to `q10.m4a`. QuickTime's New Audio Recording is enough.
4. **Assembly:** `node scripts/mix-voices.mjs <voice folder>` places each file at its answer, cleans and levels the voices, lowers the music, and writes the final MP4 with ffmpeg alone.

## The demo video: the recorded run, about 4:30

Decided on 2026-10-04: the demo uses the 1 October run on Arbitrum Sepolia, shown through the dashboard and Arbiscan, plus what can run live today: the free preview against the hosted server, the read-only contract check, and the durability tests. Nothing is staged. Every terminal shot replays output captured from a real run on 2026-10-04, and every browser shot is the live dashboard or Arbiscan. Aryan narrates the problem and the close; Awaan narrates the product and the proof.

Each beat opens with the judge's question as a short card (1.4 s), which then stays as a chip in the top-left corner. From the first transaction on, a tracker in the top-right corner holds three numbers from the deployment record: the buyer's USDC, the USDC in the registry, and the refund address's USDC.

| # | Judge's question (chip) | Speaker | What is shown | Source |
| --- | --- | --- | --- | --- |
| 0 | — | — | Card: "Lemma, the demo". Labels: "Recorded run: Arbitrum Sepolia testnet, 2026-10-01" and "Live today: free preview, contract check". | Animation |
| 1 | What's the problem? | Aryan | Three agent terminals side by side build the same x402 payment gating; token counters climb; one ends "✗ tests failed". | Animation |
| 2 | Who has it? | Aryan | The `weather-mcp` repository: its file tree and `package.json` (TypeScript, MCP SDK, Node 22, npm). Callout: "our first user". | Terminal replay |
| 3 | What's missing today? | Aryan | Grid: code search, post-failure coverage, Lemma, against "checks fit before payment", "price capped by measured saving", "refund from a bond". | Animation |
| 4 | What's our insight? | Aryan | The dashboard's Benchmark page: the pricing calculator, the 30% cap ringed. | Browser |
| 5 | What leaves your machine? | Awaan | Split. Left: the agent calls `lemma_preview`. Right: a logging relay shows the one request the bridge sends: the profile (language, Node 22, npm with its lockfile name, ESM, one dependency version). A padlock on the file tree: "source stays here". | Terminal replay |
| 6 | What does Lemma answer? | Awaan | Three real answers from the hosted server: payment gating, `reuse` but "cannot be sold (PROFILE_NOT_BENCHMARKED)… nothing is charged"; the facilitator, "no release fits… nothing is charged"; a JavaScript repository, "not supported… nothing is charged". Stamp: "No evidence, no sale". | Terminal replay |
| 7 | Why on chain, why Arbitrum, why Stylus? | Awaan | Diagram: USDC with no ETH for the agent; the registry holds the bond; one Rust crate runs as the Stylus contract and in the server. Then both contracts on Arbiscan. | Animation, browser |
| 8 | Show the transaction | Awaan | The dashboard's "Two purchases, every step on chain", then Purchase 1's payment on Arbiscan: 0.25 USDC from the buyer to the provider, sent by the facilitator, which paid the gas. Tracker: buyer 1.00 → 0.75. | Browser |
| 9 | Show the state change | Awaan | Purchase 1's warranty activation, then its result: `OutcomeFinalized`, passed, recorded into the Stylus engine (Logs tab). | Browser |
| 10 | What happens when it fails? | Awaan | Purchase 2: paid (buyer 0.75 → 0.50), its result failed, then the refund: 0.25 USDC from the registry to the refund address. Tracker: registry 1.00 → 0.75, refund address 0 → 0.25. | Browser |
| 11 | Does it hold today? | Awaan | `npm run sepolia:check` against the chain on 2026-10-04: code hashes match, wiring, solvency (0.75 held), 2 outcomes, score 4094 bps, "every check passed". | Terminal replay |
| 12 | Is it durable? | Awaan | Five bridge tests pass: a lost answer recovered without paying twice, spending caps refusing before anything is signed, the signer refusing a payee or amount, an expired quote charging nothing, changed terms never paid. Then the contract test files, invariant tests included. | Terminal replay |
| 13 | What did we cut? | Awaan | Strike-through list: marketplace, mainnet, fee split, reputation registration. "Prove the loop first." | Animation |
| 14 | What did we trade off? | Awaan | Table: trade-off, why, what replaces it (team evaluator, metadata-only matching, one owner key, the 1 October release's made-up benchmark numbers). | Animation |
| 15 | What isn't covered yet? | Aryan | Amber list: no sales on the hosted server until a release has measured evidence; independent evaluators; mainnet custody; reorg detection; macOS test sandboxing. | Animation |
| 16 | What comes next? | Aryan | The home page's On Arbitrum Sepolia section, then a roadmap line, then the logo and links. | Browser, animation |

### How it gets made

1. **Browser footage:** Chromium driven by Playwright records the dashboard and Arbiscan at 1920×1080 with scripted scrolling, and a mint outline on the line being talked about.
2. **Terminal footage:** the real commands ran on 2026-10-04 and their output was saved. Remotion replays it as a terminal, with the command typed and the output streaming, labelled "real output, 2026-10-04".
3. **Cards, chips, tracker and captions:** Remotion, with the same components as the pitch.
4. **Voice:** a guide render with a teleprompter, as for the pitch. Aryan records `d1` to `d4`, `d15` and `d16`; Awaan records `d5` to `d14`. The same mixer places them.

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
