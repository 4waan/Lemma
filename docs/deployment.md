# Deployment

This runbook describes the target Arbitrum Sepolia submission environment. The server, container, x402 paid path, ERC-8004 reputation, and warranty registry contract are implemented. Voucher signing, evaluator outcomes, and public deployment, including the registry's, remain pending.

## Target environment

- Arbitrum Sepolia, chain id `421614`.
- Arbitrum Sepolia USDC at `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`.
- One Railway application serving the API and dashboard.
- Railway Postgres for durable application state.
- One facilitator replica during the MVP.

## Role separation

Create distinct testnet identities for:

- contract deployer;
- registry owner, which administers the contract (a multisig or a key other than the deployer is recommended);
- capability provider and x402 recipient;
- facilitator transaction signer;
- outcome evaluator;
- benchmark and pilot buyers;
- ERC-8004 agent owner, which registers the provider agent and stays off the server;
- ERC-8004 attester, which posts feedback from the server.

Record public addresses in the deployment evidence. Keep keys in scoped local or Railway secrets. Do not place a buyer or benchmark key in the hosted product service.

The facilitator key (`FACILITATOR_PRIVATE_KEY`) pays settlement gas and needs Sepolia ETH. It never receives USDC, and it is a Railway secret of the server only. A buyer key lives in `lemma-signer`'s key file on the buyer's machine, never in an environment variable (see [Buyer setup](#buyer-setup)).

The attester key (`ATTESTER_PRIVATE_KEY`) signs every ERC-8004 feedback and needs Sepolia ETH for gas; it is a Railway secret of the server only. The agent owner key (`AGENT_OWNER_PRIVATE_KEY`) is used only by the register script, on a machine that is not the server. The two keys must differ, and the owner must never approve the attester for the agent: the reputation registry refuses feedback from an agent's owner and from anyone the owner approved.

## Pre-deployment gate

Run from a clean checkout:

```bash
git submodule update --init
npm ci
npm run verify
npm run catalog:check
npm run contracts:build
npm run contracts:test
npm run contracts:abi -- --check
npm run contracts:rehearse
npm run secrets:scan
```

Production releases must not load `packages/catalog/releases.provisional`. Public catalog entries need verified evidence and measured economics.

## Deployment order

1. Deploy and verify the warranty registry with the expected USDC contract and separated roles, using the two steps of `contracts/script/DeployRegistry.s.sol` (see [Deploy](../contracts/README.md#deploy)). Its second, key-free step writes the deployment record.
2. Create Postgres with a database-scoped user and apply the migration from the release image.
3. Configure the server with the provider, network, demand, database, payment, and verified registry values.
4. Deploy one Railway replica from `ops/Dockerfile` with `TRUSTED_PROXY_HOPS=1`.
5. Verify `/healthz`, the free MCP preview, immutable release reads, dashboard assets, security headers, and graceful shutdown.
6. Set `PAID_TOOLS=on` as described in [Enabling paid tools](#enabling-paid-tools).
7. Optionally, register the provider agent and turn on reputation as described in [Turning on ERC-8004 reputation](#turning-on-erc-8004-reputation).
8. Complete one successful payment, a deliberately lost response and recovery, warranty activation, evaluator pass, evaluator failure, refund credit, and withdrawal.
9. Publish only scrubbed, secret-free deployment evidence.

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

The reconciler needs `eth_getBlockByNumber` for past blocks and `eth_getLogs` filtered by address and topics. Choose an RPC plan that serves `eth_getLogs` over at least 10,000 blocks per request. A provider with a smaller limit still works, more slowly: the reconciler halves a range the RPC refuses with a JSON-RPC error, down to one block, and doubles it again after each accepted range, back up to 10,000.

## Turning on ERC-8004 reputation

Reputation is optional and changes nothing until it is configured. Its table (`reputation_posts`) and the receipts' `buyer_agent_id` column come with the normal migration.

`PUBLIC_BASE_URL` is checked at startup even while reputation is off. It must be an absolute http(s) URL without credentials, query, or fragment, such as `https://lemma.example`; startup is refused otherwise, with an error that names the variable. Fix or clear an old value before deploying.

1. Set `PUBLIC_BASE_URL` to the server's https URL and deploy, so the registration file answers at `/api/v1/agent/registration.json`.
2. On a machine that holds the agent owner key, not the server, run `npm run agent:register -w @lemma/server` with `AGENT_OWNER_PRIVATE_KEY`, `ARBITRUM_SEPOLIA_RPC_URL`, and `PUBLIC_BASE_URL` in the environment. It prints the agentId. The owner key needs a little Sepolia ETH.
3. Fund a separate attester key with a little Sepolia ETH for gas. Set `LEMMA_AGENT_ID` to the printed id, and `ATTESTER_PRIVATE_KEY` and `ARBITRUM_SEPOLIA_RPC_URL` as Railway secrets, then redeploy. The attester also needs `DATABASE_URL`, which production requires anyway.
4. The server logs `reputation.on` with the attester address. Record that address in the deployment evidence: it is the only reviewer Lemma's summaries count. If the registry would refuse the attester's feedback to the provider's agent, the attester logs `reputation.self_feedback` or `reputation.no_such_agent` and stops.

The attester's log search does not shrink its range the way the reconciler does. With an RPC plan that serves `eth_getLogs` over fewer than 10,000 blocks, set `ERC8004_LOG_RANGE` to what the plan allows; otherwise a post that was already attempted is never finished.

The server also serves the registration file at `/.well-known/agent-registration.json` under its own root. ERC-8004's endpoint-domain check reads that path at the domain root, so when `PUBLIC_BASE_URL` has a path prefix, whatever serves the domain root must answer it with the same file.

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

1. Set `PAID_TOOLS=off` and pause the registry to stop new warranty activations. A pause also stops the claim clock, so no buyer's warranty runs out during the incident (see [Pause and the claim clock](../contracts/README.md#pause-and-the-claim-clock)).
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
