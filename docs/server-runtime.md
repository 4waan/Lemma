# Server Runtime

The hosted server coordinates free compatibility previews, the x402 paid path, recoverable resolution state, the catalog read API, demand aggregation, and the dashboard. Payment attaches through explicit seams rather than changing the resolver.

## Request model

`POST /mcp` creates a fresh stateless MCP server and transport for every request. Browser-origin requests, batches, unsupported methods, oversized bodies, invalid schemas, and requests that exceed the timeout fail before dispatch.

`lemma_preview` resolves the typed request against the in-memory catalog index. An offer-bearing preview is stored before it is returned. `lemma_recover_resolution` is always free and returns only settled resolutions.

With `PAID_TOOLS=on`, every request also registers the paid tool `lemma_buy_resolution` (see the payment seam below).

## Persistence

Development uses the memory store when `DATABASE_URL` is absent. Production uses Postgres through Drizzle and postgres.js. The same persistence contract runs against memory and PGlite, with a concurrency test available for real Postgres.

The store keeps immutable releases, bundles, and catalog snapshots by digest. Offer-bearing previews expire unless a settled resolution still needs them. Resolutions move from `prepared` to `settled`, or to `expired` after reconciliation. A resolution keeps the buyer's warranty claim hash from the paid call (`claim_hash`, null without one).

One payment authorization (payer and nonce) can back one resolution, and settles it once. Settlement is keyed by the authorization, not the transaction: anyone may submit EIP-3009 authorizations, so one transaction can use several, each a payment for its own resolution. `settlement_ref` records that transaction and is not unique.

Adoption receipts are accepted only for settled resolutions, from the buyer holding the preview secret, with first write winning. The receipt verifier sets `checked_at` once it reaches a verdict, and `verified` only when the signature is the buyer's.

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

## Startup gates

The production entrypoint refuses to listen unless:

- environment configuration parses;
- catalog validation passes;
- every sellable release pays the configured provider;
- provisional evidence is disabled in production;
- with `PAID_TOOLS=on`, `PROVIDER_ADDRESS`, a valid `FACILITATOR_PRIVATE_KEY`, and an `ARBITRUM_SEPOLIA_RPC_URL` are set, the RPC serves chain 421614, and the payment path starts;
- the database is reachable and migrated;
- the current catalog snapshot is persisted.

With paid tools on, startup logs the facilitator address and warns when it holds no ETH. Configuration and startup errors name the variable, never its value.

The process handles `SIGTERM` by stopping new requests, closing background work (including the reconciler and the receipt verifier), and releasing the server and database resources.

## Operational failure behavior

- No match returns a free decision and no offer.
- A catalog or migration failure prevents startup.
- Store failures are reduced to typed error codes before reaching clients.
- A settlement that outlives its call is committed later by the reconciler from USDC's log, and the buyer's bridge recovers it for free.
- An authorization that never settles expires once the chain passes its window; a new payment may re-arm the resolution.
- RPC errors are scrubbed of URLs before x402 or viem can print them, and what the facilitator hands back to x402 carries no payer, nonce, or signature, so logs never pair a wallet with a resolution id.
- Recovery uses the original preview secret and buyer, so a public resolution id is insufficient.
- Paid tools can be disabled while free preview, recovery, and read APIs remain available.
