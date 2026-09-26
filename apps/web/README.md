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

| Fragment | Shows |
| --- | --- |
| `#/` | Product explanation, trust boundaries, MCP setup, and agent rule. |
| `#/catalog` | Releases, provenance, price, warranty terms, evidence, and sellability by profile. |
| `#/evidence` | Benchmark evidence published by release profile. |
| `#/demand` | Privacy-thresholded unmet demand ranked by repository count. |
| `#/resolutions/<id>` | Public resolution state, terms, and adoption outcome. |
| `#/status` | Network, catalog, economics, purchases, provisional evidence, and storage. |

Every API response is parsed with an `@lemma/core` read-model schema before rendering. Invalid responses become visible errors instead of partially rendered data.

## Build guarantees

```bash
npm run build -w @lemma/web
npm run bundle -w @lemma/web
npm run test -w @lemma/web
```

`bundle` runs Vite and then inspects every output file. It rejects inline scripts, styles and event handlers, foreign asset URLs, missing hashed assets, source maps, and filenames the server will not serve.

React escaping is the only HTML rendering path. External links are rebuilt from validated GitHub repository and commit fields. The server's Content Security Policy permits scripts, styles, fonts, images, and API calls only from the application origin.

Warranty and settlement views remain pending with the payment and contract implementation.
