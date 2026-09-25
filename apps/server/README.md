# Lemma Server

## Purpose and economic role

The server will convert a safe task and repository profile into a free preview or a paid Compatibility Resolution. It is the remote coordination boundary between the buyer bridge, the curated catalog, x402 settlement, warranty vouchers, adoption receipts, and the public dashboard.

The server does not make open-source code scarce. It charges for a verified, context-specific integration route and the warranty attached to it.

## Responsibilities

- Host the Streamable HTTP MCP endpoint.
- Evaluate deterministic compatibility rules against the curated catalog.
- Return free no-match and preview results.
- Protect paid resolution tools with x402.
- Host the Arbitrum Sepolia facilitator endpoints.
- Persist previews, payment receipts, resolutions, warranty vouchers, and adoption receipts.
- Serve read-only dashboard APIs and the built web assets.
- Sign provider vouchers only after successful payment settlement.
- Support idempotent recovery after a lost paid response.

## Outside this boundary

- Reading the buyer's repository directly.
- Holding the buyer private key.
- Applying patches to a buyer workspace.
- Executing arbitrary buyer repositories.
- Letting a model authorize payment.
- Adjudicating warranty failures with the provider signing key.

## Interfaces

Implemented:

- `POST /mcp`: stateless Streamable HTTP with JSON responses. Each request gets a new MCP server and transport.
  - `GET` and `DELETE` return 405, so no idle SSE stream is ever held.
  - Requests with an `Origin` header come from a browser and are refused.
  - Tools:
    - `lemma_preview`: input `PreviewInput`, output `PreviewResult`. A preview that carries an offer is stored before it is returned. If storing fails, the tool returns a text-only error.
    - `lemma_recover_resolution`: input `RecoverInput`, output `ResolutionDelivery`. It is free and registered even when paid tools are off (deployment.md rollback), and returns settled resolutions only.
    - Paid tools are added by the payment work's registrar, and only with `PAID_TOOLS=on`.
- `GET /api/v1/releases`: every release with its digest, base digest and source. `max-age=60`, because sellability changes with time.
- `GET /api/v1/interest`: per-capability interest sets. The `ETag` is the catalog digest, so the bridge revalidates for free.
- `GET /api/v1/releases/:digest/base-probe`: modify and delete targets with their base digests. They are immutable and cacheable forever.
- `GET /api/v1/resolutions/:id`: a public view of a resolution (state, release, payload digest, terms, receipt outcome). It never includes the preview id, which is the recovery secret, the buyer, or the bundle.
- `POST /api/v1/adoption-receipts`: body `{ receipt, previewId }`. The preview id is the recovery secret, known only to the buyer's bridge, so only the buyer can submit; a resolution id alone, which is public, is answered as unknown. Accepted only for a settled resolution, with `recordedAt` no more than five minutes before its creation or after the server's clock, and only once (first write wins). A receipt stays `verified: false` until the payment work checks its signature. A store failure answers 500, so the bridge retries.
- `GET /api/v1/demand`: closed-day demand buckets with at least five distinct repositories and at least five distinct client addresses, each with its parsed key (core `DemandView`).
- `GET /api/v1/catalog`: the dashboard's catalog (core `CatalogView`): per profile, whether it can be sold and why not, its evidence, the all-in reduction at the list price after chain cost, and `maxPriceFor`. Computed at request time, `max-age=60`.
- `GET /api/v1/status`: network, catalog, whether purchases and provisional evidence are on, the economics status and the store (core `StatusView`).
- `GET /healthz`
- `GET /` and `GET /assets/:name`: the built dashboard (`apps/web/dist`), when present. Only regular files with Vite's hashed names and an allowlisted extension are served, never through a link. The page gets a CSP that allows only this origin's scripts, styles and API; every other response gets `default-src 'none'`.

Planned:

- `/facilitator/supported`, `/facilitator/verify` and `/facilitator/settle` (payment work)

## Persistence and the payment seam

`DATABASE_URL` selects Postgres (`PgStore`, drizzle over postgres.js). Without it, development uses a memory store. One contract suite runs against the memory store and PGlite. A CI job runs the race test on real Postgres.

| Table | Rule |
| --- | --- |
| `releases`, `bundles`, `catalog_snapshots` | Immutable copies keyed by digest, upserted at startup, so a redeploy never strands an offer or a recovery. |
| `previews` | Offer-bearing previews only. They are purged a day after expiry unless a settled resolution needs them. |
| `resolutions` | One row per `deriveResolutionId(previewId, payer)`: `prepared → settled`, or `expired` by the reconciler, after which a new payment re-arms it. One authorization (payer and nonce) backs one row, and one settlement settles one row (unique indexes). Rows that expired unpaid are purged with their previews. |
| `adoption_receipts` | One per settled resolution, submitted by the buyer, unverified until signed. |
| `demand_seen`, `demand_salts`, `demand_daily` | Every preview adds its profile digest, salted with a daily secret, and its client address, keyed with `DEMAND_SOURCE_KEY` (held outside the database) and then salted, to its bucket. Recording and closing a day take a per-day advisory lock (shared and exclusive), so a close waits for in-flight writes and a later write sees the day closed: nothing is counted twice, and no salt is created for a closed day. When the day closes, each bucket collapses to two counts in one statement that deletes what it counts; the salt and digests are deleted. Each day closes on its own, with a five-minute statement limit instead of the five seconds requests get; a day too large to close in five minutes would fail on every hourly run and needs batching. |

`ResolutionService` is the seam the payment work wraps x402 around:

