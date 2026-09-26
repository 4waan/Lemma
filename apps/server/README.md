# Lemma Server

`@lemma/server` hosts the remote MCP endpoint, deterministic resolver, durable resolution state, dashboard APIs, and built web application. It receives typed repository profiles, not repository source.

Free preview, recovery, persistence, read APIs, demand aggregation, and dashboard serving are implemented. The x402 facilitator and paid tool registrar remain pending.

## Run locally

Start with an in-memory store:

```bash
npm run dev -w @lemma/server
```

Build and run the production entrypoint:

```bash
npm run build -w @lemma/server
npm run start -w @lemma/server
```

Set `DATABASE_URL` to use Postgres. Apply migrations before starting a Postgres-backed server:

```bash
npm run db:migrate -w @lemma/server
```

The server refuses to listen when configuration, catalog validation, provider ownership, production evidence policy, paid-tool registration, database schema, or catalog persistence is invalid.

## MCP interface

`POST /mcp` uses stateless Streamable HTTP with JSON responses. Each request receives a fresh MCP server and transport. Browser origins, batches, `GET`, and `DELETE` are rejected.

Implemented tools:

- `lemma_preview`: resolves `PreviewInput` and stores an offer-bearing preview before returning it.
- `lemma_recover_resolution`: returns a settled `ResolutionDelivery` for the buyer holding the preview secret. It remains available when paid tools are disabled.

The pending payment integration registers `lemma_buy_resolution` per request when `PAID_TOOLS=on`.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/v1/releases` | Release identities, digests, base digests, and provenance. |
| `GET /api/v1/interest` | Dependency names the bridge may include for each capability. |
| `GET /api/v1/releases/:digest` | Immutable release manifest used by bridge verification. |
| `GET /api/v1/releases/:digest/base-probe` | Local drift targets and expected base digests. |
| `GET /api/v1/resolutions/:id` | Public resolution state without buyer or recovery secret. |
| `POST /api/v1/adoption-receipts` | First-write-wins outcome submission from the buyer. |
| `GET /api/v1/demand` | Privacy-thresholded, closed-day demand buckets. |
| `GET /api/v1/catalog` | Dashboard catalog with evidence and sellability. |
| `GET /api/v1/status` | Network, catalog, economics, purchase, and store status. |
| `GET /healthz` | Process health. |
| `GET /` and `GET /assets/:name` | Built dashboard when `apps/web/dist` is present. |

Planned facilitator routes are `/facilitator/supported`, `/facilitator/verify`, and `/facilitator/settle`.

## Persistence lifecycle

Catalog objects are immutable and stored by digest so a deployment cannot strand an existing offer. Offer-bearing previews expire unless a settled resolution still needs them.

Resolutions move from `prepared` to `settled`, or to `expired` through reconciliation. Unique constraints prevent one payment authorization from backing multiple resolutions or one resolution from settling twice.

Adoption receipts are accepted only for settled resolutions and require the preview secret. They remain unverified until the payment lane checks the buyer signature.

For the complete state transitions, locking rules, demand privacy model, and failure behavior, see [Server Runtime](../../docs/server-runtime.md).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port. |
| `DATABASE_URL` | Memory store | Postgres connection; required in production. |
| `ARBITRUM_SEPOLIA_CHAIN_ID` | `421614` | Fixed MVP chain. |
| `USDC_ADDRESS` | Arbitrum Sepolia USDC | Fixed settlement asset. |
| `PROVIDER_ADDRESS` | unset | Required when a release becomes sellable. |
| `PAID_TOOLS` | `off` | Enables the registered paid tools. |
| `ALLOW_PROVISIONAL_EVIDENCE` | `false` | Loads the testnet-only catalog overlay; refused in production. |
| `OFFER_TTL_SECONDS` | `900` | Offer lifetime, bounded from 60 to 3600 seconds. |
| `PAYMENT_TIMEOUT_SECONDS` | `300` | Payment authorization lifetime, bounded from 30 to 600 seconds. |
| `DASHBOARD_ORIGIN` | unset | Sole allowed cross-origin reader of `/api/v1/*`. |
| `TRUSTED_PROXY_HOPS` | `0` | Trusted `X-Forwarded-For` appenders. Use `1` on Railway. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-client token bucket for MCP and API routes. |
| `DEMAND_SOURCE_KEY` | Random per process | Stable secret required in production for demand address keys. |

The payment lane will add RPC, facilitator, provider signing, and warranty-registry configuration. Server secrets must never enter browser-prefixed variables or API responses.

## Tests

```bash
npm run test -w @lemma/server
```

The suite drives the Hono app through a real MCP client, replays every catalog fixture, and runs the persistence contract against memory and PGlite. Run the concurrency suite against Postgres with `LEMMA_TEST_DATABASE_URL` when validating database changes.
