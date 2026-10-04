# Pitch video

The Lemma pitch for the Arbitrum Open House Singapore buildathon: ten questions, each answered by Aryan or Awaan, about 3:09 long. It is a [Remotion](https://www.remotion.dev) project. Remotion is free for individuals and for companies of up to three people, so this team needs no license.

This folder is not an npm workspace of the monorepo: it has its own `package.json`, and nothing in the root build, tests or typecheck reads it.

## What is in it

| Path | What it is |
| --- | --- |
| `script.json` | The words: each question, who answers it, and the answer split into caption phrases. Edit this to change what is said. |
| `scripts/timeline.mjs` | Times every question card, answer and caption from `script.json` at 2.45 spoken words a second. Writes `src/timeline.json`. |
| `scripts/music.mjs` | Synthesizes the original music bed from the timeline: a soft pad and arpeggio, a chime on each question, dipped under each answer. Writes `public/music.wav`. |
| `src/` | The video: the question cards and chips, the ten answer scenes, captions, progress dots, and the teleprompter of the guide version. |
| `scripts/mix-voices.mjs` | Mixes the recorded voice-over into the rendered video with ffmpeg alone. |
| `scripts/stills.mjs` | Renders review stills of every scene into `out/stills/`. |

## The two renders

- `lemma-pitch-guide.mp4`: the full video with a teleprompter in place of the captions. It shows who speaks next, counts down to each answer, and highlights the phrase to say. Use it to record the voice-over.
- `lemma-pitch-music-only.mp4`: the final picture with captions and music, waiting for the voices.

```bash
npm install
npm run render:guide     # out/lemma-pitch-guide.mp4
npm run render           # out/lemma-pitch.mp4 (music only until voices are mixed in)
npm run studio           # preview and scrub in the browser
```

## Recording the voice-over

Each speaker records their own answers, one file per answer:

| File | Speaker | Question |
| --- | --- | --- |
| `q1.m4a` | Aryan | What's changing in software? |
| `q2.m4a` | Aryan | What's the problem? |
| `q3.m4a` | Aryan | Who feels it first? |
| `q4.m4a` | Awaan | What is Lemma? |
| `q5.m4a` | Awaan | Why now, and why Arbitrum? |
| `q6.m4a` | Aryan | How does it make money? |
| `q7.m4a` | Aryan | How does it grow? |
| `q8.m4a` | Awaan | What's real today? |
| `q9.m4a` | Awaan | Who's building it? |
| `q10.m4a` | Aryan | What do we need? |

1. Find the quietest room you can, with soft things around (a bedroom beats a bare office). Hold a phone or headset mic a hand's width from your mouth, a little to the side.
2. Play `lemma-pitch-guide.mp4` in headphones, so the music does not leak into the mic.
3. On a Mac, open QuickTime Player, then File, New Audio Recording. Start recording when the teleprompter turns amber ("get ready"), speak when it turns red, and stop after the answer. On an iPhone, Voice Memos works the same way.
4. Save each take as `q1.m4a` … `q10.m4a`. Keep about half a second of silence before you start speaking; the mixer trims it.
5. Speak at the teleprompter's pace. Each answer has a fixed slot. A take up to 8% longer is sped up to fit; a longer one is reported, so read that one again a little faster.

## Mixing the voices in

With ffmpeg installed (`brew install ffmpeg` on a Mac):

```bash
node scripts/mix-voices.mjs path/to/voice-folder out/lemma-pitch-music-only.mp4 out/lemma-pitch.mp4
```

The mixer starts each file at its answer, cleans and levels every voice, lowers the music under it, and normalizes the result for YouTube. It lists any answer with no file and any take too long for its slot.

## Changing the words

Edit `script.json`, then run `npm run render:guide` and `npm run render`. The timeline, the music and every caption follow the new words. If an answer gets much longer or shorter, re-record that answer.

## Fonts and brand

Lexend, Instrument Sans and JetBrains Mono, copied from `apps/web/src/fonts` with their licenses (SIL Open Font License). The mark and logo come from `docs/brand`.
