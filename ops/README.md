# Operations

`ops/` contains the production container and Railway configuration for the hosted Lemma server and dashboard, and the Arbitrum Sepolia role setup the deployment runbook starts with (`sepolia/`). Local Postgres remains in the root `compose.yaml`. Contract deployment lives in `contracts/`, and the registry's and the engine's settings in `npm run warranty:admin -w @lemma/server`.

The container build, the x402 paid path, and the warranty pipeline are implemented. Public deployment remains pending.

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
- Stable `DEMAND_SOURCE_KEY` and server-only secrets in Railway's secret store. `FACILITATOR_PRIVATE_KEY` and `ARBITRUM_SEPOLIA_RPC_URL` are such secrets, needed only with `PAID_TOOLS=on`, and so are `PROVIDER_PRIVATE_KEY` and `EVALUATOR_PRIVATE_KEY` for the warranty pipeline and `ATTESTER_PRIVATE_KEY` for reputation.
- `TRUSTED_PROXY_HOPS=1` for Railway's proxy chain.
- HTTPS-only ingress to the application port.
- One facilitator replica until pending settlement state and nonce coordination are proven safe across replicas.
- Contract and payment addresses copied from a verified deployment record.

Do not place buyer keys or benchmark credentials in the hosted service; a buyer key lives in `lemma-signer`'s key file on the buyer's machine. Provider, facilitator, evaluator, and deployer roles must remain distinct.

## Role keys (Arbitrum Sepolia)

`sepolia/setup-roles.ts` makes the testnet role keys and funds them from one funder key; it is step 1 of the [runbook](../docs/deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation), and `npm run typecheck:tests` typechecks it through `sepolia/tsconfig.json`.

```bash
npm run sepolia:roles -- --dir <dir>
```

With `ARBITRUM_SEPOLIA_RPC_URL` and `ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY` in its environment, it writes one key per role to `<dir>/<role>.key` (mode 0600, lemma-signer's key file format) and the public addresses to `<dir>/roles.json`. It refuses a directory inside the repository or one others can read, never overwrites a key, and never prints one. Run it again to top the roles up to their targets; it sends only what is missing. Keep the key files outside the repository and every synced folder, and pass a key to a command only through its environment. Production keys belong in a multisig or a hardware wallet, never in a file this script writes.

| Key | Where it lives | Pays gas for |
| --- | --- | --- |
| `facilitator.key` | Railway secret `FACILITATOR_PRIVATE_KEY` | settlements |
| `provider.key` | Railway secret `PROVIDER_PRIVATE_KEY`; also `deposit-bond` on the operator's machine | activations, expiries, and bond deposits. It is also the releases' `payTo`, so it holds every settled payment, and the registry lets it withdraw any unreserved bond (see revenue below). |
| `evaluator.key` | Railway secret `EVALUATOR_PRIVATE_KEY` | finalizations, and the credit withdrawals it relays |
| `attester.key` | Railway secret `ATTESTER_PRIVATE_KEY` | ERC-8004 feedback |
| `deployer.key` | the operator's machine only | deployments, `register-release`, `set-engine`, `set-priors`, and pause |
| `agent-owner.key` | the operator's machine only | the ERC-8004 agent's registration and updates |
| `buyer.key` | the buyer's machine, as `LEMMA_SIGNER_KEY_FILE` | nothing: the buyer pays in USDC and holds no ETH |

The server refuses to start when two of the facilitator, provider, evaluator, and attester keys are one account.

Once deployed, `npm run sepolia:check` checks the contracts, their wiring and roles, the releases, the engine's state and, with `--api`, a running server against the chain, read-only ([Checking a deployment](../docs/deployment.md#checking-a-deployment)).

## Running the warranty pipeline

- **Gas.** The provider, evaluator, facilitator, and attester each pay their own gas. The server warns at startup when one has no ETH (`warranty.sender_unfunded`, `payments.facilitator_unfunded`); a send that fails for gas is retried with backoff (`warranty.attempt_failed`, `reputation.attempt_failed`).
- **Bond.** Each activation reserves the resolution's price from its release's bond until the outcome or the expiry releases it. `npm run warranty:admin -w @lemma/server -- status` shows each release's available and reserved bond; top it up with `deposit-bond` before it runs short. An activation that finds the bond short retries for a day, then is abandoned with `warranty.bond_exhausted` (level error), and that buyer's purchase then has no warranty.
- **Failed outcomes.** With `EVALUATOR_FAILURES=review` (the default), a failed receipt waits for a decision: `npm run evaluator -w @lemma/server -- list`, then `-- decide <resolutionId> failed|void` (in the container: `node apps/server/dist/scripts/evaluator.js list`). A decision must come before the claim window closes, or the warranty expires and the action is closed: `list` shows each one's deadline, and the server logs `warranty.review_deadline` (level error) six hours before it.
- **Releases refused.** `warranty.release_refused` names a release that is not registered, is deactivated, or names another provider or evaluator. Its warranties are skipped, never signed. Register it (`register-release`) with the server's provider and evaluator.
- **Priors.** After publishing a release with frozen evidence, run `set-priors` so the engine's confidence starts from the same prior as the catalog's.
- **Revenue.** `register-release` requires a release's `payTo` to be the provider's address, and the server holds the provider's key, so the hot server key receives every settled payment and can call `withdrawUnreservedBond` to any address. A stolen key takes the revenue and every unreserved bond (reserved warranties stay backed, but new activations then fail for want of bond). On testnet, regularly move the provider's USDC above what the next `deposit-bond` needs to an address whose key stays off the server. Production needs a provider that is not a hot key (see the deferred controls in [Security Model](../docs/security-model.md#deferred-controls)).
- **The engine.** A Stylus program must be reactivated every 365 days (see the [contracts guide](../contracts/README.md#deploying)). An `EngineRecordFailed` event on the registry means an outcome reached the registry but not the engine's sums.
- **Reputation.** `reputation.self_feedback` or `reputation.no_such_agent` (level error) means the attester cannot post to `LEMMA_AGENT_ID`: the attester must not own, operate, or be approved for the agent.
- **Rehearsal.** `npm run e2e` runs the pipeline, the role script, and every admin command on a local chain (see [e2e/README.md](../e2e/README.md)).

## Release checks

Before deployment:

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

Then apply migrations, start the image, and verify `/healthz`, free preview, immutable release reads, dashboard assets, security headers, and graceful shutdown.

Enable paid tools only after a payment, a lost-response recovery, reconciliation, and the warranty addresses have passed the testnet sequence in [Deployment](../docs/deployment.md). [Enabling paid tools](../docs/deployment.md#enabling-paid-tools) lists what the server checks and what its RPC must serve.
