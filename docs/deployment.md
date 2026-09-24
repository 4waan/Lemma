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
6. Verify facilitator supported kinds before enabling paid MCP tools.
7. Complete an unpaid preview, one successful payment, recovery, warranty activation, pass, and failure refund.
8. Publish only secret-free deployment evidence.

## Required production headers

The deployed server must enable HTTPS-only transport, Strict Transport Security, a restrictive Content Security Policy, MIME sniffing protection, frame denial, a strict referrer policy, and no-store caching on sensitive responses.

## Rollback

Pause new contract activations and disable paid tools if settlement, voucher signing, or accounting behaves unexpectedly. Preserve read-only resolution recovery and withdrawal access. Never delete evidence to make a failed deployment appear clean.

## Scaffold note

The current Docker image builds the placeholder server module and exits when run. A long-lived HTTP process and health endpoint will be introduced with the server implementation.