- `quote(previewId)` returns the stored offer's exact `PaymentTerms`, for building `accepts`.
- `prepare(previewId, { payer, nonce, validBefore })` runs inside the paid tool's handler, with values from the verified payment payload, never from tool arguments.
  - It writes one `prepared` row with a single conditional insert.
  - A second payment for the same resolution gets `IN_FLIGHT` or `ALREADY_SETTLED`, and an authorization that already backs another resolution gets `PAYMENT_REUSED`. The wrapper must answer `isError`, which makes x402 cancel that settlement.
- `commit(resolutionId, { nonce, settlementRef })` runs after settlement and never throws. It settles only the row that still holds that authorization.
- `listUnsettled(before)` and `expire(resolutionId, nonce)` are for the settlement reconciler. `expire` takes the nonce the reconciler checked and changes nothing unless the row still holds it and its window has closed, so a stale decision never lands on a re-armed row.
- `recover(previewId, buyer)` backs the free recovery tool.

The payment work registers its paid tool through `createApp({ registerPaidTools })`: `(server, service, { message })` runs for every request on that request's new MCP server, with the request's parsed JSON-RPC message, so the registrar can read the preview id a paid call names and build `accepts` from `service.quote(previewId)`. It may be async: the server awaits it before dispatching the request, and a failure in it answers 500. Store failures reach it as a `StoreError` that carries only a code.

`POST /api/v1/adoption-receipts` answers `ACCEPTED` (201) or `DUPLICATE` (409), both final; `NOT_SETTLED` (409) and `TOO_EARLY` (425, a `recordedAt` more than 5 minutes ahead of the server) are worth retrying later; `UNKNOWN_RESOLUTION` (404) and `MISMATCH` (422) never succeed.

Migrations live in `drizzle/`, generated from `src/db/schema.ts` with `npm run db:generate -w @lemma/server`. `npm run db:migrate -w @lemma/server` applies them. The server refuses to start while the database schema is behind the build.

## Startup checks

`src/main.ts` refuses to listen unless all of these hold:

- the environment is valid (`src/config.ts`)
- `checkCatalog()` reports no problem
- every release that can be sold pays the configured `PROVIDER_ADDRESS`
- `ALLOW_PROVISIONAL_EVIDENCE` is not set in production
- paid tools are off, until the payment work's registrar is part of the build

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Listening port. |
| `ARBITRUM_SEPOLIA_CHAIN_ID` | `421614` | Must be 421614. |
| `USDC_ADDRESS` | Arbitrum Sepolia USDC | Must be that contract. Checksummed input is normalized. |
| `PROVIDER_ADDRESS` | none | The only `payTo` the server quotes for. Required once any release can be sold. |
| `PAID_TOOLS` | `off` | `on` registers the paid tools. |
| `ALLOW_PROVISIONAL_EVIDENCE` | `false` | Loads the testnet-only provisional overlay. Refused in production. |
| `OFFER_TTL_SECONDS` | `900` | Offer window, 60 to 3600. The offer is also capped by release expiry and evidence staleness. |
| `PAYMENT_TIMEOUT_SECONDS` | `300` | x402 authorization window, 30 to 600. |
| `DASHBOARD_ORIGIN` | none | The only origin allowed cross-origin reads of `/api/v1/*`. |
| `TRUSTED_PROXY_HOPS` | `0` | Proxies that append to `X-Forwarded-For` (Railway: `1`). Rate limits key on the address the outermost trusted proxy appended. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Token bucket per client, on `/mcp` and `/api/v1/*`. |
| `DATABASE_URL` | none | Required in production. Any `postgres://` or `postgresql://` connection string postgres.js accepts. |
| `DEMAND_SOURCE_KEY` | random per process | Required in production: at least 32 characters, the same across restarts and replicas. Keys client addresses in demand counts; it is never stored in the database. |

## Workspace dependencies

- `@lemma/core` for shared schemas and identifiers.
- `@lemma/catalog` for curated releases and fixtures.
- Hono for HTTP routing.
- MCP and x402 SDKs for paid tools.
- viem for Arbitrum interactions.
- Drizzle and Postgres for persistence.

## Environment variables

Server work will eventually require `DATABASE_URL`, `PUBLIC_BASE_URL`, `ARBITRUM_SEPOLIA_RPC_URL`, provider and facilitator roles, the USDC address, and the deployed warranty registry address.

Never add private values to browser-prefixed variables or API responses.

## Development and tests

- `npm run dev -w @lemma/server` (watches `src/main.ts`)
- `npm run build -w @lemma/server`, then `npm run start -w @lemma/server`
- `npm run test -w @lemma/server`: a real MCP client drives the Hono app in-process, and every catalog fixture is replayed over HTTP. The persistence contract suite runs on memory and PGlite. `LEMMA_TEST_DATABASE_URL=postgres://… npx vitest run apps/server/test/postgres.test.ts` runs the concurrency test on real Postgres.

Compilation and scaffold tests require no environment values.

## Security constraints

- Validate every request with explicit schemas and size limits.
- Allow only the configured chain, token, payment scheme, amounts, and provider destination.
- Use parameterized database operations.
- Do not return internal stack traces in production.
- Apply restrictive CORS, rate limits, timeouts, and security headers.
- Store resolution identifiers as high-entropy values.
- Treat settlement timeout as an indeterminate state that requires reconciliation.
- Run a single facilitator replica until pending settlement state is moved to shared storage.

## Later completion criteria

This component is complete when a remote MCP client can preview for free, settle one bounded x402 payment, recover the same resolution without duplicate payment, obtain a provider-signed warranty voucher, and observe the corresponding records through a read-only API.
