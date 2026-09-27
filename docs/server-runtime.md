# Server Runtime

The hosted server coordinates free compatibility previews, the x402 paid path, recoverable resolution state, the catalog read API, demand aggregation, ERC-8004 reputation, the warranty outcome pipeline, and the dashboard. Payment, reputation, and the warranty attach through explicit seams rather than changing the resolver.

## Request model

`POST /mcp` creates a fresh stateless MCP server and transport for every request. Browser-origin requests, batches, unsupported methods, oversized bodies, invalid schemas, and requests that exceed the timeout fail before dispatch.

`lemma_preview` resolves the typed request against the in-memory catalog index. An offer-bearing preview is stored before it is returned. A matched preview also carries its capability's cached ERC-8004 record in `_meta["lemma/reputation"]` when one is known. `lemma_recover_resolution` is always free and returns only settled resolutions.

With `PAID_TOOLS=on`, every request also registers the paid tool `lemma_buy_resolution` (see the payment seam below).

## Persistence

Development uses the memory store when `DATABASE_URL` is absent. Production uses Postgres through Drizzle and postgres.js. The same persistence contract runs against memory and PGlite, with a concurrency test available for real Postgres.

The store keeps immutable releases, bundles, and catalog snapshots by digest. Offer-bearing previews expire unless a settled resolution still needs them. Resolutions move from `prepared` to `settled`, or to `expired` after reconciliation. A resolution keeps the buyer's warranty claim hash from the paid call (`claim_hash`, null without one).

One payment authorization (payer and nonce) can back one resolution, and settles it once. Settlement is keyed by the authorization, not the transaction: anyone may submit EIP-3009 authorizations, so one transaction can use several, each a payment for its own resolution. `settlement_ref` records that transaction and is not unique.

Adoption receipts are accepted only for settled resolutions, from the buyer holding the preview secret, with first write winning. The receipt verifier sets `checked_at` once it reaches a verdict, and `verified` only when the signature is the buyer's. A receipt keeps the buyer's opted-in ERC-8004 agent id (`buyer_agent_id`), which no read API shows.

