# End-to-end run on a local chain

`npm run e2e` runs the whole outcome pipeline against real contracts on a local anvil posing as Arbitrum Sepolia: a buyer's agent pays through its bridge, the server activates the warranty, the agent's tests pass or fail, the evaluator finalizes, the registry records into the compatibility engine, the server indexes it all, the catalog and ERC-8004 reputation move, and failed purchases are refunded. It is not part of `npm run verify`; CI runs it as the `e2e` job.

## What you need

- Node 22 and `npm ci`.
- Foundry (`anvil`, `forge`) on `PATH`; CI pins v1.7.1. `forge` compiles with solc 0.8.30: offline, set `FOUNDRY_OFFLINE=true` and have it installed (`~/.svm`).
- The contract submodules: `git submodule update --init`.
- No network, no RPC and no secret. Every key is made at run time; anvil starts with no accounts (`--accounts 0`), so its public dev mnemonic is never used.

## What it runs

`e2e/prepare.ts` checks the tools and the bytecode fixtures ([fixtures/README.md](fixtures/README.md)), builds the workspaces (`tsc -b`: the operator scripts run as processes on the built packages) and runs `forge build` in `contracts/` and `e2e/contracts/`. Then vitest runs `outcome-pipeline.e2e.ts`, in order:

1. **Setup, the runbook's way.** Circle's FiatTokenV2_2 at the Arbitrum Sepolia USDC address; `npm run sepolia:roles` (`ops/sepolia/setup-roles.ts`) makes and funds the role keys from a funder; the deployer deploys the warranty registry (the `contracts/` build) and the engine; the official ERC-8004 registries are deployed through their upgrade chain; `warranty-admin` runs `status`, `set-engine`, `register-release`, `deposit-bond` and `set-priors`, each refusal checked before anything is sent; `register-agent` registers the provider's agent. Then the server starts on those settings.
2. **Scenario 1, pass:** preview, purchase and settlement through the bridge's buy tool and in-process signer, activation, a passing acceptance run and signed receipt, PASSED, the engine's record, the catalog's confidence (checked against `@lemma/confidence` folding the chain's own block times), the attester's feedback, `getSummary`, and the evidence file's hash.
3. **Scenario 2, refund:** another buyer's tests fail, `EVALUATOR_FAILURES=auto` finalizes FAILED, the agent claims the refund with the bridge's `lemma_claim_refund` (its answer names the resolution and the amount, never the claim secret or the refund address), the evaluator relays it, the refund address receives the price, and the tool asked again answers `refunded`.
4. **Scenario 4, damper:** one buyer, four repositories, four passing outcomes on one profile: the fourth finalizes with weight 0, and the engine, the catalog (five outcomes from three buyers, so the buyer count is published) and ERC-8004 never count it.
5. **Scenario 5, crash safety:** the server dies right after the activator broadcasts an activation and before it records the hash; a restarted server leaves the action alone while the dead attempt's lease holds, then reads the nonces and the registry and closes it without a second send.
6. **Scenario 6, the shipped programs:** a buyer set up as the bridge's README says (`lemma-signer init`, then `lemma-signer serve` with the spending policy) and the real `lemma-mcp` process, spoken to over stdio as an agent's MCP client does, buy, apply and verify; the purchase passes like scenario 1's. The other scenarios run the same bridge code in process.
7. **Scenario 3, expiry:** a purchase with no receipt; the chain's clock passes the claim deadline and the provider expires the warranty. It runs last because it moves the chain's clock an hour ahead of the wall clock that x402 authorizations follow.
8. No log line or script output holds a key or claim secret, and no log line a buyer or refund address.

## What differs from Arbitrum Sepolia

- **The engine.** anvil cannot run Stylus. `e2e/contracts/src/ConfidenceStandIn.sol` has the Stylus engine's constructor, owner and registry checks, `setPrior`, `record` and `stats`, and records each call like the registry's `RecordingEngine` mock; it computes no confidence (the server does, with the same crate compiled to wasm). The Stylus contract itself is covered by its Rust tests.
- **The registry deployment.** The run deploys the `contracts/` build directly. The Sepolia deployment uses `contracts/script/DeployRegistry.s.sol`, which `npm run contracts:rehearse` rehearses on anvil.
- **The server's process.** The run assembles the server as `apps/server/src/main.ts` does (the same app, payment path, pipeline and reputation jobs; `e2e/lib/server.ts`), with an in-process PGlite database behind the same `PgStore`, and job intervals of a fraction of a second instead of 15 s to a minute.
- **Blocks.** anvil mines each transaction at once and also makes a block every second, as a live chain goes on making blocks. The indexer reads 2 blocks behind the head (`WARRANTY_INDEXER_CONFIRMATIONS=2`) instead of the default 64, so each indexed step waits about two seconds.
- **The catalog.** A one-release catalog written for the run (made-up evidence and economics, testnet prices), read with `loadCatalog({ root })`; the admin commands read it with `--catalog`.
- **The bridge's signer.** Every scenario but the sixth runs the bridge in process with `LocalSigner`, where a buyer runs `lemma-signer serve`; the wiring around it is the bridge's own (`paymentsFromEnv`, `adoptionTools`). Scenario 6 runs the shipped `lemma-signer` and `lemma-mcp` programs (`e2e/lib/agent.ts`).

## When it fails

The failing assertion names the step. The tail of the server's log (JSON lines, with the run's keys and claim secrets masked) follows on stderr; `LEMMA_E2E_SERVER_LOG=<file>` writes the whole log. Nothing survives the run: anvil stops and the temporary directory (keys, workspaces, catalog) is deleted.
