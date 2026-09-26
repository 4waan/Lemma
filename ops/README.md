# Operations

`ops/` contains the production container and Railway configuration for the hosted Lemma server and dashboard. Local Postgres remains in the root `compose.yaml`.

The container build is implemented. Public deployment and the x402 production process remain pending.

## Container

`Dockerfile` performs a reproducible Node 22 workspace build, prunes development dependencies, copies the compiled server and shared packages into the runtime image, and runs as the unprivileged `node` user.

Build from the Lemma repository root so workspace paths resolve:

```bash
docker build -f ops/Dockerfile -t lemma .
```

The runtime command is:

```text
node apps/server/dist/main.js
```

The image does not contain `.env` files, local dependencies, source maps, benchmark runs, Foundry output, or Git history.

## Railway

Use `Lemma/` as the Railway service root. `railway.toml` selects the Dockerfile, starts the compiled server, and restarts failed processes within its configured limit.

Apply database migrations as an explicit release step before promoting a build. The server refuses to start against an older schema.

Required production concerns:

- Railway Postgres with a database-scoped user.
- Stable `DEMAND_SOURCE_KEY` and server-only secrets in Railway's secret store.
- `TRUSTED_PROXY_HOPS=1` for Railway's proxy chain.
- HTTPS-only ingress to the application port.
- One facilitator replica until pending settlement state and nonce coordination are proven safe across replicas.
- Contract and payment addresses copied from a verified deployment record.

Do not place buyer keys or benchmark credentials in the hosted service. Provider, facilitator, evaluator, and deployer roles must remain distinct.

## Release checks

Before deployment:

```bash
npm ci
npm run verify
npm run catalog:check
npm run contracts:build
npm run contracts:test
npm run secrets:scan
```

Then apply migrations, start the image, and verify `/healthz`, free preview, immutable release reads, dashboard assets, security headers, and graceful shutdown.

Enable paid tools only after the facilitator registrar, settlement reconciler, signer separation, and warranty addresses have passed the testnet sequence in [Deployment](../docs/deployment.md).