The warranty pipeline keeps its outbox (`warranty_actions`), the registry events it indexed (`registry_events`), and its indexer cursor (`chain_cursors`); see [Warranty outcome pipeline](#warranty-outcome-pipeline).

Database migrations live under `apps/server/drizzle`. They are applied explicitly, and the server refuses to start when the schema is behind the build.

## Payment seam

`ResolutionService` exposes the state transitions the paid path wraps:

- `quote` retrieves the exact payment terms from the stored preview.
- `prepare` conditionally reserves one resolution for a verified payer and authorization, and stores the claim hash from the paid call. A second payment for the resolution gets `IN_FLIGHT` or `ALREADY_SETTLED`; an authorization that already backs another resolution gets `PAYMENT_REUSED`.
- `commit` records settlement for the authorization that settled and answers `COMMITTED`, `UNCHANGED`, or `FAILED`. It never throws into the payment response path.
- `listUnsettled` pages through prepared rows whose window closed, and `expire` frees a row only while it still holds the nonce that was judged.
- `recover` serves the free recovery tool using the preview secret and buyer.

The paid path lives in `apps/server/src/payments/` and starts only with `PAID_TOOLS=on`:

- **Registrar.** It runs for each MCP request with that request's parsed message. A `tools/call` of `lemma_buy_resolution` with a valid `BuyInput` and an open quote gets the tool wrapped by x402's `createPaymentWrapper`, with `accepts` built by core `paymentRequirementsFor` from the stored terms, never from tool arguments. Anything else (a listing, bad input, no offer, an expired quote, a store failure) gets the same tool unwrapped; it answers a code (`NOT_FOUND`, `NO_OFFER`, `QUOTE_EXPIRED`, `BAD_INPUT`, or `UNAVAILABLE`) and charges nothing. The tool declares no output schema, because x402 returns its challenge in `structuredContent`.
- **Facilitator.** One audited `x402Facilitator` with the exact EVM scheme runs in process for `eip155:421614`. It has no public endpoints, because a public facilitator would pay gas for anyone's settlements. It accepts exact EIP-3009 payloads only: x402 picks its verify path from the payload's shape, so a Permit2 payload is refused before verification. Its wallet takes transaction nonces from viem's nonce manager, so concurrent settlements do not collide.
- **Handler.** The payer, nonce, and window come from the verified payment, never from tool arguments. Before anything is stored, the handler refuses a payment to another payee or for another amount, or with a window longer than the quoted one plus a minute of clock slack (`UNSUPPORTED_PAYMENT`), and a nonce other than `derivePaymentNonce(deriveResolutionId(previewId, payer), previewId)` (`WRONG_NONCE`). It then calls `prepare`. Any refusal answers `isError`, which makes x402 cancel settlement. Otherwise it answers the `ResolutionDelivery` as JSON text, x402 settles, and the settlement hook calls `commit`.
- **Settlement reconciler.** Every minute, rows still `prepared` two minutes after their window closed are judged on chain at the head block: USDC `authorizationState(payer, nonce)`, then its `AuthorizationUsed` or `AuthorizationCanceled` log. Used commits the row with that transaction, but only when that transaction paid the quoted terms: in its receipt, the log right after `AuthorizationUsed` must be USDC's `Transfer` of exactly the quoted amount from the payer to the payee. Anything else means the buyer spent the nonce on another transfer, so the row expires (`reconcile.transfer_mismatch`) and recovery never delivers it. Unused or canceled expires it, and a new payment may then re-arm it. The window is judged by the chain's clock, so a lagging RPC node never makes a payment that could still land look unused. A run asks the chain about at most 100 rows; a row it could not decide is looked at again after a backoff that doubles from a minute to an hour.
- **Receipt verifier.** Every minute, stored receipts without a verdict are checked against the resolution's buyer with viem `verifyTypedData` over core `adoptionReceiptTypedData(receipt, 421614)`, so EOA, ERC-1271, and ERC-6492 signatures all verify. An unsigned receipt or another signer's is recorded as checked and stays unverified. A check the chain cannot answer runs again.

The jobs read the chain through an injected `PaymentChain` and `SignatureVerifier`, so tests run without a chain. Nothing on a buyer's request path reads the chain except the payment itself.

## Demand privacy

Every preview contributes to a daily demand bucket. Repository profiles and client addresses are keyed and salted before storage. Closed days collapse into counts and delete their salts and raw digests.

The public demand API exposes only buckets with at least five distinct repositories and five distinct client addresses. Closing and recording coordinate through per-day database locks so no preview is counted twice or added after closure.

## Catalog compatibility confidence

`GET /api/v1/catalog` fills `ProfileSummary.compatibility` with `@lemma/confidence`, scored at the request's clock. The prior is the profile evidence's treatment arm. Finalized outcomes come from the `OutcomeSource` passed to `createApp({ outcomes })`, keyed by release digest and profile index like the Stylus contract. With the warranty pipeline on, that is its `RegistryOutcomeSource` (see [Outcomes for the catalog and the attester](#outcomes-for-the-catalog-and-the-attester)). Without it, the default source, `NO_OUTCOMES`, returns none, so every evidenced profile shows its benchmark prior alone. A profile with neither evidence nor outcomes gets null.

A source may also answer `buyersFor(releaseDigest, profileIndex)`, the number of distinct buyers behind those outcomes, from memory too. The catalog publishes it from three up as `compatibility.buyers`; a source without it leaves every count null.

The route reads the source for every profile on every request. A source must answer from an in-memory snapshot that it refreshes in the background, never from a database or a chain. It should return a frozen array of frozen outcomes, and the same array while nothing changes: the route folds such an array once and remembers the sums by identity. Any other array is folded again on every request, which is slower but never stale.

The catalog shows the contract's number only for the same inputs: exactly the outcomes the contract recorded for that key, each dated with the block that recorded it, a prior set on chain from the same evidence, and the same time. The [confidence package guide](../packages/confidence/README.md#when-the-catalog-and-the-chain-agree) explains why.

## ERC-8004 reputation

`apps/server/src/reputation/` is off unless `ATTESTER_PRIVATE_KEY`, `ARBITRUM_SEPOLIA_RPC_URL`, `LEMMA_AGENT_ID`, an https `PUBLIC_BASE_URL`, and `DATABASE_URL` are all set. While it is off, nothing starts: previews carry no record, every release's `reputation` is null, and the server behaves as it would without it. `PUBLIC_BASE_URL` alone serves the registration file. When it is on, both jobs run on timers that never hold the process open, and no request waits for them.

- **Routes.** `GET /api/v1/agent/registration.json` and `GET /.well-known/agent-registration.json` serve the registration file, cached for five minutes; without `PUBLIC_BASE_URL` they answer 404 with `no-store`. `GET /api/v1/evidence/:resolutionId/:target` serves one feedback's file (`provider` or `buyer-agent`) byte for byte as stored, cached forever, once the attester has claimed a send of that feedback. Before that it answers 404 with `no-store`, and it stays 404 for a buyer agent's post that was skipped before any send, so the file of an agent the payer does not control is never shown.
- **Outcome feed.** The attester pages through an `OutcomeFeed` of finalized `passed` and `failed` outcomes. The warranty pipeline's `RegistryOutcomeFeed` implements it; without the pipeline, `main.ts` wires `noOutcomes`. After a restart the attester reads the feed from the start, and queueing is idempotent, so nothing is posted twice. A malformed entry is skipped and logged.
- **Ledger.** `reputation_posts` has one row per resolution and target: the provider's agent, and the buyer's agent when the receipt opted in. A row holds its feedback file as the bytes served and hashed, the attempts begun, the block before the first send, and the last transaction. `pending` rows are attempted when due; `posted` and `skipped` are final. Every change is conditional on the attempts the attester read, so two replicas never send the same attempt.
- **Attester job.** Every minute it queues new outcomes, then attempts the due posts. Each `giveFeedback` is read from the post's own stored file, so the call always equals the file its URI serves. An attempt is claimed in the ledger before its transaction is sent. The claim holds the post for five minutes, and a transaction not broadcast within two minutes of its claim, on the attester's own clock, is not sent at all, so a slow RPC never lets a send go out after another replica took the post over.
- **No double post.** A later attempt first reads the receipt of the transaction the ledger recorded, then the attester's nonce (it waits while the node shows unmined transactions of the attester), then searches from the recorded block for the attester's `NewFeedback` with the post's agent and hash. A resend uses the nonce read before the search, so if an earlier transaction is mined just after the search missed it, the node refuses the resend. Arbitrum's nodes keep no mempool, which is why the nonce matters. This relies on the RPC endpoint answering the nonce read and the search from one view of the chain. The search asks `eth_getLogs` for at most `ERC8004_LOG_RANGE` blocks at a time.
- **Retries and refusals.** Failures back off exponentially: 30 seconds, doubling, at most an hour. A chain or database failure ends the tick; a revert affects only its post, and a mined but reverted transaction is sent again after the search. A buyer agent the paying address neither owns nor has as its agent wallet is skipped (`AGENT_NOT_BUYER`), and so is a post whose file names another attester or identity registry after a key or registry change (`FILE_MISMATCH`). Before it posts anything, the attester asks the identity registry whether it would refuse feedback to the provider's agent, as self-feedback or to no agent, and if so stops, logging `reputation.self_feedback` or `reputation.no_such_agent`. A refusal met later while sending stops it the same way for the provider's agent, and skips a buyer agent's post.
- **Summary cache.** `getSummary(LEMMA_AGENT_ID, [attester], "lemma.adoption", capability)` is cached per capability for five minutes. A background check every minute refreshes the catalog's capabilities once their record is five minutes old, and a request that finds a record stale refreshes it in the background. A failed read keeps serving the last value, or null, and is retried after a minute. Previews and the catalog read only the cache. The catalog adds the distinct buyers behind the capability's outcomes from the feed (`createApp({ reputationBuyers })`), from three up; a preview's `_meta["lemma/reputation"]` stays `{ passBps, count }`.

## Warranty outcome pipeline

`apps/server/src/warranty/` turns each paid resolution with a warranty claim into the warranty registry's records, and the registry's events into the catalog's compatibility confidence, the attester's feed, and each resolution's warranty view. [Reputation and Confidence](reputation-and-confidence.md) explains what those records mean. Every job runs on a timer that never holds the process open, handles a bounded batch per run (25 rows for the outbox jobs, 50 log ranges for the indexer), backs off on failure, and never throws out of its loop. No request waits for a job, and no agent tool call reads the chain.

### When it runs

The pipeline is on only when `RESOLUTION_WARRANTY_REGISTRY_ADDRESS`, `PROVIDER_PRIVATE_KEY`, `EVALUATOR_PRIVATE_KEY`, `PAID_TOOLS=on`, `ARBITRUM_SEPOLIA_RPC_URL`, and `DATABASE_URL` are all set. Setting any of `RESOLUTION_WARRANTY_REGISTRY_ADDRESS`, `PROVIDER_PRIVATE_KEY`, `EVALUATOR_PRIVATE_KEY`, or `WARRANTY_REGISTRY_START_BLOCK` without the rest refuses startup, and the error names what is missing, never a value.

With none of them set, the pipeline stays off and nothing else changes: every `ResolutionView.warranty` is null, the status shows no registry or engine, the withdrawal route answers `WARRANTY_OFF`, the catalog shows benchmark priors alone, and the attester has nothing to post.

### Senders and the chain client

Every chain call goes through one `WarrantyChain` (`chain.ts`): viem public and wallet clients on the configured RPC, with errors scrubbed of its URL. Tests replace it with a fake registry that checks real signatures.

| Call | Signed by | Sent by, paying the gas |
| --- | --- | --- |
| `activateResolution` | the provider (the voucher) | the provider |
| `expireResolution` | nobody | the provider, which gets its bond back |
| `finalizeOutcome` | the evaluator (the outcome) | the evaluator |
| `withdrawCredit` | nobody: the buyer's claim secret authorizes it | the evaluator |

The facilitator, which settles payments, sends none of them: its transaction order would put a buyer's settlement next to the activation it paid for. Each sender has one account with viem's nonce manager, shared by every job that sends from it, and its sends go out one at a time. Every call is simulated from its sender first, and its gas is the node's estimate plus a fifth.

### The outbox

`warranty_actions` holds one action per resolution and kind (`activate`, `finalize`, `expire`, or `withdraw`), with the core object it carries as canonical JSON (see [Protocol](protocol.md#outbox-and-relay-objects)), its signature, state, attempts, and next attempt time. States are `review` (a failed outcome waiting for an operator), `queued`, `sent` (an attempt began, so a transaction may be out), and the final `done`, `skipped` (not applicable, nothing sent), and `abandoned` (given up). Every change is compare-and-set on the state and attempts read, and a final state never changes.

The four sending jobs share the attester's send discipline (`ActionSender`):

- **Claim before sending.** An attempt moves the action to `sent`, with one more attempt, the payload and signature about to be sent, and a lease of at least five minutes, before anything is broadcast. A send not broadcast within two minutes of its claim is not sent at all.
- **Look before a resend.** A later attempt first reads the receipt of the recorded transaction, then the sender's nonces (it waits while the sender has unmined transactions), then the registry's state, which closes the action when its effect already happened, by this job or anyone. The resend carries the nonce read before that check, so an earlier transaction mined meanwhile makes the node refuse it. One transaction is out per action at a time.
- **The chain's clock, fresh.** Every deadline is judged by the head block's time, read at the start of a run and again before an attempt once that reading is five seconds old, so the last actions of a slow batch are not judged by a clock minutes old. A resolution's state and its claim deadline in force are read at one block, so two nodes behind one endpoint never pair an active warranty with no deadline.
- **Reverts become codes.** A registry revert is decoded from its custom error into an upper snake case code, such as `INSUFFICIENT_AVAILABLE_BOND` or `CLAIM_WINDOW_CLOSED`, which decides the next step. Any other failure backs the action off: 30 seconds, doubling to an hour, plus up to a fifth more at random from `crypto.randomInt`.
- **Logs.** Codes and resolution ids only, never a key, a payer, a claim secret, or a refund address.

### The indexer

Every 15 seconds, `RegistryIndexer` reads the registry's logs from `WARRANTY_REGISTRY_START_BLOCK` (default 0), or from where its cursor stopped, up to `WARRANTY_INDEXER_CONFIRMATIONS` blocks behind the latest one (default 64, about 16 seconds of Arbitrum's blocks). It reads ranges of up to 10,000 blocks, at most 50 per run. A range the RPC refuses is halved, down to one block, and the span grows back after each stored range. Logs the node marks removed are skipped.

It reads each block once, so the depth is what keeps a wrong read out. Plain `eth_getLogs` never marks a log that a reorg took back as removed, and one backend of a load-balanced RPC endpoint that lags another answers a range past its own head with the logs it has, and no error. Read at the head, the first would leave a finalization that never happened in the index (and the attester would post it), and the second would drop an activation for good (so its warranty would never be finalized or expired). The indexer trusts that no reorg goes deeper than the depth and that the node answering `eth_getLogs` is never further behind than that. It keeps no block hashes, so it cannot detect a deeper fork. Raise the depth for an endpoint that lags more; every indexed step waits for it.

It stores `ResolutionActivated`, `OutcomeFinalized`, `EngineRecordFailed`, `ResolutionExpired`, `CreditWithdrawn`, `EngineSet`, `Paused`, and `Unpaused` in `registry_events`, with their block times and without an activation's payment reference. Its cursor (`warranty-registry` in `chain_cursors`) moves in the same store step as the rows, and only from where the run found it, so a crash reads a range again (each log is stored once) and two indexers never both advance.

It is the only source of chain facts. After each run, an in-memory snapshot takes in the new rows, and the catalog, the attester's feed, and the warranty view read that snapshot and the stored rows, never the chain. An outcome whose activation lies before the start block cannot be keyed to a profile and is left out (`warranty.outcome_unkeyed`, `NO_ACTIVATION`), so the start block must be the registry's deployment block or earlier.

### The jobs

Every 30 seconds, each job writes an action for what it newly finds and attempts the due ones:

- **Activator.** For each settled resolution bought with a claim, an `activate` action, whose voucher's `paymentRef` is made once and kept in the action. It is due after a random delay of up to `WARRANTY_ACTIVATION_JITTER_SECONDS` (default 300), so an activation is not timed with its settlement (what that does not hide at low volume is in [Security Model](security-model.md#warranty-pipeline-threat-model)). Before signing, the release must be registered and active on the registry with this provider and evaluator; otherwise the action is `skipped` with `RELEASE_NOT_REGISTERED`, `RELEASE_INACTIVE`, or `RELEASE_ROLES_MISMATCH`, and nothing is signed. The provider signs the voucher, and signs it again, with the same `paymentRef`, when its `activateBy` comes near; [Protocol](protocol.md#vouchers-and-outcomes) gives the voucher's fields and signing window. A short bond (`INSUFFICIENT_AVAILABLE_BOND`) is retried for 24 hours; then the action is `abandoned` as `BOND_EXHAUSTED`, and `warranty.bond_exhausted` is logged at error level. An operator registers releases with this provider and evaluator and deposits their bonds with `npm run warranty:admin -w @lemma/server` ([runbook](deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation), steps 5 and 6).
- **Evaluator.** For each active warranty with a verified receipt, a `finalize` action. A receipt that `passed` is PASSED and one `abandoned` VOID; one that `failed` is FAILED with `EVALUATOR_FAILURES=auto`, and otherwise waits in `review` for an operator. The weight is 10000, or 0 under [the damper](reputation-and-confidence.md#the-damper), and VOID always weighs 0. The evaluator signs the outcome and sends it; [Protocol](protocol.md#vouchers-and-outcomes) gives its evidence hash and signing window. A warranty no longer active or a closed claim window ends the action: `done` when the warranty was finalized, `abandoned` otherwise. A warranty without a verified receipt is never finalized; it runs to its expiry.
- **Expirer.** For each active warranty whose deadline set at activation is behind the chain's clock and that has no finalization queued or sent, an `expire` action. Before sending, the registry's `claimDeadlineOf` decides, because every second the registry was paused moves the deadline later: the expiry is sent at least a minute past the claim deadline in force, and while a finalization of the same warranty is queued or out, it looks again every five minutes. A warranty that expired meanwhile, by anyone, closes the action `done`, and one finalized meanwhile closes it `skipped`.
- **Credit relay.** Sends each queued `withdraw` action. It closes `done` when the credit was withdrawn, by it or anyone, and `abandoned` when there is no credit. It works while the registry is paused, as the registry does. A closed action keeps only the resolution id: the claim secret and refund address are gone.

### Operator decisions

With `EVALUATOR_FAILURES=review`, the default, a failed receipt's outcome waits in `review` until an operator decides it:

- `npm run evaluator -w @lemma/server -- list` prints each outcome waiting: the resolution id, release, profile, the receipt's outcome and exit code, and how long it has waited. Nothing about the buyer.
- `npm run evaluator -w @lemma/server -- decide <resolutionId> failed|void` queues it as FAILED (the buyer's credit, with the weight the evaluator gave it, so the damper still applies) or VOID (no credit, weight 0). The running server's evaluator job signs and sends it.

The command reads `DATABASE_URL` and needs no key. It runs the built `dist/scripts/evaluator.js`, so build first; in the server's image, run `node apps/server/dist/scripts/evaluator.js list`. Deciding twice, or after the warranty ended, changes nothing, and an outcome still in review when its warranty ends is closed as `WARRANTY_ENDED`.

### Credit relay route

`POST /api/v1/warranty/withdrawals` takes the claim the buyer's bridge kept: `{ resolutionId, claimSecret, to }` (core `WarrantyWithdrawalRequest`, strict). The server checks that `warrantyClaimHash(resolutionId, claimSecret, to)` equals the claim hash stored with the resolution, and that the indexed events show the warranty finalized FAILED with its credit not withdrawn. It then queues one `withdraw` action and answers 202 with `{ resolutionId, state }`, where `state` is `queued`, `sent`, `done`, or `abandoned`. The same request answers that action's state from then on.

A refusal queues nothing and answers `{ error }`:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Not a strict `WarrantyWithdrawalRequest`. |
| 403 | `BROWSER_REQUEST` | The request carried an `Origin` header; only the bridge posts here. |
| 403 | `CLAIM_MISMATCH` | The secret and address do not make the stored claim hash (either one wrong). |
| 404 | `UNKNOWN_RESOLUTION` | No such resolution, or one bought without a claim. |
| 404 | `WARRANTY_OFF` | The server runs no warranty pipeline. |
| 409 | `NO_CREDIT` | The indexed registry shows no outstanding credit. |

The route is rate limited with the rest of `/api/v1` (429) and never cached, and a store failure answers 500, so the bridge asks again. The claim secret can only pay the refund address it was committed with, so relaying it is safe; it is never logged.

### Outcomes for the catalog and the attester

- **Confidence.** `RegistryOutcomeSource`, the catalog's `OutcomeSource`, answers exactly the outcomes the engine recorded for a release digest and profile index: indexed `OutcomeFinalized` rows with verdict PASSED or FAILED and a weight above zero, finalized while the most recently set engine was in force, and with no `EngineRecordFailed` in their transaction. Each is dated with its block's time, in chain order, and the same frozen array comes back while nothing changes.
- **Reputation.** `RegistryOutcomeFeed`, the attester's `OutcomeFeed`, hands over every PASSED or FAILED outcome with a weight above zero, recorded by the engine or not, in chain order, with the cursor `<block>:<logIndex>`. It passes over an outcome whose release left the catalog (`RELEASE_NOT_IN_CATALOG`) or whose receipt the server does not hold (`NO_RECEIPT`).
- **Buyers.** Both count the distinct payers behind their outcomes, per release and profile for the catalog's confidence and per capability for its adoption record. The read models publish a count from three up. An outcome of a resolution this server did not sell has no known payer and counts for none.

### Warranty and chain views

`GET /api/v1/resolutions/:id` carries `warranty` (core `WarrantyView`), built from the indexed events and the outbox. Before activation it is `pending` while a settled resolution with a claim waits for its activation, and `none` when none will come (no claim, not settled, or the activation was skipped or abandoned). After activation it is `active`, `passed`, `failed`, `refunded`, `void`, or `expired`, with the amount, the claim deadline in force, and each transaction, including the attester's posted feedback to the provider's agent.

`GET /api/v1/status` carries `chain` (core `ChainView`): the explorer (`EXPLORER_BASE_URL`), USDC, the warranty registry and the engine it records into (from the last indexed `EngineSet`), the ERC-8004 identity registry and the provider's agent id (with `LEMMA_AGENT_ID`), and the reputation registry (while the attester runs). Each is null while the server does not use it.

## Startup gates

The production entrypoint refuses to listen unless:

- environment configuration parses;
- catalog validation passes;
- every sellable release pays the configured provider;
- provisional evidence is disabled in production;
- with `PAID_TOOLS=on`, `PROVIDER_ADDRESS`, a valid `FACILITATOR_PRIVATE_KEY`, and an `ARBITRUM_SEPOLIA_RPC_URL` are set, the RPC serves chain 421614, and the payment path starts;
- the database is reachable and migrated;
- the current catalog snapshot is persisted;
- `PUBLIC_BASE_URL`, when set, is an http(s) URL without credentials, query, or fragment, and a set `ATTESTER_PRIVATE_KEY` comes with the RPC URL, `LEMMA_AGENT_ID`, an https `PUBLIC_BASE_URL`, and `DATABASE_URL`;
- with any warranty setting, every setting the pipeline needs is set, and no two of the provider, evaluator, facilitator, and attester keys that are set belong to one account;
- with the warranty pipeline on, its chain client and registry pass their checks.

Before any warranty job starts, the pipeline checks the chain client and the registry, and a failed check stops the server with a `WarrantyStartupError` whose message names addresses and codes only:

- the client works on chain 421614 (`WRONG_CHAIN`), its first read refuses an RPC endpoint of another chain, and its registry, provider, and evaluator are the configured ones (`REGISTRY_MISMATCH`, `SENDER_MISMATCH`);
- the registry holds bonds in the configured USDC (`REGISTRY_TOKEN_MISMATCH`);
- the registry's `hashVoucher` of a fixed probe voucher equals core's typed-data hash, so its EIP-712 domain and layout are the ones the server signs (`REGISTRY_DOMAIN_MISMATCH`).

With paid tools on, startup logs the facilitator address and warns when it holds no ETH. With reputation on, it logs `reputation.on` with the attester address; the chain is first checked by the jobs, never at startup. With the warranty pipeline on, it logs `warranty.on` with the registry, provider, and evaluator addresses and the indexer's depth, and warns when `WARRANTY_REGISTRY_START_BLOCK` is unset (`warranty.start_block_unset`) and when a sender holds no ETH (`warranty.sender_unfunded`). Configuration and startup errors name the variable, never its value.

The process handles `SIGTERM` by stopping new requests, closing background work (including the reconciler, the receipt verifier, the reputation jobs, and every warranty job), and releasing the server and database resources.

## Operational failure behavior

- No match returns a free decision and no offer.
- A catalog or migration failure prevents startup.
- An outcome source that throws, or returns an outcome the engine cannot represent, costs only that profile its compatibility confidence (null, logged as `catalog.compatibility_failed` with the release digest and profile index). The rest of the catalog is served.
- Store failures are reduced to typed error codes before reaching clients.
- A settlement that outlives its call is committed later by the reconciler from USDC's log, and the buyer's bridge recovers it for free.
- An authorization that never settles expires once the chain passes its window; a new payment may re-arm the resolution.
- RPC errors are scrubbed of URLs before x402 or viem can print them, and what the facilitator hands back to x402 carries no payer, nonce, or signature, so logs never pair a wallet with a resolution id.
- Recovery uses the original preview secret and buyer, so a public resolution id is insufficient.
- A chain or RPC failure in the attester or the summary reader never reaches a request: posts wait with backoff, and previews and the catalog serve the last known record or none.
- A chain or store failure in a warranty job is logged by name and code and retried with backoff; no request sees it. The catalog, the attester, and the warranty view read memory and the store only, so an RPC outage delays new facts and never fails a request.
- A crash between a warranty send and its record never sends twice: the next attempt finds the transaction's receipt, the sender's pending nonce, or the registry's state first.
- A registry pause moves every claim deadline later. Activation and finalization back off while paused, the expiry waits for the new deadline, and withdrawals keep working.
- A release without enough available bond is retried for 24 hours, then abandoned with an alert.
- Paid tools can be disabled while free preview, recovery, and read APIs remain available.
