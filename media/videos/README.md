# Submission videos

The two videos for the Arbitrum Open House Singapore buildathon, as one [Remotion](https://www.remotion.dev) project:

- **Pitch** (about 3:09): ten questions about the business, answered by Aryan and Awaan.
- **Demo** (about 4:36): sixteen of the judges' questions, answered over the real product. It shows the purchases made on Arbitrum Sepolia on 2026-10-01 through the live dashboard and Arbiscan, and what was captured live on 2026-10-04: the request the bridge sends, the free answers when nothing fits, the read-only contract check, and the purchase-safety tests.

[Submission videos](../../docs/submission-videos.md) has the plan behind both. Remotion is free for individuals and for companies of up to three people, so this team needs no license.

This folder is not an npm workspace of the monorepo: it has its own `package.json`, and nothing in the root build, tests or typecheck reads it.

## What is in it

| Path | What it is |
| --- | --- |
| `pitch.json`, `demo.json` | The words: each question, who answers it, and the answer split into caption phrases. Edit these to change what is said. |
| `scripts/timeline.mjs` | Times every question card, answer and caption at 2.45 spoken words a second. Writes `src/timeline-<video>.json`. |
| `scripts/music.mjs` | Synthesizes an original music bed from a timeline: a soft pad and arpeggio, a chime on each question, dipped under each answer. Writes `public/music-<video>.wav`. |
| `src/Video.tsx` | What both videos share: question cards and chips, progress dots, captions, the teleprompter of the guide renders, music and voices. |
| `src/Pitch.tsx`, `src/scenes/` | The pitch's intro, outro and ten answer scenes. |
| `src/Demo.tsx`, `src/demo/` | The demo's intro, the testnet USDC tracker, the browser and terminal components, and its sixteen scenes. |
| `capture/pages.mjs`, `capture/pages.json` | Captures the dashboard and Arbiscan pages the demo shows, as 2x screenshots with the box of every element it points at. Writes `public/demo/pages/`. |
| `capture/terminal.mjs` | Runs the real commands the demo replays and saves their output to `public/demo/terminal.json`. |
| `scripts/mix-voices.mjs` | Mixes the recorded voice-over into a rendered video with ffmpeg alone. |
| `scripts/stills.mjs` | Renders review stills of every scene into `out/stills/`. |

## Rendering

```bash
npm install
npm run render:pitch-guide && npm run render:pitch    # out/lemma-pitch-guide.mp4, out/lemma-pitch-music-only.mp4
npm run render:demo-guide && npm run render:demo      # out/lemma-demo-guide.mp4, out/lemma-demo-music-only.mp4
npm run studio                                         # preview and scrub in the browser
```

The guide renders show a teleprompter in place of the captions: who speaks next, a countdown to each answer, and the phrase to say. The music-only renders are the final picture, waiting for the voices.

## Refreshing the demo's captures

The captures are committed, so the demo renders from a clean checkout. To refresh them, from this folder, after `npm run build` at the repository root:

```bash
node capture/pages.mjs        # needs Chromium and network access
node capture/terminal.mjs     # needs network access to the hosted server and Arbitrum Sepolia; no key
```

Arbiscan keeps its address pages behind a bot check, so the demo shows transaction pages only. The registry is not verified on Arbiscan, so its events show as raw topics there; the demo labels them with names decoded from the contracts' ABIs.

## Recording the voice-over

Each speaker records their own answers, one file per answer, named by segment id:

| Video | Aryan | Awaan |
| --- | --- | --- |
| Pitch | `q1`, `q2`, `q3`, `q6`, `q7`, `q10` | `q4`, `q5`, `q8`, `q9` |
| Demo | `d1`, `d2`, `d3`, `d4`, `d15`, `d16` | `d5` to `d14` |

1. Find the quietest room you can, with soft things around. Hold a phone or headset mic a hand's width from your mouth, a little to the side.
2. Play the guide render in headphones, so the music does not leak into the mic.
3. On a Mac, open QuickTime Player, then File, New Audio Recording (on an iPhone, Voice Memos). Start recording when the teleprompter turns amber ("get ready"), speak when it turns red, and stop after the answer.
4. Save each take as `<id>.m4a`, for example `q1.m4a` or `d5.m4a`. Keep about half a second of silence before you speak; the mixer trims it.
5. Speak at the teleprompter's pace. A take up to 8% longer than its slot is sped up to fit; a longer one is cut at the end of its slot and reported, so read that one again a little faster.

## Mixing the voices in

With ffmpeg installed (`brew install ffmpeg` on a Mac):

```bash
node scripts/mix-voices.mjs pitch path/to/pitch-voices     # writes out/lemma-pitch.mp4
node scripts/mix-voices.mjs demo path/to/demo-voices       # writes out/lemma-demo.mp4
```

The mixer starts each file at its answer, cleans and levels every voice, lowers the music under it, and normalizes the result for YouTube. It lists any answer with no file and any take too long for its slot.

## Changing the words

Edit `pitch.json` or `demo.json`, then render again. The timeline, the music and every caption follow the new words. If an answer gets much longer or shorter, re-record that answer.

## Fonts and brand

Lexend, Instrument Sans and JetBrains Mono, copied from `apps/web/src/fonts` with their licenses (SIL Open Font License). The mark and logo come from `docs/brand`.
