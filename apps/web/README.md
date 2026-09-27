# Lemma Dashboard

`@lemma/web` is the read-only product surface for releases, evidence, unmet demand, resolutions, and deployment status. It does not hold keys, create payments, apply patches, or authorize state changes.

The production server serves the built application at `/`. Development uses Vite and proxies `/api` to a running Lemma server.

## Run locally

Start the server, then the dashboard:

```bash
npm run dev:server
npm run dev:web
```

Set `LEMMA_API_URL` when the development server should proxy to an address other than `http://127.0.0.1:3000`.

## Views

| Fragment | Shows | Read model |
| --- | --- | --- |
| `#/` | Home: what Lemma does with an example session, the three steps (check, buy, apply) marked live or coming soon, why it pays (the worked example's cost chart), why Arbitrum, and live figures from this server. | `CatalogView`, `StatusView` |
| `#/how-it-works` | Home, scrolled to the three steps. | as above |
| `#/catalog` | One card per release: what it fits, price, warranty, source and expiry, with the digest and the per-profile table under Details, including each profile's compatibility confidence and what it rests on. A capability without a release shows its free build answer. | `CatalogView` |
| `#/evidence` | Proof: the two-arm benchmark and its fixed parameters, every evidenced profile with its numbers and cost chart, compatibility confidence per profile with what it rests on ("benchmark prior, no outcomes yet" until outcomes exist, and "provisional probe prior" when the evidence is provisional), the pricing rule with a calculator, and what to trust. | `CatalogView` |
| `#/what-to-trust` | Proof, scrolled to its limits. | as above |
| `#/setup` | Get started: add the bridge to Cursor, Claude Code or another MCP agent (the configuration names this server's own origin), install the rule for that agent, and ask for an integration. | none (static) |
| `#/resolutions`, `#/resolutions/<id>` | Look up a resolution by its public id; its lifecycle (quote, payment, adoption receipt, warranty), terms and digests. | `ResolutionView` |
| `#/demand` | Privacy-thresholded unmet demand ranked by repository count. | `DemandView` |
| `#/status` | Network, catalog, economics, purchases, provisional evidence, storage, and the settlement contracts. | `StatusView` |

The header links How it works, Catalog and Proof, shows a Testnet pill, and ends with Get started; on phones the links sit behind a menu button. The footer links the explorer pages.

Every API response is parsed with an `@lemma/core` read-model schema before rendering. Invalid responses become visible errors instead of partially rendered data. Nothing is invented where the product is unfinished: warranty activation, the registry address and paid purchases show as in progress until the payment work adds them to the read models.

## Design

- One stylesheet, `src/styles.css`, built on tokens from the logo: ink `#0E1518`, mint `#5FE7BB`, link green `#0B7458` (mint in dark mode). Light and dark follow `prefers-color-scheme`. Text color pairs clear 4.5:1 contrast, and the chart's three series pass color-vision-deficiency checks on both surfaces.
- The logo (`src/components/Logo.tsx`) is inline SVG colored through the stylesheet; `MarkMono` is its one-color form. The favicon and touch icons are in `src/favicon.svg` and `src/icons/`; the brand files are in [docs/brand](../../docs/brand/README.md).
- Fonts are self-hosted latin subsets in `src/fonts/` (Lexend, Instrument Sans, JetBrains Mono, each with its SIL Open Font License), because the Content Security Policy allows same-origin fonts only.
- The cost chart (`src/components/CostChart.tsx`) always carries a values table, so no number needs hovering to read. The pricing calculator (`src/calculator.ts`) uses core's `maxPriceFor` and `allInReductionBps`, so the page and `catalog:check` cannot disagree.

## Build guarantees

```bash
npm run build -w @lemma/web
npm run bundle -w @lemma/web
npm run test -w @lemma/web
```

`bundle` runs Vite and then inspects every output file. It rejects inline scripts, styles and event handlers, foreign asset URLs, missing hashed assets, source maps, WebAssembly, and filenames the server will not serve.

The compatibility engine (`@lemma/confidence`, a wasm module) is server-only. The dashboard shows the numbers the catalog read model carries, with the one-line explanation in `src/components/Compatibility.tsx`, and never imports the engine. A test and the bundle check hold that.

React escaping is the only HTML rendering path. External links are rebuilt from validated GitHub repository and commit fields. The server's Content Security Policy permits scripts, styles, fonts, images, and API calls only from the application origin.
