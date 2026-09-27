# Deployment

This runbook describes the target Arbitrum Sepolia submission environment. The server, container, and x402 paid path are implemented; warranty and public deployment remain pending.

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

The facilitator key (`FACILITATOR_PRIVATE_KEY`) pays settlement gas and needs Sepolia ETH. It never receives USDC, and it is a Railway secret of the server only. A buyer key lives in `lemma-signer`'s key file on the buyer's machine, never in an environment variable (see [Buyer setup](#buyer-setup)).

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
6. Set `PAID_TOOLS=on` as described in [Enabling paid tools](#enabling-paid-tools).
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

The server refuses to start when the schema is behind the build, the catalog fails validation, sellable releases pay an unexpected provider, provisional evidence is enabled in production, catalog persistence fails, or, with paid tools on, the payment path cannot start.

`DATABASE_URL` must use `postgres://` or `postgresql://`. Neither the server nor migration command may log it. Set a stable `DEMAND_SOURCE_KEY` of at least 32 random characters before the first production start.

## Enabling paid tools

Set `PAID_TOOLS=on` only with `PROVIDER_ADDRESS` set, `FACILITATOR_PRIVATE_KEY` and `ARBITRUM_SEPOLIA_RPC_URL` stored as Railway secrets (RPC providers put their API key in the URL), and the facilitator funded with Sepolia ETH.

At startup the server checks that the RPC serves chain 421614 and refuses to start otherwise. It logs the facilitator address, warns when the facilitator holds no ETH, and starts the settlement reconciler and the receipt verifier, which each run every minute. There are no public facilitator endpoints to verify.

The reconciler needs `eth_getBlockByNumber` for past blocks and `eth_getLogs` filtered by address and topics. Choose an RPC plan that serves `eth_getLogs` over at least 10,000 blocks per request. A provider with a smaller limit still works, more slowly: the reconciler halves a range the RPC refuses with a JSON-RPC error, down to one block.

## Runtime checks

- The application is reachable only through HTTPS.
- HSTS, Content Security Policy, MIME sniffing protection, frame denial, strict referrer policy, and sensitive-response cache controls are present.
- The server closes on `SIGTERM` without accepting new work.
- Hourly housekeeping closes demand days and removes expired unbought offers.
- Database and RPC failures produce bounded, scrubbed responses.
- Uncertain settlements are reconciled from the chain. While a resolution's payment is in flight, another payment for it is refused; the reconciler commits or expires the row once its window closes.

## Rollout and rollback

Keep paid tools off while verifying a new build. Enable them only after free preview, recovery, read APIs, and catalog health pass.

If settlement, voucher signing, or accounting behaves unexpectedly:

1. Set `PAID_TOOLS=off` and stop new warranty activations.
2. Preserve free preview, read-only resolution recovery, and buyer withdrawal access.
3. Reconcile every prepared or uncertain settlement before redeploying. The reconciler runs only while paid tools are on.
4. Preserve failed evidence and incident records.

`PAID_TOOLS=off` removes the paid tool and stops the reconciler and the receipt verifier. `lemma_recover_resolution` stays registered, so every settled purchase can still be recovered. Rows left `prepared` by a settlement that outlived its call stay so until paid tools are on again, and their buyers' recoveries answer that the purchase is still settling. The reconciler then commits the ones USDC shows used, which their buyers recover for free, and expires the rest. Receipts wait unchecked until then.

Never delete a failed run, receipt, or transaction to make the deployment appear healthy.

## Buyer setup

On the buyer's machine, as the user that should hold the key (ideally not the user running the agent):

1. `lemma-signer init` creates the key file (mode 0600) and prints the buyer address. Fund it with test USDC on Arbitrum Sepolia; it needs no ETH.
2. Start `lemma-signer serve` with `LEMMA_MAX_USDC_PER_RESOLUTION` and `LEMMA_DAILY_USDC_CAP` (atomic USDC) and `LEMMA_ALLOWED_PAY_TO` set. Set `LEMMA_SIGNER_KEY_FILE` only in the signer's environment.
3. Start the bridge with the same policy variables, and either the signer's `LEMMA_STATE_DIR` (both then use `<state>/signer/signer.sock`) or `LEMMA_SIGNER_SOCKET` pointing at the signer's socket. Purchases stay off, and the bridge says why on stderr, until the policy variables parse and the signer answers.

For a signer run as another user, give the two users a shared group and set `LEMMA_SIGNER_SOCKET_MODE=660` for the signer. Put its socket (`LEMMA_SIGNER_SOCKET`) in a directory the signer's user owns and the group can enter but not write to, such as mode 0750; the signer creates a missing directory as 0700. The signer and the bridge both refuse a socket directory its group or others can write to, such as `/tmp`.
