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

## Planned interfaces

The server will expose:

- `/mcp`
- `/facilitator/supported`
- `/facilitator/verify`
- `/facilitator/settle`
- `/api/v1/releases`
- `/api/v1/resolutions/:id`
- `/api/v1/benchmarks`
- `/api/v1/adoption-receipts`

The current `src/index.ts` exports only scaffold metadata.

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

- `npm run dev -w @lemma/server`
- `npm run build -w @lemma/server`
- `npm run test -w @lemma/server`

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
