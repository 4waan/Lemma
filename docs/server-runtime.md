# Server Runtime

The hosted server coordinates free compatibility previews, recoverable resolution state, the catalog read API, demand aggregation, and the dashboard. Payment integration attaches through explicit seams rather than changing the resolver.

## Request model

`POST /mcp` creates a fresh stateless MCP server and transport for every request. Browser-origin requests, batches, unsupported methods, oversized bodies, invalid schemas, and requests that exceed the timeout fail before dispatch.

`lemma_preview` resolves the typed request against the in-memory catalog index. An offer-bearing preview is stored before it is returned. `lemma_recover_resolution` is always free and returns only settled resolutions.

Paid tools remain disabled until the payment registrar is part of the process and `PAID_TOOLS=on`.

## Persistence

Development uses the memory store when `DATABASE_URL` is absent. Production uses Postgres through Drizzle and postgres.js. The same persistence contract runs against memory and PGlite, with a concurrency test available for real Postgres.

The store keeps immutable releases, bundles, and catalog snapshots by digest. Offer-bearing previews expire unless a settled resolution still needs them. Resolutions move from `prepared` to `settled`, or to `expired` after reconciliation.

One payment authorization can back one resolution, and one resolution can settle once. Adoption receipts are accepted only for settled resolutions, from the buyer holding the preview secret, with first write winning.

Database migrations live under `apps/server/drizzle`. They are applied explicitly, and the server refuses to start when the schema is behind the build.

## Payment seam

`ResolutionService` exposes the state transitions required by the pending x402 wrapper:

- `quote` retrieves the exact payment terms from the stored preview.
- `prepare` conditionally reserves one resolution for a verified payer and authorization.
- `commit` records settlement without throwing into the payment response path.
- `listUnsettled` and `expire` support reconciliation.
- `recover` serves the free recovery tool using the preview secret and buyer.

The paid-tool registrar runs for each MCP request and receives that request's service instance and parsed message. It can construct the x402 challenge from the stored quote, never from tool arguments.

## Demand privacy

Every preview contributes to a daily demand bucket. Repository profiles and client addresses are keyed and salted before storage. Closed days collapse into counts and delete their salts and raw digests.

The public demand API exposes only buckets with at least five distinct repositories and five distinct client addresses. Closing and recording coordinate through per-day database locks so no preview is counted twice or added after closure.

## Startup gates

The production entrypoint refuses to listen unless:

- environment configuration parses;
- catalog validation passes;
- every sellable release pays the configured provider;
- provisional evidence is disabled in production;
- paid tools are not enabled without a registrar;
- the database is reachable and migrated;
- the current catalog snapshot is persisted.

The process handles `SIGTERM` by stopping new requests, closing background work, and releasing the server and database resources.

## Operational failure behavior

- No match returns a free decision and no offer.
- A catalog or migration failure prevents startup.
- Store failures are reduced to typed error codes before reaching clients.
- Settlement uncertainty remains pending for reconciliation.
- Recovery uses the original preview secret and buyer, so a public resolution id is insufficient.
- Paid tools can be disabled while free preview, recovery, and read APIs remain available.
