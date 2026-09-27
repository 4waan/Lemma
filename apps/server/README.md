# Lemma Server

`@lemma/server` hosts the remote MCP endpoint, deterministic resolver, durable resolution state, dashboard APIs, and built web application. It receives typed repository profiles, not repository source.

Free preview, recovery, persistence, read APIs, demand aggregation, dashboard serving, the x402 paid tool, ERC-8004 reputation, and the warranty outcome pipeline are implemented.

## Run locally

Start with an in-memory store:

```bash
npm run dev -w @lemma/server
```

Build and run the production entrypoint:

```bash
npm run build -w @lemma/server
npm run start -w @lemma/server
```

Set `DATABASE_URL` to use Postgres. Apply migrations before starting a Postgres-backed server:

```bash
npm run db:migrate -w @lemma/server
```

The server refuses to listen when configuration, catalog validation, provider ownership, production evidence policy, the paid path's startup (with `PAID_TOOLS=on`), the warranty registry's checks (with the warranty pipeline on), database schema, or catalog persistence is invalid.

## MCP interface

`POST /mcp` uses stateless Streamable HTTP with JSON responses. Each request receives a fresh MCP server and transport. Browser origins, batches, `GET`, and `DELETE` are rejected.

Implemented tools:

- `lemma_preview`: resolves `PreviewInput` and stores an offer-bearing preview before returning it. For a matched release whose capability has a cached ERC-8004 record, the result's `_meta["lemma/reputation"]` (core `REPUTATION_META_KEY`) is `{ passBps, count }`. `PreviewResult` itself does not change.
- `lemma_recover_resolution`: returns a settled `ResolutionDelivery` for the buyer holding the preview secret. It remains available when paid tools are disabled.
- `lemma_buy_resolution` (paid, registered per request only with `PAID_TOOLS=on`): input core `BuyInput` `{ previewId, claimHash }`, paid with x402 in `_meta["x402/payment"]`. It answers the `ResolutionDelivery` as JSON text and declares no output schema. A call that cannot be sold answers a refusal code and charges nothing.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/v1/releases` | Release identities, digests, base digests, and provenance. |
| `GET /api/v1/interest` | Dependency names the bridge may include for each capability. |
| `GET /api/v1/releases/:digest` | Immutable release manifest used by bridge verification. |
| `GET /api/v1/releases/:digest/base-probe` | Local drift targets and expected base digests. |
| `GET /api/v1/resolutions/:id` | Public resolution state and its warranty (core `WarrantyView`, from the indexed registry events; null while the warranty pipeline is off), without the buyer, recovery secret, claim, or payment reference, and dated to the day only. `no-store`. |
| `POST /api/v1/adoption-receipts` | First-write-wins outcome submission from the buyer: `{ receipt, previewId, agentId? }`, where `agentId` is the buyer's opted-in ERC-8004 agent. |
| `POST /api/v1/warranty/withdrawals` | Credit relay from the buyer's bridge: core `WarrantyWithdrawalRequest` `{ resolutionId, claimSecret, to }`. Answers 202 with `{ resolutionId, state }`, the same for the same request, or a 4xx code that queues nothing. Refuses browser requests; rate limited, `no-store`. |
| `GET /api/v1/demand` | Privacy-thresholded, closed-day demand buckets. |
| `GET /api/v1/catalog` | Dashboard catalog with evidence, sellability, compatibility confidence, each release's cached ERC-8004 record, and the distinct buyers behind both (from three up, else null). |
| `GET /api/v1/status` | Network, catalog, economics, purchase, and store status, and the chain: the explorer base (`EXPLORER_BASE_URL`), USDC, the warranty registry and its engine, the ERC-8004 registries, and the provider's agent id, each null while unused. |
| `GET /api/v1/agent/registration.json`, `GET /.well-known/agent-registration.json` | Lemma's ERC-8004 agent registration file. 404 without `PUBLIC_BASE_URL`. |
| `GET /api/v1/evidence/:resolutionId/:target` | The ERC-8004 feedback file behind one feedback (`target` is `provider` or `buyer-agent`), byte for byte as hashed. 404 until the attester has claimed a send of that feedback. |
| `GET /healthz` | Process health. |
| `GET /` and `GET /assets/:name` | Built dashboard when `apps/web/dist` is present. |

There are no public facilitator routes. The x402 facilitator runs in process, because a public one would pay gas for anyone's settlements; serving other resource servers would need its own authentication and gas budget.

## Paid path

`src/payments/` starts only with `PAID_TOOLS=on`:

- `registrar.ts` wraps `lemma_buy_resolution` with x402's `createPaymentWrapper` for a call whose preview has an open quote, with `accepts` from core `paymentRequirementsFor`.
- `handler.ts` takes the payer, nonce, and window from the verified payment, refuses a wrong nonce or payment, and calls `ResolutionService.prepare`; its settlement hook calls `commit`.
- `facilitator.ts` is the in-process `x402Facilitator` with the exact EVM scheme, for exact EIP-3009 payloads only.
- `reconciler.ts` settles or expires, every minute, the rows whose window closed without a recorded settlement, and settles a row only when the transaction that used its authorization paid the quoted amount to the quoted payee; `receipts.ts` checks Adoption Receipt signatures against the buyer.
- `chain.ts` holds the injected chain reads, and `rpc.ts` scrubs URLs from every RPC error.

[Server Runtime](../../docs/server-runtime.md#payment-seam) describes each check and job.

## Compatibility confidence

The catalog scores each profile with [`@lemma/confidence`](../../packages/confidence/README.md), the Stylus engine's crate run as wasm. The prior comes from the profile's evidence. Finalized outcomes come from an injected `OutcomeSource` (`createApp({ outcomes })`, `src/compatibility.ts`), which must answer from memory. With the warranty pipeline on, `main.ts` passes its `RegistryOutcomeSource`: exactly the outcomes the engine recorded, from the indexed registry events, and the distinct buyers behind them (`buyersFor`, published from three up). Without it, the default `NO_OUTCOMES` has none, so every evidenced profile shows its benchmark prior alone. See [Server Runtime](../../docs/server-runtime.md#catalog-compatibility-confidence) for the source contract and failure behavior.

## Reputation

`src/reputation/` publishes finalized adoption outcomes as ERC-8004 feedback on Arbitrum Sepolia and reads the public record back. It is off unless `ATTESTER_PRIVATE_KEY`, `ARBITRUM_SEPOLIA_RPC_URL`, `LEMMA_AGENT_ID`, an https `PUBLIC_BASE_URL` and `DATABASE_URL` are all set. `PUBLIC_BASE_URL` alone serves the registration file.

- `abi.ts` vendors only the functions, events and errors used from [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) at commit `b9e466c250744a7e06b13dff9d3c2844ed64f825`, and names the registries' Arbitrum Sepolia addresses. A test pins their selectors.
- `chain.ts` is the one injected `ReputationChain` over viem. It refuses an RPC endpoint of any other chain and simulates each `giveFeedback` before sending it.
- `registration.ts` builds the registration file: the MCP endpoint, `x402Support` while the paid tool is registered, the provider agent's registration once `LEMMA_AGENT_ID` is set, and `supportedTrust: ["reputation", "crypto-economic"]`.
- `evidence.ts` builds each feedback's own file (core `AdoptionFeedbackFile`), and `routes.ts` serves it and the registration file.
- `feed.ts` defines the `OutcomeFeed` of finalized outcomes. The warranty pipeline's `RegistryOutcomeFeed` implements it; without the pipeline, `main.ts` wires `noOutcomes`, so there is nothing to attest.
- `attester.ts` is the job that posts `giveFeedback` to the provider's agent, and to an opted-in buyer agent that the paying address controls. `summary.ts` caches `getSummary` per capability for the catalog and previews; the catalog adds the feed's distinct buyers (`createApp({ reputationBuyers })`).

[Server Runtime](../../docs/server-runtime.md#erc-8004-reputation) describes the attester's ledger, retries and refusals, and the summary cache. Nothing on a request path waits for the chain.

### Register the provider agent

```bash
npm run agent:register -w @lemma/server
```

The script (`src/scripts/register-agent.ts`) calls `register(agentURI)` and prints the agentId to set as `LEMMA_AGENT_ID`. `-- --update <agentId>` calls `setAgentURI` instead, and `-- --uri <https-url>` names another agentURI than `${PUBLIC_BASE_URL}/api/v1/agent/registration.json`. It reads `AGENT_OWNER_PRIVATE_KEY`, `ARBITRUM_SEPOLIA_RPC_URL`, `PUBLIC_BASE_URL` and `ERC8004_IDENTITY_REGISTRY` from the environment and refuses a key passed as an argument. The owner key must differ from the attester key, because the registry refuses feedback from an agent's owner. See [Deployment](../../docs/deployment.md).

## Warranty pipeline

`src/warranty/` runs the warranty registry's indexer and the activation, evaluation, expiry, and credit relay jobs, each on its own timer, and serves each resolution's warranty view. It is off unless `RESOLUTION_WARRANTY_REGISTRY_ADDRESS`, `PROVIDER_PRIVATE_KEY`, `EVALUATOR_PRIVATE_KEY`, `PAID_TOOLS=on`, `ARBITRUM_SEPOLIA_RPC_URL`, and `DATABASE_URL` are all set; with none of them, nothing changes.

- `chain.ts` is the one injected `WarrantyChain`. `viemWarrantyChain` implements it over viem, with one nonce-managed account per sender, and the tests use `test/fake-registry.ts`. `abi.ts` holds the registry's ABI entries the pipeline uses, copied from `contracts/abi/ResolutionWarrantyRegistry.json`; a test checks each one against that file.
- `indexer.ts` reads the registry's events into the store, a confirmation depth behind the head. `outcomes.ts` turns them into the catalog's `RegistryOutcomeSource` and the attester's `RegistryOutcomeFeed`, with their distinct-buyer counts, and `view.ts` into each resolution's `WarrantyView`.
- `activator.ts`, `evaluator.ts`, `expirer.ts`, and `relay.ts` are the jobs, over the outbox and send discipline in `actions.ts`. `routes.ts` serves the credit relay route, and `review.ts` backs the evaluator command.
- `pipeline.ts` has `startWarrantyPipeline({ config, store, index, chain, usdc, clock, logger, intervals?, start? })`. It runs the registry checks (`checkRegistry`), then returns the snapshot, the outcome source and feed, the warranty views, the five jobs, and `stop`. `main.ts` starts it after the payment path, hands its feed to the attester and its source, feed, and views to `createApp` (`outcomes`, `reputationBuyers`, `warranty`), and stops its jobs on shutdown. Pass `start: false` to drive the jobs by hand (`runOnce`).

[Server Runtime](../../docs/server-runtime.md#warranty-outcome-pipeline) describes each job, the outbox, the indexer's trust point, the relay route's codes, and the startup gates. [Reputation and Confidence](../../docs/reputation-and-confidence.md) explains what the records mean.

### Operator commands

```bash
npm run evaluator -w @lemma/server -- list
npm run evaluator -w @lemma/server -- decide <resolutionId> failed|void
```

The evaluator command (`src/scripts/evaluator.ts`) lists the failed outcomes waiting for an operator's decision, and decides one; the running server's evaluator job signs and sends it. It reads `DATABASE_URL`, needs no key, and runs the built `dist/scripts/evaluator.js`, so build first. See [Operator decisions](../../docs/server-runtime.md#operator-decisions).

```bash
npm run warranty:admin -w @lemma/server -- <command>
```

`src/scripts/warranty-admin.ts`, over `src/warranty/admin.ts` and run with tsx on the built packages, is the operator's side of the registry. It runs from the operator's machine, never the server, and [Deployment](../../docs/deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation) runs it in order:

- `status`: the registry, its engine, and each catalog release's registration, window, and bond. It needs no key.
- `register-release <releaseId@version>`: registers the release with `PROVIDER_ADDRESS`, `EVALUATOR_ADDRESS`, and its own claim window, as the registry's owner. The release must pay `PROVIDER_ADDRESS`.
- `deposit-bond <releaseId@version> <atomic USDC>`: approves and deposits bond, as the release's provider.
- `set-engine <engine address>`: points the registry at the compatibility engine, as the registry's owner. The engine must already name this registry as the one that records.
- `set-priors [<releaseId@version> ...]`: the engine's `setPrior` for each profile with frozen benchmark evidence, the same prior the catalog uses, as the engine's owner. Never a provisional prior.

`--catalog <dir>` reads another catalog, and `--provisional` adds the testnet overlay (not for `set-priors`). The script reads `ARBITRUM_SEPOLIA_RPC_URL`, `RESOLUTION_WARRANTY_REGISTRY_ADDRESS`, and the one key its command signs with from the environment: `REGISTRY_OWNER_PRIVATE_KEY` (register-release, set-engine), `PROVIDER_PRIVATE_KEY` (deposit-bond), or `ENGINE_OWNER_PRIVATE_KEY` (set-priors). It refuses a key-shaped argument, checks the chain, the registry's USDC, and the signer's role before sending, and sends nothing that is done already.

## Persistence lifecycle

Catalog objects are immutable and stored by digest so a deployment cannot strand an existing offer. Offer-bearing previews expire unless a settled resolution still needs them.

Resolutions move from `prepared` to `settled`, or to `expired` through reconciliation. A unique index keeps one payment authorization from backing more than one resolution, and conditional updates settle a resolution once. Settlement is keyed by the authorization, not the transaction, because one transaction can carry several authorizations. A resolution also keeps the buyer's warranty claim hash.

Adoption receipts are accepted only for settled resolutions and require the preview secret. They remain unverified until the receipt verifier has checked the signature against the resolution's buyer. A receipt keeps the buyer's opted-in ERC-8004 agent id (`buyer_agent_id`), which no read API shows.

`reputation_posts` is the attester's ledger: one row per finalized outcome and target (the provider's agent or the buyer's), holding that feedback's file as the bytes served and hashed.

`warranty_actions` is the warranty pipeline's outbox: one action per resolution and kind (`activate`, `finalize`, `expire`, or `withdraw`), with the core object it carries as canonical JSON, parsed again on read, its signature, state, transaction, attempts, and next attempt time. Every change is compare-and-set on the state and attempts read, and `done`, `skipped`, and `abandoned` never change. A withdrawal keeps the claim secret and refund address only until it is closed. `registry_events` holds one row per registry log the indexer read, keyed by transaction hash and log index, never with an activation's payment reference, and `chain_cursors` holds the indexer's next block, moved in the same step that stores the rows.

For the complete state transitions, locking rules, demand privacy model, and failure behavior, see [Server Runtime](../../docs/server-runtime.md).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port. |
| `DATABASE_URL` | Memory store | Postgres connection; required in production. |
| `ARBITRUM_SEPOLIA_CHAIN_ID` | `421614` | Fixed MVP chain. |
| `USDC_ADDRESS` | Arbitrum Sepolia USDC | Fixed settlement asset. |
| `PROVIDER_ADDRESS` | unset | Required when a release becomes sellable. With the warranty pipeline on, it must be `PROVIDER_PRIVATE_KEY`'s address. |
| `PAID_TOOLS` | `off` | `on` registers the paid tool and starts the reconciler and the receipt verifier. Needs the next two variables. |
| `FACILITATOR_PRIVATE_KEY` | unset | Key of the in-process facilitator, which pays settlement gas (fund it with Sepolia ETH). A secret: never logged, and no error repeats it. |
| `ARBITRUM_SEPOLIA_RPC_URL` | unset | Arbitrum Sepolia RPC for settlement, reconciliation, receipt checks, the warranty pipeline, the attester, and reputation summaries. Treated as a secret, since providers put their key in it. |
| `ALLOW_PROVISIONAL_EVIDENCE` | `false` | Loads the testnet-only catalog overlay; refused in production. |
| `OFFER_TTL_SECONDS` | `900` | Offer lifetime, bounded from 60 to 3600 seconds. |
| `PAYMENT_TIMEOUT_SECONDS` | `300` | Payment authorization lifetime, bounded from 30 to 600 seconds. |
| `DASHBOARD_ORIGIN` | unset | Sole allowed cross-origin reader of `/api/v1/*`. |
| `TRUSTED_PROXY_HOPS` | `0` | Trusted `X-Forwarded-For` appenders. Use `1` on Railway. |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-client token bucket for MCP and API routes. |
| `DEMAND_SOURCE_KEY` | Random per process | Stable secret required in production for demand address keys. |
| `PUBLIC_BASE_URL` | unset | The server's public URL. Serves the ERC-8004 registration file and prefixes every feedback URI; must be https for the attester, because feedback URIs stay on chain. |
| `LEMMA_AGENT_ID` | unset | The provider's ERC-8004 agent id, printed by the register script. The bridge's `LEMMA_AGENT_ID` is a different value: the buyer agent's. |
| `ATTESTER_PRIVATE_KEY` | unset | Signs every `giveFeedback` and needs Sepolia ETH for gas. Turns reputation on, and then requires the RPC URL, the agent id, an https `PUBLIC_BASE_URL` and `DATABASE_URL`. Must not be the agent owner's key. A secret. |
| `ERC8004_IDENTITY_REGISTRY` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | ERC-8004 identity registry on Arbitrum Sepolia. |
| `ERC8004_REPUTATION_REGISTRY` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | ERC-8004 reputation registry on Arbitrum Sepolia. |
| `ERC8004_LOG_RANGE` | `10000` | The widest `eth_getLogs` block range the attester asks for, 1 to 1000000. Lower it when the RPC provider allows less. |
| `RESOLUTION_WARRANTY_REGISTRY_ADDRESS` | unset | The warranty registry. Setting it, `PROVIDER_PRIVATE_KEY`, `EVALUATOR_PRIVATE_KEY`, or `WARRANTY_REGISTRY_START_BLOCK` turns the warranty pipeline on, which then needs all of the registry address, both keys, `PAID_TOOLS=on`, the RPC URL, and `DATABASE_URL`; startup names what is missing. |
| `PROVIDER_PRIVATE_KEY` | unset | The provider's key: it signs vouchers and sends activations and expiries, so it needs Sepolia ETH. A secret. |
| `EVALUATOR_PRIVATE_KEY` | unset | The evaluator's key: it signs outcomes and sends finalizations and credit withdrawals, so it needs Sepolia ETH. A secret. The provider, evaluator, facilitator, and attester keys (those set) must all be different accounts. |
| `WARRANTY_REGISTRY_START_BLOCK` | `0` | The registry's deployment block, where the indexer starts reading (a warning is logged while it is unset). Never set it later than the deployment block: an outcome whose activation the indexer never read cannot be counted. |
| `EVALUATOR_FAILURES` | `review` | `review`: an operator decides each failed outcome with `npm run evaluator`. `auto`: a verified failed receipt finalizes as FAILED on its own. |
| `WARRANTY_ACTIVATION_JITTER_SECONDS` | `300` | Each activation waits a random delay of up to this many seconds (0 to 86400), so it is not timed with its settlement; at low volume the amount can still match them ([Security Model](../../docs/security-model.md#warranty-pipeline-threat-model)). 0 for tests and local runs. |
| `WARRANTY_INDEXER_CONFIRMATIONS` | `64` | How many blocks behind the latest one the indexer stops (0 to 999999): it reads a block once, only after this many blocks are built on it ([Server Runtime](../../docs/server-runtime.md#the-indexer)). 0 only on a local chain that mines on transactions alone. |
| `EXPLORER_BASE_URL` | `https://sepolia.arbiscan.io` | The block explorer the dashboard links to: an http(s) base URL without credentials, query, or fragment. Set it empty to turn explorer links off; unlike every other variable, empty is not the same as unset. |

Server secrets must never enter browser-prefixed variables or API responses.

## Tests

```bash
npm run test -w @lemma/server
```

The suite drives the Hono app through a real MCP client, replays every catalog fixture, and runs the persistence contract against memory and PGlite. Run the concurrency suite against Postgres with `LEMMA_TEST_DATABASE_URL` when validating database changes.

The reputation tests replace the registries with an in-memory chain (`test/fake-reputation-chain.ts`). `test/erc8004-anvil.test.ts` runs the chain client, the attester and the register script against the official registries on a local anvil node. It runs only when `LEMMA_ERC8004_ARTIFACTS` names a `forge build` output of erc-8004/erc-8004-contracts at `b9e466c` (built as upstream builds it: OpenZeppelin 5.4, optimizer at 200 runs, via-IR), and then needs `anvil` on `PATH` or named by `LEMMA_ANVIL`:

```bash
LEMMA_ERC8004_ARTIFACTS=<forge out dir> npx vitest run apps/server/test/erc8004-anvil.test.ts
```

The payment tests run the real `x402Facilitator` against an in-memory USDC (`test/fake-chain.ts`) that recovers real EIP-3009 signatures and refuses used nonces, so no chain is needed. They cover a sale, replay, a second payment for one resolution, a wrong nonce, payee, amount, or window, expiry, no-match and bad input without a charge, late settlements, and one transaction that settles two buyers' resolutions.

The warranty tests replace the chain with a fake registry that checks real EIP-712 signatures (`test/fake-registry.ts`): the jobs, the indexer, the outcome source and feed, the review flow, the withdrawal route, and the startup gates (`test/warranty-*.test.ts`). `test/warranty-admin.test.ts` checks the admin script's ABI entries against the registry's exported ABI and the engine's interface, its arguments and refusals, and its priors. `test/warranty-anvil.test.ts` runs the jobs against the real registry on a local anvil node after `forge build` in `contracts/` (its output includes the test mocks `MockUSDC` and `RecordingEngine`), with `anvil` on `PATH` or named by `LEMMA_ANVIL`; it is skipped otherwise:

```bash
LEMMA_REGISTRY_ARTIFACTS=contracts/out npx vitest run apps/server/test/warranty-anvil.test.ts
```

`npm run e2e`, from the repository root and not part of `npm run verify`, runs the whole pipeline end to end on a local anvil: the server app and its jobs, `warranty:admin`, `agent:register`, and the bridges' purchase and refund tools, against Circle's USDC, the registry, and the official ERC-8004 registries (see [e2e/README.md](../../e2e/README.md)). CI's `e2e` job runs both.
