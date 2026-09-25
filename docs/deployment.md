# Deployment

## Target environment

- Arbitrum Sepolia, chain ID 421614.
- Arbitrum Sepolia USDC at `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`.
- One Railway application for server and dashboard assets.
- Railway Postgres for durable application state.
- One facilitator replica during the MVP.

## Role separation

Create distinct testnet identities for:

- Deployer and contract administrator.
- Capability provider and x402 recipient.
- Facilitator transaction signer.
- Outcome evaluator.
- Benchmark and pilot buyers.

Record public addresses. Keep private keys only in scoped local files or Railway secrets.

## Deployment order

1. Run all TypeScript and Foundry checks.
2. Deploy and verify the warranty registry with the expected USDC contract and roles.
3. Apply the database schema and record its version: `node apps/server/dist/migrate.js` in the image, or `npm run db:migrate -w @lemma/server`, with `DATABASE_URL` set. The server refuses to start while the schema is behind the build, and reports a database it cannot reach or read as that, not as a schema that is behind. `DATABASE_URL` must be a `postgres://` or `postgresql://` connection string; neither the server nor the migration step ever prints it. Connecting times out after 10 s, and Postgres cancels any request statement that runs longer than 5 s. A database that stops answering altogether (a network partition) is not bounded by either: the request still answers 504 after 15 s, but its query waits until TCP gives up. Set `DEMAND_SOURCE_KEY` (at least 32 random characters, kept like any other secret) before the first production start.
4. Configure the server with the verified registry address.
5. Deploy one Railway replica from `ops/Dockerfile`.
6. Verify facilitator supported kinds before enabling paid MCP tools (`PAID_TOOLS=on`; the default is off).
7. Complete an unpaid preview, one successful payment, recovery, warranty activation, pass, and failure refund.
8. Publish only secret-free deployment evidence.

## Required production headers

The deployed server must enable HTTPS-only transport, Strict Transport Security, a restrictive Content Security Policy, MIME sniffing protection, frame denial, a strict referrer policy, and no-store caching on sensitive responses.

## Rollback

Pause new contract activations and disable paid tools if settlement, voucher signing, or accounting behaves unexpectedly. Preserve read-only resolution recovery and withdrawal access. Never delete evidence to make a failed deployment appear clean.

## Server startup

The image runs `apps/server/dist/main.js`. It refuses to listen unless the environment is valid, `checkCatalog()` passes, every release that can be sold pays `PROVIDER_ADDRESS`, and the database schema is current. At startup it stores immutable copies of the catalog's releases and bundles. Every hour it closes finished demand days, discarding their salts, and purges offers that expired more than a day ago unbought. On Railway, set `TRUSTED_PROXY_HOPS=1`, so rate limits key on the address the platform proxy appends rather than on client-supplied `X-Forwarded-For` entries.

`ALLOW_PROVISIONAL_EVIDENCE` loads the testnet-only provisional overlay (`packages/catalog/releases.provisional/`), which stages 5 and 6 need. The server refuses to start with it in production, and the public deployment never sets it. A separate, non-public testnet deployment or a local server runs those stages.
