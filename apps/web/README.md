# Lemma Web Dashboard

## Purpose and economic role

The dashboard makes the economic claim inspectable. It shows what a buyer can buy and why, what evidence supports each price, what agents asked for that Lemma could not sell, and what happened to a resolution after it was paid.

## Views

The server serves the built dashboard at `/` (see the server README). Views are addressed by URL fragment, so the server serves one page:

| Fragment | View | Read model |
| --- | --- | --- |
| `#/` | Product overview, setup (MCP configuration and the Lemma rule) and what to trust | none (static) |
| `#/catalog` | Every release: provenance, price, warranty, and per profile the platform, evidence label, whether it can be sold and why not, the all-in reduction at the list price, and the highest price that keeps the benchmark target | `CatalogView` |
| `#/evidence` | Every evidenced profile with its benchmark numbers | `CatalogView` |
| `#/demand` | Unmet demand ranked by repositories: what to build next | `DemandView`, ranked by core `rankUnmetDemand` |
| `#/resolutions/<id>` | One resolution's state, terms and adoption outcome | `ResolutionView` |
| `#/status` | Network, catalog, purchases, provisional evidence, economics and storage | `StatusView` |

Every response is parsed with its core schema before anything is rendered; an answer that does not match is shown as an error. Warranty, voucher and contract panes belong to the payment work.

## Outside this boundary

- Holding any private key.
- Constructing or signing x402 payments.
- Applying patches.
- Evaluating warranty claims.
- Serving as an authorization boundary.

## Workspace dependencies

- React and Vite for the client application.
- `@lemma/core` for the read-model schemas, formatting and the unmet-demand ranking.

## Environment variables

None in the build: the dashboard calls the API on its own origin. For `npm run dev` only, `LEMMA_API_URL` (default `http://127.0.0.1:3000`) is where the Vite dev server proxies `/api` to.

## Development and tests

- `npm run dev -w @lemma/web`: serves the page with hot reload and proxies `/api` to a running Lemma server (`LEMMA_API_URL`).
- `npm run build -w @lemma/web`
- `npm run bundle -w @lemma/web`: builds `dist/` and then checks every file in it (`scripts/check-dist.mjs`): no inline script, style or event handler, every reference an existing file under `/assets/` with a name the server serves (so no other origin and no `data:` URI), no `@import` or foreign `url()` in CSS, and no source maps or source-map references.
- `npm run test -w @lemma/web`: every view renders from read models, catalog prose is escaped, outbound links are allowlisted, and a malformed answer is never rendered.

## Security constraints

- Text is rendered through React escaping only; there is no raw HTML.
- The server's CSP allows scripts, styles, images, fonts and API calls from this origin only, with no inline code, no eval, no framing and no forms. zod is set to jitless before any schema is built, so its eval probe never runs.
- Nothing is kept in browser storage, and requests carry no credentials.
- The only outbound links are GitHub repositories at a full commit, rebuilt from validated parts.
- No production source maps.
- Testnet, provisional and unverified states are labeled wherever they appear.

## Later completion criteria

This component is complete when every demo payment and warranty state can be independently inspected, all claims are evidence-linked and correctly labeled, and no sensitive server configuration is present in the browser bundle.
