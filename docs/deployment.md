# Deployment

This runbook describes the target Arbitrum Sepolia submission environment. The server and container are implemented; payment, warranty, and public deployment remain pending.

## Target environment

- Arbitrum Sepolia, chain id `421614`.
- Arbitrum Sepolia USDC at `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`.
- One Railway application serving the API and dashboard.
- Railway Postgres for durable application state.
- One facilitator replica during the MVP.

## Role separation

Create distinct testnet identities for:

- deployer and contract administrator;
- capability provider and x402 recipient;
- facilitator transaction signer;
- outcome evaluator;
- benchmark and pilot buyers.

Record public addresses in the deployment evidence. Keep keys in scoped local or Railway secrets. Do not place a buyer or benchmark key in the hosted product service.

## Pre-deployment gate

Run from a clean checkout:

```bash
npm ci
npm run verify
npm run catalog:check
npm run contracts:build
npm run contracts:test
npm run secrets:scan
```

Production releases must not load `packages/catalog/releases.provisional`. Public catalog entries need verified evidence and measured economics.

## Deployment order

1. Deploy and verify the warranty registry with the expected USDC contract and separated roles.
2. Create Postgres with a database-scoped user and apply the migration from the release image.
3. Configure the server with the provider, network, demand, database, payment, and verified registry values.
4. Deploy one Railway replica from `ops/Dockerfile` with `TRUSTED_PROXY_HOPS=1`.
5. Verify `/healthz`, the free MCP preview, immutable release reads, dashboard assets, security headers, and graceful shutdown.
6. Verify the facilitator's supported payment kind before setting `PAID_TOOLS=on`.
7. Complete one successful payment, a deliberately lost response and recovery, warranty activation, evaluator pass, evaluator failure, refund credit, and withdrawal.
8. Publish only scrubbed, secret-free deployment evidence.

## Database migrations

Apply migrations explicitly before starting the new server:

```bash
node apps/server/dist/migrate.js
```

For local development, the equivalent workspace command is:

```bash
npm run db:migrate -w @lemma/server
```

The server refuses to start when the schema is behind the build, the catalog fails validation, sellable releases pay an unexpected provider, provisional evidence is enabled in production, or catalog persistence fails.

`DATABASE_URL` must use `postgres://` or `postgresql://`. Neither the server nor migration command may log it. Set a stable `DEMAND_SOURCE_KEY` of at least 32 random characters before the first production start.

## Runtime checks

- The application is reachable only through HTTPS.
- HSTS, Content Security Policy, MIME sniffing protection, frame denial, strict referrer policy, and sensitive-response cache controls are present.
- The server closes on `SIGTERM` without accepting new work.
- Hourly housekeeping closes demand days and removes expired unbought offers.
- Database and RPC failures produce bounded, scrubbed responses.
- The facilitator reconciles uncertain settlements before another authorization is attempted.

## Rollout and rollback

Keep paid tools off while verifying a new build. Enable them only after free preview, recovery, read APIs, and catalog health pass.

If settlement, voucher signing, or accounting behaves unexpectedly:

1. Set `PAID_TOOLS=off` and stop new warranty activations.
2. Preserve free preview, read-only resolution recovery, and buyer withdrawal access.
3. Reconcile every prepared or uncertain settlement before redeploying.
4. Preserve failed evidence and incident records.

Never delete a failed run, receipt, or transaction to make the deployment appear healthy.
