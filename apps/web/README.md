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
| `#/` | Home, in five parts: the hero with a sample agent session that plays line by line once it is in view (preview, the REUSE answer, buy within limits, apply, tests passed, result signed; a Replay button; screen readers get it as sentences, and reduced motion shows it whole); how it works in four steps (check, buy, apply and test, covered by the warranty); On Arbitrum Sepolia in three short points (no gas for your agent, scores computed on chain by a Stylus program, failed tests refunded from a USDC bond), each linked to the recorded run's payment, score engine or refund on the explorer; Recorded purchases, the run's two purchases of a test release on 2026-10-01 (one passed, one failed and was refunded), every step (payment over x402, warranty start, test result, refund) linked to its transaction; pricing (check free, a patch at most 30% of the saving, the warranty included) with one worked example as a chart; and the call to action. The session's prices are the worked example's and its payment is the recorded run's (`src/deployment.ts`, copied from `docs/deployments/arbitrum-sepolia.md`). The claim window refreshes every minute while the page is visible, waits while it is hidden, backs off on 429, and keeps the last value that loaded if a refresh fails. | `CatalogView` |
| `#/how-it-works`, `#/arbitrum`, `#/purchases`, `#/pricing` | Home, scrolled to the four steps, the on-chain section, the recorded purchases, or the pricing. | as above |
| `#/catalog` | Compact cards, two across: the capability's short name, its price (or "Free preview"), what it does, what it fits, the claim window, its public record when it has one (pass rate, results and the distinct buyers behind them) and its source. Details folds away the release id, license, dates, commit, digest and each profile with its score. Buyer counts show from three up; below that the page says "fewer than 3 buyers". A line under the title says Lemma itself runs on x402 (every purchase paid in USDC and settled by its own facilitator). Capabilities without a release follow as one line each under Next in the catalog (until a release is published, agents asking get a free build answer, counted in Demand), then Add a release: three steps and a link to the catalog's authoring guide. The release's own title is never rendered. | `CatalogView` |
| `#/benchmark` (also `#/evidence`) | Benchmark: the results once a profile carries evidence (how much cheaper with Lemma, tests passed with and without it, tokens saved, spend when nothing fits, a cost chart per profile and every number in one table), or before then "No published results yet" beside the plan every release goes through; how a run is measured (without and with Lemma); the score in three steps, with a table once a profile has one; the pricing rules with a calculator; and what to trust, including the evaluator's role and the known receipt gap. Evidence from a short probe is labeled "Early estimate". | `CatalogView` |
| `#/what-to-trust` | Benchmark, scrolled to its limits. | as above |
| `#/connect` (also `#/setup`) | Connect your agent, one tab per agent: one-click install links for Cursor, VS Code and Goose; one command for Claude Code and Codex (and Codex's `config.toml`); an `mcpServers` JSON for other agents. Each installs the bridge this server serves at `/dl/` with `npx` and points it at this server's own origin (`src/connect.ts`). Cursor's link also passes `${workspaceFolder}`; VS Code's does not, because its one-click install writes user settings where that variable is undefined, so the bridge reads the folder VS Code starts it in. Then the rule for that agent and a first request. Turn on buying sets up `lemma-signer` from the same package. Its tables list the bridge's tools and settings, including the buyer signer's socket, the spending limits in atomic USDC, and the opt-in `LEMMA_AGENT_ID` with what it publishes. | none (static) |
| `#/resolutions`, `#/resolutions/<id>` | Not linked from the header or footer: a purchase on this server is reached by its own id. Look up a resolution by its public id; its lifecycle (quote, payment, adoption receipt, warranty), the day it was created (only the day, since its id may be public on chain), its warranty (state, amount in USDC, claim deadline, and each transaction the registry's events name, with its explorer page), terms and digests. Explorer links wait for the status, which names the explorer. | `ResolutionView`, `StatusView` |
| `#/demand` | Privacy-thresholded unmet demand ranked by buyer-days (bridges that have bought before), in a fixed order among equals, with repository-days shown beside it. | `DemandView` |
| `#/status`, `#/verify` | What this server runs (service, purchases, warranties, prices, storage), its catalog, and Verify it yourself: the network, the explorer, the provider's ERC-8004 agent id when it has one, each contract the server uses with its explorer page (only those it uses), and the read-only command that recomputes every score. `#/verify` scrolls to that part once the status loads. | `StatusView` |

The header links Catalog, Purchases (the home page's recorded purchases), Benchmark, Status and GitHub (this repository, in a new tab), shows an Arbitrum Sepolia badge that links to the home page's section about it, a theme switch, and Connect your agent; below 920 px the links sit behind a menu button. The badge and that section are the only places the site names its network: amounts read just "USDC", and the site never says testnet or demo. A test renders every page and holds both rules. The logo is the current page's link on the home page, and a page's link is current on that page. The footer has the brand and four columns, Product, Explore (the explorer pages), Trust, and Built on, which names Arbitrum, Stylus, x402, USDC and ERC-8004 as plain text, with no logo or link, and says Lemma is not affiliated with them.

Every API response is parsed with an `@lemma/core` read-model schema before rendering. Invalid responses become visible errors instead of partially rendered data. Nothing is invented where the product is unfinished: a warranty, a contract address, and an explorer link appear only when the read models carry them (`ResolutionView.warranty` is null while the server runs no warranty pipeline, and each `StatusView.chain` address is null while the server does not use that contract), and purchases show as enabled only when the server registers its paid tool (`StatusView.paidTools`).

The warranty section shows the view's state as it reads to a buyer: `none` (no warranty, and why when the payment state says so), `pending` (activation on its way), `active` (with a note that a registry pause moves the claim deadline later), `passed`, `failed` ("refund due": the credit waits for the buyer's bridge to claim it with `lemma_claim_refund`), `refunded`, `void`, and `expired`. Its facts come from the registry's events as the server indexed them, so an action anyone relayed shows up too.

## Design

- One stylesheet, `src/styles.css`, built on tokens from the logo: ink `#0E1518`, mint `#5FE7BB`, link green `#0B7458` (mint in dark mode), on an off-white page (`#F8FAF9`) with white cards. Text color pairs clear 4.5:1 contrast in both themes, and the chart series pass color-vision-deficiency checks on both card surfaces.
- Light and dark follow `prefers-color-scheme` until the viewer uses the header's theme switch; the pick is kept in `localStorage` (`lemma-theme`) and set as `data-theme` on `<html>` before the first render (`src/theme-init.ts`), and the browser's `theme-color` follows it. The dark tokens appear twice in the stylesheet, under the system setting and under `data-theme="dark"`; a test keeps the two identical.
- The page has no scrollbar of its own (it stood beside the sticky header on Macs set to always show scroll bars); wheel, trackpad, keys and touch still scroll, and boxes that scroll inside the page keep a thin, themed one. Spacing is sized so a home section fits a MacBook screen, and long commands wrap instead of scrolling sideways.
- The home page's layout follows the common product landing pattern (Polar's, for one): a sticky translucent header, a hero with a product panel, steps, a chart beside value tiles, a flow beside a live readout, pricing cards, and a footer of link columns. Every card-like block (cards, steps, stats, prices, releases) shares one surface rule, with a 12 px radius. Its pieces are components: `PricingCard` and `Panel` in `src/components/ui.tsx`, `FlowDiagram` (an ordered list of text, its arrows drawn in CSS), `GasChart`, `LiveMeter`, and the polling hook `usePolledView` in `src/api.ts`.
- The logo (`src/components/Logo.tsx`) is inline SVG colored through the stylesheet; `MarkMono` is its one-color form. The favicon and touch icons are in `src/favicon.svg` and `src/icons/`; the brand files are in [docs/brand](../../docs/brand/README.md).
- Fonts are self-hosted latin subsets in `src/fonts/` (Lexend, Instrument Sans, JetBrains Mono, each with its SIL Open Font License), because the Content Security Policy allows same-origin fonts only.
- The hero's sample session (`src/components/Terminal.tsx`) is drawn in the dark panel tokens in both themes, keeps each line's space so the page never shifts as it plays, and needs no inline style.
- The cost chart (`src/components/CostChart.tsx`) always carries a values table, so no number needs hovering to read; in its compact form on the home page the table sits under "Show the numbers". The pricing calculator (`src/calculator.ts`) uses core's `maxPriceFor` and `allInReductionBps`, so the page and `catalog:check` cannot disagree.

## Build guarantees

```bash
npm run build -w @lemma/web
npm run bundle -w @lemma/web
npm run test -w @lemma/web
```

`bundle` runs Vite and then inspects every output file. It rejects inline scripts, styles and event handlers, foreign asset URLs, missing hashed assets, source maps, WebAssembly, and filenames the server will not serve. The tests render every view from read models, including each warranty state, the chain section with and without explorer links, and the buyer counts.

The compatibility engine (`@lemma/confidence`, a wasm module) is server-only. The dashboard shows the numbers the catalog read model carries, with the one-line explanation in `src/components/Compatibility.tsx`, and never imports the engine. A test and the bundle check hold that.

React escaping is the only HTML rendering path. External links are rebuilt from validated parts: GitHub repositories at a full commit, and block explorer pages for an address or a transaction on the explorer the server names (`StatusView.chain.explorer`, from `EXPLORER_BASE_URL`). The explorer must be an http(s) base without credentials, query, or fragment (checked again in the browser), the address or hash must be well formed, and no explorer link is shown while the server turns them off. The server's Content Security Policy permits scripts, styles, fonts, images, and API calls only from the application origin.
