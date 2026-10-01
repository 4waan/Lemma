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
| `#/` | Home: what Lemma does with an example session, the three steps (check, buy, apply) marked live or testnet, why it pays (the worked example's cost chart), why Arbitrum, and live figures from this server. | `CatalogView`, `StatusView` |
| `#/how-it-works` | Home, scrolled to the three steps. | as above |
| `#/catalog` | One card per release: what it fits, price, warranty, source, expiry and its public adoption record (the ERC-8004 pass rate and count with the distinct buyers behind it, or "no public record yet"), with the digest and the per-profile table under Details, including each profile's compatibility confidence, what it rests on, and the distinct buyers behind its outcomes. Buyer counts show from three up; below that the page says "fewer than 3 buyers". A capability without a release shows its free build answer. | `CatalogView` |
| `#/evidence` | Proof: the two-arm benchmark and its fixed parameters, every evidenced profile with its numbers and cost chart, compatibility confidence per profile with what it rests on ("benchmark prior, no outcomes yet" until outcomes exist, and "provisional probe prior" when the evidence is provisional) and the distinct buyers behind its outcomes, the pricing rule with a calculator, and what to trust, including the evaluator's role and the known receipt gap. | `CatalogView` |
| `#/what-to-trust` | Proof, scrolled to its limits. | as above |
| `#/setup` | Get started: add the bridge to Cursor, Claude Code or another MCP agent (the configuration names this server's own origin), install the rule for that agent, and ask for an integration. Its tables list the bridge's tools and settings, including the buyer signer's socket, the spending limits in atomic USDC, and the opt-in `LEMMA_AGENT_ID` with what it publishes. | none (static) |
| `#/resolutions`, `#/resolutions/<id>` | Look up a resolution by its public id; its lifecycle (quote, payment, adoption receipt, warranty), the day it was created (only the day, since its id may be public on chain), its warranty (state, amount in testnet USDC, claim deadline, and each transaction the registry's events name, with its explorer page), terms and digests. Explorer links wait for the status, which names the explorer. | `ResolutionView`, `StatusView` |
| `#/demand` | Privacy-thresholded unmet demand ranked by buyer-days (bridges that have bought before), in a fixed order among equals, with repository-days shown beside it. | `DemandView` |
| `#/status` | Network, catalog, economics, purchases, warranties, provisional evidence, storage, and the chain: the block explorer, the provider's ERC-8004 agent id, and each contract the server works with (USDC, the warranty registry, the compatibility engine it records into, and the ERC-8004 identity and reputation registries) with its explorer page, or why the server uses none. | `StatusView` |

The header links How it works, Catalog and Proof, shows a Testnet pill, and ends with Get started; on phones the links sit behind a menu button. The footer links the explorer pages.

Every API response is parsed with an `@lemma/core` read-model schema before rendering. Invalid responses become visible errors instead of partially rendered data. Nothing is invented where the product is unfinished: a warranty, a contract address, and an explorer link appear only when the read models carry them (`ResolutionView.warranty` is null while the server runs no warranty pipeline, and each `StatusView.chain` address is null while the server does not use that contract), and purchases show as enabled only when the server registers its paid tool (`StatusView.paidTools`).

The warranty section shows the view's state as it reads to a buyer: `none` (no warranty, and why when the payment state says so), `pending` (activation on its way), `active` (with a note that a registry pause moves the claim deadline later), `passed`, `failed` ("refund due": the credit waits for the buyer's bridge to claim it with `lemma_claim_refund`), `refunded`, `void`, and `expired`. Its facts come from the registry's events as the server indexed them, so an action anyone relayed shows up too.

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

`bundle` runs Vite and then inspects every output file. It rejects inline scripts, styles and event handlers, foreign asset URLs, missing hashed assets, source maps, WebAssembly, and filenames the server will not serve. The tests render every view from read models, including each warranty state, the chain section with and without explorer links, and the buyer counts.

The compatibility engine (`@lemma/confidence`, a wasm module) is server-only. The dashboard shows the numbers the catalog read model carries, with the one-line explanation in `src/components/Compatibility.tsx`, and never imports the engine. A test and the bundle check hold that.

React escaping is the only HTML rendering path. External links are rebuilt from validated parts: GitHub repositories at a full commit, and block explorer pages for an address or a transaction on the explorer the server names (`StatusView.chain.explorer`, from `EXPLORER_BASE_URL`). The explorer must be an http(s) base without credentials, query, or fragment (checked again in the browser), the address or hash must be well formed, and no explorer link is shown while the server turns them off. The server's Content Security Policy permits scripts, styles, fonts, images, and API calls only from the application origin.
