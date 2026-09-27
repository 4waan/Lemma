# Lemma brand

The mark is the L of Lemma: a dark stem with a slanted top (the proven piece), a mint band that rises from its foot (reuse), and a right leg that darkens into a downward arrow (the patch dropped into your project). The wordmark is set in Lexend at weight 500.

## Files

| File | Use |
| --- | --- |
| `lemma-mark.svg` | The mark for light backgrounds. |
| `lemma-mark-dark.svg` | The mark for dark backgrounds: a light stem, and the arrow ends in green instead of ink. |
| `lemma-mark-mono.svg` | One color (`currentColor`), for stamps, prints and small sizes. |
| `lemma-logo.png`, `lemma-logo-dark.png` | The horizontal lockup, 640×176, for READMEs and slides. |
| `lemma-logo-stacked.png`, `lemma-logo-stacked-dark.png` | The stacked lockup: the mark above the wordmark. |

The dashboard draws the same geometry inline (`apps/web/src/components/Logo.tsx`), and its favicon (`apps/web/src/favicon.svg`) is a flat version on an ink tile that reads at 16 px.

## Colors

| Role | Value |
| --- | --- |
| Ink (text, stem, primary button) | `#0E1518` |
| Mint (band, highlights, primary button in dark mode) | `#5FE7BB` |
| Band gradient | `#5FE6BA` to `#44CDA0` to `#17906B` |
| Link green on white | `#0B7458` |
| Mist (quiet surfaces) | `#F3F7F5` |
| Dark background and surface | `#0B1113` and `#121A1C` |

Mint is never used for text on white (1.5:1 contrast). Ink on mint is 12:1, so mint buttons carry ink text.

## Rules

- Keep the mark at least 16 px tall; below 24 px use the favicon's flat version or the one-color mark.
- Leave clear space around the mark of at least a quarter of its height.
- On dark backgrounds use the dark mark; do not place the light mark's ink arrow on ink.
- Do not stretch, rotate or recolor the band, and do not add effects.
- The wordmark is live text in Lexend 500 wherever fonts are available; the PNG lockups are for places that cannot load fonts.
