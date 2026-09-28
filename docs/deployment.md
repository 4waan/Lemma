# Deployment

This runbook describes the target Arbitrum Sepolia submission environment. The server, container, x402 paid path, ERC-8004 reputation, warranty registry contract, and warranty outcome pipeline are implemented and rehearsed on a local chain. Public deployment, including the registry's and the engine's, remains pending.

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

The provider key (`PROVIDER_PRIVATE_KEY`) signs warranty vouchers and sends activations and expiries, and the evaluator key (`EVALUATOR_PRIVATE_KEY`) signs outcomes and sends finalizations and credit withdrawals. Both need Sepolia ETH for gas and are Railway secrets of the server; the provider key also deposits bond from the operator's machine. The server refuses to start when two of the provider, evaluator, facilitator, and attester keys are one account.

The attester key (`ATTESTER_PRIVATE_KEY`) signs every ERC-8004 feedback and needs Sepolia ETH for gas; it is a Railway secret of the server only. The agent owner key (`AGENT_OWNER_PRIVATE_KEY`) is used only by the register script, on a machine that is not the server. The two keys must differ, and the owner must never approve the attester for the agent: the reputation registry refuses feedback from an agent's owner and from anyone the owner approved.

`npm run sepolia:roles` makes the testnet keys and funds them from one funder key ([runbook](#arbitrum-sepolia-runbook-warranty-engine-and-reputation) step 1): deployer (also the registry's and the engine's administrator on the testnet), provider, facilitator, evaluator, attester, agent-owner, and buyer. [Operations](../ops/README.md#role-keys-arbitrum-sepolia) says where each key goes.

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

1. Deploy and verify the warranty registry with the expected USDC contract and separated roles, using the two steps of `contracts/script/DeployRegistry.s.sol` (see [Deploy](../contracts/README.md#deploy)). Its second, key-free step writes the deployment record. Then deploy the compatibility engine and set the registry's engine, releases, bonds, and priors ([runbook](#arbitrum-sepolia-runbook-warranty-engine-and-reputation), steps 3 to 8).
2. Create Postgres with a database-scoped user and apply the migration from the release image.
3. Configure the server with the provider, network, demand, database, payment, and verified registry values, and the warranty pipeline's settings (runbook step 9).
4. Deploy one Railway replica from `ops/Dockerfile` with `TRUSTED_PROXY_HOPS=1`.
5. Verify `/healthz`, the free MCP preview, immutable release reads, dashboard assets, security headers, and graceful shutdown.
6. Set `PAID_TOOLS=on` as described in [Enabling paid tools](#enabling-paid-tools).
7. Optionally, register the provider agent and turn on reputation as described in [Turning on ERC-8004 reputation](#turning-on-erc-8004-reputation).
8. Complete one successful payment, a deliberately lost response and recovery, warranty activation, evaluator pass, evaluator failure, refund credit, and withdrawal (runbook step 10).
9. Publish only scrubbed, secret-free deployment evidence (runbook step 11).

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

## Arbitrum Sepolia runbook: warranty, engine and reputation

From one funded key to a passing and a refunded purchase on chain, in this order. `npm run e2e` rehearses every step on a local chain except the Stylus deployment (see [Rehearsing the runbook locally](#rehearsing-the-runbook-locally)); run it first.

Before you start:

- The hosts are reachable: `sepolia-rollup.arbitrum.io` (RPC), `sepolia.arbiscan.io` and `api.etherscan.io` (explorer and verification).
- One funded key, `ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY`: about 0.05 Sepolia ETH and 20 testnet USDC from Circle's faucet. It only funds the roles.
- `npm ci`, then `npm run build` (the scripts import the built packages); Foundry 1.7.1, cargo-stylus 0.10.9, and `jq`.
- `ARBITRUM_SEPOLIA_RPC_URL` set in the shell for every step. The public endpoint (`https://sepolia-rollup.arbitrum.io/rpc`) carries no key; a provider's URL does, so keep it in the environment. Step 3 is the one place it becomes an argument (`--endpoint`): use the public endpoint there.
- A private directory outside the repository for the keys, for example `ROLES=~/.lemma/arbitrum-sepolia`.

A key reaches a command only through that command's environment: `PROVIDER_PRIVATE_KEY="$(cat "$ROLES/provider.key")" <command>` sets it for the command alone. The shell history keeps only the `$(cat …)`, and other users' process lists never show it, but the same user and root can read the running command's environment (`ps e`, `/proc/<pid>/environ`), so run these on a machine no one else uses as that user. The scripts that read a key (`sepolia:roles`, `warranty:admin`, `agent:register`) refuse a key-shaped argument (`sepolia:roles` and `warranty:admin` with or without `0x`). A role's public address is `jq -r .roles.<role> "$ROLES/roles.json"`.

1. **Roles.** `ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY=… npm run sepolia:roles -- --dir "$ROLES"` refuses a directory inside the repository or readable by others. It writes one key per role to `$ROLES/<role>.key` (mode 0600, lemma-signer's key file format, never overwritten) and the public addresses to `$ROLES/roles.json`, then tops up each role from the funder: 0.01 testnet ETH to the deployer and 0.003 to the provider, facilitator, evaluator, attester, and agent-owner for gas, 5 testnet USDC of bond to the provider, and 2 to the buyer (`--gas-eth`, `--deployer-eth`, `--provider-usdc`, and `--buyer-usdc` change the targets). Run it again to top up; it sends only what is missing.
2. **Registry.** From `contracts/`, with the deployer as both deployer and owner (on the testnet; a production owner is a multisig), run the two steps of [Deploy](../contracts/README.md#deploy):

   ```sh
   export DEPLOYER_ADDRESS="$(jq -r .roles.deployer "$ROLES/roles.json")"
   export REGISTRY_OWNER_ADDRESS="$DEPLOYER_ADDRESS" USDC_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
   DEPLOYER_PRIVATE_KEY="$(cat "$ROLES/deployer.key")" forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url arbitrum_sepolia --broadcast
   LEMMA_SOURCE_COMMIT="$(git rev-parse HEAD)" forge script script/DeployRegistry.s.sol:DeployRegistry --sig "record()" --rpc-url arbitrum_sepolia
   ```

   The record (`contracts/deployments/arbitrum-sepolia/ResolutionWarrantyRegistry.json`) gives `RESOLUTION_WARRANTY_REGISTRY_ADDRESS` (`address`) and `WARRANTY_REGISTRY_START_BLOCK` (`blockNumber`). Export both for the next steps.
3. **Engine.** From `contracts/stylus/confidence-contract`, deploy the Stylus engine with its constructor in the same transaction, owned by the deployer and recording only from the registry (see [Deploying](../contracts/README.md#deploying-not-done-yet)):

   ```sh
   cargo stylus check --endpoint https://sepolia-rollup.arbitrum.io/rpc
   cargo stylus deploy --endpoint https://sepolia-rollup.arbitrum.io/rpc --private-key-path "$ROLES/deployer.key" \
     --constructor-args "$DEPLOYER_ADDRESS" "$RESOLUTION_WARRANTY_REGISTRY_ADDRESS" --no-verify
   ```

   Export its address as `ENGINE`. Then measure `record`'s gas against the registry's 300,000 budget, cold and warm, as [Gas for `record`](../contracts/README.md#gas-for-record-not-measured) describes, and cache the program first if the cold figure comes near it.
4. **Engine hook.** `REGISTRY_OWNER_PRIVATE_KEY="$(cat "$ROLES/deployer.key")" npm run warranty:admin -w @lemma/server -- set-engine "$ENGINE"`. It refuses an engine that does not name this registry as the one allowed to record, and a key that is not the registry's owner.
5. **Releases.** For each release to sell, as the registry's owner, with its roles: `REGISTRY_OWNER_PRIVATE_KEY="$(cat "$ROLES/deployer.key")" PROVIDER_ADDRESS="$(jq -r .roles.provider "$ROLES/roles.json")" EVALUATOR_ADDRESS="$(jq -r .roles.evaluator "$ROLES/roles.json")" npm run warranty:admin -w @lemma/server -- register-release <releaseId@version> --provisional`. The testnet sells the provisional overlay's releases; a public release needs no `--provisional`. The claim window is the release's own `warranty.claimWindowHours`, the release must pay `PROVIDER_ADDRESS`, and a digest registers once (running it again reports it registered).
6. **Bonds.** As the provider: `PROVIDER_PRIVATE_KEY="$(cat "$ROLES/provider.key")" npm run warranty:admin -w @lemma/server -- deposit-bond <releaseId@version> 5000000 --provisional`. Amounts are atomic USDC (5000000 is 5 testnet USDC); each warranty reserves its price, so 5 USDC covers 20 warranties at 0.25. When the registry's allowance is short, it approves exactly the amount; then it deposits.
7. **Priors.** As the engine's owner: `ENGINE_OWNER_PRIVATE_KEY="$(cat "$ROLES/deployer.key")" npm run warranty:admin -w @lemma/server -- set-priors`. Every profile with frozen benchmark evidence in the public catalog gets the prior the catalog uses (the treatment arm: passes and failures), citing the evidence's run set digest. Provisional evidence never gets a prior on chain; with no frozen evidence yet, it sends nothing and says so. Run it again whenever a release with new evidence is published.
8. **ERC-8004 agent.** Register the provider's agent as in [Turning on ERC-8004 reputation](#turning-on-erc-8004-reputation), with `AGENT_OWNER_PRIVATE_KEY="$(cat "$ROLES/agent-owner.key")"`, and keep the printed `LEMMA_AGENT_ID`.
9. **Server settings.** Besides `DATABASE_URL`, `PUBLIC_BASE_URL` (https), and the RPC URL: `PAID_TOOLS=on`, `PROVIDER_ADDRESS` (the provider's address), `FACILITATOR_PRIVATE_KEY`; `RESOLUTION_WARRANTY_REGISTRY_ADDRESS`, `WARRANTY_REGISTRY_START_BLOCK`, `PROVIDER_PRIVATE_KEY`, `EVALUATOR_PRIVATE_KEY`, `EVALUATOR_FAILURES` (keep `review`), `WARRANTY_ACTIVATION_BATCH_SECONDS` (default 3600), `WARRANTY_ACTIVATION_JITTER_SECONDS` (default 300, used only with batches off), and `WARRANTY_INDEXER_CONFIRMATIONS` (default 64); `EXPLORER_BASE_URL` left unset for Arbiscan links (set empty, it turns them off); `LEMMA_AGENT_ID` and `ATTESTER_PRIVATE_KEY`. The non-public testnet deployment that sells provisional releases also sets `ALLOW_PROVISIONAL_EVIDENCE=true`. The server refuses to start when these are partly set, when two of the four keys are one account, when `PROVIDER_ADDRESS` is not the provider key's address, or when the registry does not hold Arbitrum Sepolia USDC or hash vouchers as it signs them; it logs `warranty.on` and `reputation.on`. `GET /api/v1/status` then names the registry, the engine (once indexed), both ERC-8004 registries, and the agent, and `npm run warranty:admin -w @lemma/server -- status` shows the registry's side: owner, engine, each release's roles, window, and bond.
10. **One passing and one refunded purchase.** Start `lemma-signer serve` with `LEMMA_SIGNER_KEY_FILE="$ROLES/buyer.key"` and the bridge with the spending policy, `LEMMA_ALLOWED_PAY_TO` being the provider (see [Buyer setup](#buyer-setup)). In a repository the release fits, the agent previews, buys, applies, and verifies; the Resolution page (`#/resolutions/<id>`) goes from pending to active to passed, with links to the activation, the finalization (which carries the engine's record), and the attester's feedback. In a repository whose tests fail, the verify records a failed receipt, which waits for the evaluator: `npm run evaluator -w @lemma/server -- list`, then `-- decide <resolutionId> failed`. Once the page shows the warranty failed, the agent's `lemma_claim_refund` sends the claim, the evaluator relays the withdrawal, and the refund address receives the price.
11. **Record.** Write `docs/deployments/arbitrum-sepolia.md`, linked from the README: the date and source commit; the registry, engine, USDC, and ERC-8004 registry addresses and the registry's deployment block; each role's public address (`roles.json`); the transaction hashes of the registry and engine deployments, `setEngine`, `registerRelease`, `depositBond`, each `setPrior`, and the agent registration; for both purchases the settlement, activation, finalization, feedback, and, for the refund, withdrawal hashes; and the compilers from the deployment record. Never a key or a provider's RPC URL.

## Rehearsing the runbook locally

`npm run e2e` ([e2e/README.md](../e2e/README.md)) runs steps 1 and 4 to 10 with the same scripts and settings (the refund with `EVALUATOR_FAILURES=auto` in place of the evaluator's decision) against real contracts on a local anvil posing as Arbitrum Sepolia: Circle's USDC at its Sepolia address, the registry built from `contracts/`, the official ERC-8004 registries, and a Solidity stand-in with the Stylus engine's interface (anvil cannot run Stylus). It checks each command's refusals before anything is sent and that a second run changes nothing, then drives the server and bridges through a pass, a refund, the wash-adoption damper, a crash between a send and its record, and an expiry. The registry's deploy script (step 2) is rehearsed by `npm run contracts:rehearse`; the Stylus deployment (step 3) runs only on Arbitrum Sepolia. CI runs both rehearsals on every change.

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

`PAID_TOOLS=off` removes the paid tool and stops the reconciler and the receipt verifier. `lemma_recover_resolution` and `lemma_claim_buyer_pass` stay registered, so every settled purchase can still be recovered and its bridge can still claim its buyer pass. Rows left `prepared` by a settlement that outlived its call stay so until paid tools are on again, and their buyers' recoveries answer that the purchase is still settling. The reconciler then commits the ones USDC shows used, which their buyers recover for free, and expires the rest. Receipts wait unchecked until then.

The warranty pipeline runs only with paid tools on, so turning them off means unsetting its settings too (`RESOLUTION_WARRANTY_REGISTRY_ADDRESS`, `PROVIDER_PRIVATE_KEY`, `EVALUATOR_PRIVATE_KEY`, `WARRANTY_REGISTRY_START_BLOCK`); the server refuses to start with them partly set. That stops its jobs: nothing is activated, finalized, expired, or relayed meanwhile. Its outbox and its index of the registry stay in the database, and the next start goes on from them. Credits already on chain stay withdrawable with the buyer's claim secret, by anyone who relays it.

Never delete a failed run, receipt, or transaction to make the deployment appear healthy.

## Buyer setup

On the buyer's machine, as the user that should hold the key (ideally not the user running the agent):

1. `lemma-signer init` creates the key file (mode 0600) and prints the buyer address. Fund it with test USDC on Arbitrum Sepolia; it needs no ETH.
2. Start `lemma-signer serve` with `LEMMA_MAX_USDC_PER_RESOLUTION` and `LEMMA_DAILY_USDC_CAP` (atomic USDC) and `LEMMA_ALLOWED_PAY_TO` set. Set `LEMMA_SIGNER_KEY_FILE` only in the signer's environment.
3. Start the bridge with the same policy variables, `LEMMA_REFUND_TO` (an address you control other than the buyer's), and either the signer's `LEMMA_STATE_DIR` (both then use `<state>/signer/signer.sock`) or `LEMMA_SIGNER_SOCKET` pointing at the signer's socket. Purchases stay off, and the bridge says why on stderr, until the policy variables and `LEMMA_REFUND_TO` parse and the signer answers.

For a signer run as another user, give the two users a shared group and set `LEMMA_SIGNER_SOCKET_MODE=660` for the signer. Put its socket (`LEMMA_SIGNER_SOCKET`) in a directory the signer's user owns and the group can enter but not write to, such as mode 0750; the signer creates a missing directory as 0700. The signer and the bridge both refuse a socket directory its group or others can write to, such as `/tmp`.
