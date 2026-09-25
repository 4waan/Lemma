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
3. Apply the database schema and record its version.
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

The image runs `apps/server/dist/main.js`. It refuses to listen unless the environment is valid, `checkCatalog()` passes, and every release that can be sold pays `PROVIDER_ADDRESS`. On Railway, set `TRUSTED_PROXY_HOPS=1`, so rate limits key on the address the platform proxy appends rather than on client-supplied `X-Forwarded-For` entries.

`ALLOW_PROVISIONAL_EVIDENCE` loads the testnet-only provisional overlay (`packages/catalog/releases.provisional/`), which stages 5 and 6 need. The server refuses to start with it in production, and the public deployment never sets it. A separate, non-public testnet deployment or a local server runs those stages.
