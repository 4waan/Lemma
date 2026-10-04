# Submission Videos

How to record the two videos for the Arbitrum Open House Singapore online buildathon on HackQuest. Facts in the first section come from the buildathon's HackQuest page, read on 2026-10-04. The rest is our plan. [Demo Script](demo-script.md) is still the source for claims we can and cannot make.

## What the buildathon asks for

- **Deadline:** submissions close **2026-10-04 23:59 SGT** (15:59 UTC, 21:29 IST). Winners are announced on 2026-10-12. The top three teams get a place at Founder House in Singapore, 23 to 25 October.
- **Prizes:** the Overall Prize pays 40,000, 20,000 and 10,000 USDC. The Promising Products Track pays 7,000, 5,000 and 3,000 USDC. Up to 30,000 USDC goes out as milestone grants. Every prize is paid against development milestones.
- **Qualifying rule:** the project must be deployed on an Arbitrum chain. Arbitrum Sepolia counts.
- **Judging criteria:** smart contract quality, product-market fit, innovation and creativity, and real problem solving. Projects that integrate Paxos' USDG get extra consideration. At least one of the three Overall prizes goes to a Robinhood Chain project, and at least one goes to an Arbitrum project.
- **HackQuest project fields:** a **Pitch Video**, a **Demo Video**, the GitHub repository, progress during the hackathon, and fundraising status. Each video can be an uploaded file or a YouTube or Loom link. HackQuest sets no length for this buildathon; its general guide asks for a demo of 2 to 5 minutes that shows the contract interaction and the UI ([HackQuest best practices](https://www.hackquest.io/blog/Best-Practices-for-Successful-Web3-Hackathon-Project-Submissions)).
- **Buildathon form fields:** frontend link, core contract addresses (`network: address — label`, at most 300 characters), factory contracts, token contract, which code was written during the buildathon (at most 300 characters), and sponsor technologies.

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
| Question it answers | Why should this exist, and why are we the team to build it? | Does it work, and is it really on Arbitrum? |
| Criteria it scores | Product-market fit, real problem solving, innovation | Smart contract quality, deployed on Arbitrum, innovation |
| Viewer | Arbitrum Foundation ecosystem and grants people choosing who goes to Founder House and gets milestone money | Technical judges checking the build |
| What is on screen | A face on camera, plus a few slides or full-screen visuals | The real product: the agent, the terminal, the dashboard, Arbiscan |
| Tone | Story: problem, insight, product, market, business model, roadmap, ask | Proof: one task followed end to end, with every claim shown on screen |
| Length | 2:30 to 3:00 | 3:00 to 4:00, never past 5 |
| Mistake to avoid | Spending a minute on architecture | Spending a minute on slides |

Both videos have to stand alone. A judge may watch only one, so each opens with the one-line hook and says "on Arbitrum" in its first 20 seconds.

## The pitch video, about 2:55

Record the face on camera with a clean background. Cut to full-screen visuals for the numbers. Every number on screen names its source.

| Time | Beat | What to say (roughly) | On screen |
| --- | --- | --- | --- |
| 0:00 | Hook | "Every day, coding agents pay to rebuild integrations that someone already built and tested. Lemma lets them reuse them, and if it fails, they get their money back, on Arbitrum." | Logo, then the face |
| 0:15 | Problem | Agents rebuild the same x402 payment gating, paying clients and facilitators again and again. Each rebuild burns model tokens and can still fail its tests. Copying old code doesn't work: the agent can't tell whether it fits this repository, whether it is safe to apply, or whether buying beats building. | A terminal of an agent looping on the same integration, with a token counter |
| 0:45 | Insight | What matters is the answer to "does this fit my repo, and what will it cost me," not the code. Lemma sells that answer, priced against what it saves and backed by a bond. | The README banner (`docs/brand/lemma-readme-banner.svg`) |
| 1:05 | Product | The four steps: check for free (only a profile, never code), buy for cents over x402, apply and test locally, and get a refund from a USDC bond if the test fails. | The four-step table, one step at a time |
| 1:20 | Against what exists | Copying from GitHub gives code without fit; insurance like Pact refunds a call after it fails. Lemma checks fit first, prices against measured saving, then backs the result with a bond. | A three-column comparison |
| 1:35 | Why Arbitrum | The agent pays USDC with no ETH. A Stylus contract computes each release's score on chain. A Solidity registry holds the bond and refunds failures. A whole purchase cost under 0.00002 testnet ETH in gas. | The contract addresses and the 2026-10-01 transactions on Arbiscan |
| 1:55 | Business model | Price is capped at 30% of the saving a benchmark measured, and the buyer must still save at least 25%. Providers post a bond; the protocol can take a fee later. Show the worked example and say it is an example, not a measurement. | The pricing table from the README |
| 2:15 | Decisions we made | What we cut (one first-party provider, a team evaluator, testnet only) and why: prove that an agent pays, applies, tests and gets refunded before building a marketplace. | Text on screen, one line per cut |
| 2:25 | Traction and honesty | Built during the buildathon, from 24 September. Live dashboard, one-click install for Cursor, VS Code, Goose, Claude Code and Codex. Two real purchases on Arbitrum Sepolia: one passed, one refunded. Over 1,000 tests, Foundry invariants, a reproducible Stylus build. | Dashboard, Connect page, test count |
| 2:35 | Roadmap and ask | Next: measured benchmark evidence so releases go on sale, third-party providers, ERC-8004 reputation, an audit, then Arbitrum One. Founder House would help us find the first providers and buyers. | Roadmap table from Demo Script, Future scope |
| 2:50 | Close | "Lemma: agents stop paying to rediscover solved work." | Logo, URL, GitHub |

Say who the team is in one sentence near the start or the end: names, roles, and why you can build this.

## The demo video, about 3:30

A screen recording with a voice-over. Record at 1080p or higher, with the terminal font at 18 pt or more and the browser zoomed to 125%. Cut every wait; for an on-chain wait, show a "1 minute later" card instead of real time.

Follow one task from start to finish: "add x402 payment gating to this MCP server on Arbitrum Sepolia." The failed test and its refund are the deliberate failure the judges ask for; keep them in even if time is short. End by naming the failure modes the build already handles (a lost paid response recovered without paying twice, a spend limit refusing a purchase) and the ones it does not yet (an independent evaluator, mainnet custody).

| Time | Beat | Shows | Source |
| --- | --- | --- | --- |
| 0:00 | One-line hook and the setup | "Lemma is a reuse layer for coding agents on Arbitrum. Here is one agent task from start to finish." The fixture repository and the agent | Claude Code or Cursor with the bridge connected |
| 0:15 | Free check | The agent calls `lemma_preview` before writing any code. Show that the request carries only a profile, never source. Show the typed `reuse` answer with its price, evidence, limits and warranty terms | The hosted server |
| 0:45 | The catalog | The release's card, score and evidence on the Catalog page; the calculator on the Benchmark page shows why the price is allowed | The live dashboard |
| 1:05 | Spending policy | The bridge checks network, asset, recipient, limit and authorization window. The key stays in `lemma-signer`, outside the model | The terminal |
| 1:20 | Purchase on Arbitrum | `lemma_buy_resolution`: the signer signs one USDC authorization, the facilitator pays the gas, and the settlement transaction opens on Arbiscan | Arbiscan |
| 1:45 | Warranty | The resolution page goes from pending to active, with the activation transaction reserving the price from the bond | Dashboard, Arbiscan |
| 2:05 | Apply and test | The patch is applied atomically, `lemma_verify_adoption` runs the acceptance test, and the receipt is signed. The page shows passed, and the outcome is recorded in the Stylus engine | Terminal, dashboard |
| 2:30 | The failure path | A second repository fails its test. The evaluator decides failed, `lemma_claim_refund` runs, and Arbiscan shows 0.25 testnet USDC back at the refund address | Terminal, Arbiscan |
| 2:55 | Free no-match | A repository Lemma does not support gets a `build` answer, with no price and no payment | Terminal |
| 3:10 | Contract quality | The two contracts on Arbiscan, the Stylus engine's code, the Foundry invariant tests, `npm run sepolia:check` passing | Editor, terminal |
| 3:25 | Close | What works today and what comes next, in one sentence each, and the links | The home page's On Arbitrum Sepolia section |

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
