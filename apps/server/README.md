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
    - `lemma_recover_resolution`: input `RecoverInput`, output `ResolutionDelivery`. It is free and registered even when paid tools are off (deployment.md rollback), and returns settled resolutions only. Until persistence lands it always answers `NOT_FOUND`.
    - Paid tools are added by the payment work's registrar, and only with `PAID_TOOLS=on`.
- `GET /api/v1/releases`: every release with its digest, base digest and source. `max-age=60`, because sellability changes with time.
- `GET /api/v1/interest`: per-capability interest sets. The `ETag` is the catalog digest, so the bridge revalidates for free.
- `GET /api/v1/releases/:digest/base-probe`: modify and delete targets with their base digests. They are immutable and cacheable forever.
- `GET /healthz`

Planned:

- `/facilitator/supported`, `/facilitator/verify` and `/facilitator/settle` (payment work)
- `/api/v1/resolutions/:id`: a public view without the bundle or buyer
- `/api/v1/benchmarks`
- `/api/v1/demand`
- `POST /api/v1/adoption-receipts`

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
| `DATABASE_URL` | none | Required in production. |

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
- `npm run test -w @lemma/server`: a real MCP client drives the Hono app in-process, and every catalog fixture is replayed over HTTP.

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
