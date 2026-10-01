# Lemma Warranty Registry

This Foundry workspace holds `ResolutionWarrantyRegistry`, the Arbitrum Sepolia contract that backs paid Compatibility Resolutions with provider-funded USDC. x402 stays the payment rail. The registry adds bounded recourse after payment, not a custom escrow.

The contract, its tests, exported ABIs, and a fail-closed deploy script are in place. The server's warranty pipeline signs and sends its vouchers, outcomes, expiries, and credit withdrawals, and `npm run e2e` runs them against this contract on a local chain. It is not deployed or audited. Do not treat it as safe for funds. Still open: deploy it, verify the bytecode on Arbitrum Sepolia, and take one real paid resolution through the pass path and one through the refunded failure path, as the [runbook](../docs/deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation) does. The [Warranty Registry Review](../docs/warranty-registry-review.md) records how it was checked so far.

## Layout

| Path | Contents |
| --- | --- |
| `src/ResolutionWarrantyRegistry.sol` | The registry. Its NatSpec documents every function, event, and error. |
| `src/interfaces/ICompatibilityEngine.sol` | The engine hook. The Stylus compatibility-confidence contract must keep its exact `record` signature. |
| `script/` | `DeployRegistry.s.sol` (deployment and record), `rehearse-deploy.sh` (local rehearsal), and `export-abi.mjs` (ABI export). |
| `abi/*.json` | ABIs for TypeScript, checked against the build in CI. |
| `test/` | Unit, fuzz, invariant, vector, pause, engine, and deploy-script tests, with mocks in `test/utils/`. |
| `lib/` | OpenZeppelin Contracts and forge-std, pinned git submodules. |

## State machine

The owner registers a Capability Release with its provider, its evaluator, and a claim window. The provider deposits USDC bond. After x402 settlement, a provider-signed voucher activates one warranty and reserves bond equal to the covered price.

The release's evaluator can finalize the warranty up to and including its claim deadline. PASSED releases the reservation. FAILED turns it into the buyer's withdrawal credit. VOID, for an ineligible or abandoned run, releases it and records nothing. Without an outcome, anyone can expire the warranty after the deadline, which releases the reservation without claiming that the software passed. A PASSED or FAILED outcome with a nonzero weight is also recorded with the compatibility engine.

A warranty moves from `None` to `Active`, from `Active` to `Passed`, `Failed`, `Voided`, or `Expired`, and from `Failed` to `Refunded` when its credit is withdrawn. No other move exists.

Full manifests, profiles, patches, and test output remain offchain. The contract stores identifiers, typed-signature commitments, role addresses, deadlines, and accounting state. It has no upgradeability, token, governance, or general arbitration.

## Interface

Amounts are atomic USDC (six decimals) as `uint256`. `constructor(IERC20 usdc, address initialOwner)` needs a token contract and a nonzero owner.

| Function | Caller | While paused | Effect |
| --- | --- | --- | --- |
| `registerRelease(releaseDigest, provider, evaluator, claimWindowSeconds)` | owner | allowed | Registers a release once. Every argument is nonzero, and provider and evaluator differ. |
| `setEngine(newEngine)` | owner | allowed | Sets the engine contract, or disables it with zero. |
| `depositBond(releaseDigest, amount)` | anyone | blocked | Pulls USDC from the caller into an active release's available bond. |
| `withdrawUnreservedBond(releaseDigest, amount, to)` | the release's provider | allowed | Pays out unreserved bond, also after deactivation. |
| `deactivateRelease(releaseDigest)` | owner or provider | allowed | Stops new activations. Active warranties keep running. |
| `activateResolution(voucher, providerSignature)` | anyone | blocked | Reserves the voucher's amount and opens the claim window. |
| `finalizeOutcome(outcome, evaluatorSignature)` | anyone | blocked | Applies the verdict, up to and including the claim deadline in force. |
| `expireResolution(resolutionId)` | anyone | blocked | Releases the reserved bond after the claim deadline in force. |
| `withdrawCredit(resolutionId, claimSecret, to)` | anyone | allowed | Pays a FAILED resolution's credit to the committed `to`, once. |
| `pause()`, `unpause()` | owner | | Stops or resumes the blocked functions and the claim clock. |

Views return the stored state (`release`, `resolution`, `totals`, `paymentRefUsed`, `engine`, `usdc`), the claim deadline in force (`claimDeadlineOf`), the total paused time (`pausedSeconds`), and the digests to sign (`hashVoucher`, `hashOutcome`, and EIP-5267 `eip712Domain`). `resolution(id).claimDeadline` and the `ResolutionActivated` event keep the deadline set at activation.

Ownership moves in two steps, with `transferOwnership` and `acceptOwnership`. `renounceOwnership` is disabled, because without an owner a paused registry could never finalize again.

## Signed messages

Vouchers and outcomes are EIP-712 typed data under the domain `{ name: "Lemma Warranty Registry", version: "1", chainId, verifyingContract }`, with no salt:

```text
Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)
Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)
```

- `amount` is atomic USDC.
- `paymentRef` is an opaque reference to the settled payment, chosen by the server; Lemma's server makes 32 random bytes per resolution. It is never a public function of payer and nonce, and each one activates once.
- `claimHash = keccak256(abi.encode(bytes32 resolutionId, bytes32 claimSecret, address refundTo))`.
- `verdict` is 1 PASSED, 2 FAILED, or 3 VOID. `weightBps` is 0 to 10000.
- `activateBy` and `validUntil` are the last timestamps at which the voucher or the outcome may be submitted.

[Protocol](../docs/protocol.md#payment-and-warranty-boundary) says which component makes the claim hash and the payment reference, and who signs and relays each message. `test/Vectors.t.sol` pins a claim hash, a voucher digest, and an outcome digest computed with viem, and `@lemma/core`'s tests reproduce them from its copy of the layouts (`packages/core/src/warranty.ts`). The test also checks every digest against Foundry's own EIP-712 encoder.

## Roles

| Role | Holds | Can |
| --- | --- | --- |
| Owner | Registry administration. A multisig is recommended. | Register releases, set the engine, pause, and deactivate a release. Cannot move bond or credit. |
| Provider, per release | The release's bond. Signs vouchers. | Deposit, withdraw unreserved bond, and deactivate its release. |
| Evaluator, per release | Signs outcomes. | Decide PASSED, FAILED, or VOID for that release's active warranties. |
| Relayer, anyone | Gas. | Submit vouchers, outcomes, expiries, and credit withdrawals, without being able to change them. |
| Buyer, off chain | The claim secret and refund address. | Unlock its own credit through any relayer. |
| Engine, a contract | The compatibility-confidence record. | Receive `record(...)` calls, and nothing else. |

The provider and the evaluator may each be an EOA or an ERC-1271 smart account, through OpenZeppelin `SignatureChecker`, so a smart account can rotate its keys without a new release. The evaluator is a separate team-operated key for the MVP. This is bounded recourse, not decentralized correctness arbitration.

## Pause and the claim clock

A pause stops deposits, activations, finalizations, and expiries, and it stops the claim clock. The registry counts its paused seconds and snapshots the count at activation. Finalization and expiry use the deadline in force: the deadline set at activation plus the time paused since, an ongoing pause included.

So a pause never costs a buyer its window. After the unpause, a warranty has exactly the seconds it had left when the pause began, and a window that had already closed stays closed. Unreserved bond and buyer credits stay withdrawable while paused. `activateBy` and `validUntil` are not extended, because their signers can sign again. An owner that never unpauses leaves reserved bond locked. `test/RegistryPause.t.sol` covers this.

## Invariants

- Storage holds hashes and accounting only, never a buyer or payer address. `test_activate_storesNoAddress` scans every storage slot activation writes.
- Signatures are bound to the chain and this contract. Expired messages, replayed resolution ids and payment references, wrong signers, and claims that do not match the committed hash are rejected.
- The provider cannot withdraw reserved bond, and deactivating a release does not invalidate its active warranties.
- A deposit fails closed if the token delivers a different amount than asked, as a fee-on-transfer USDC would.
- Every state change follows checks, effects, then interactions, under `nonReentrant`. Credits are pulled, never pushed.
- The engine call gets exactly `ENGINE_GAS_LIMIT` (300,000) gas inside `try/catch`. Any engine failure emits `EngineRecordFailed(resolutionId)`, and the finalization stands. A caller that leaves too little gas for that budget gets `InsufficientGasForEngine`, so a relayer cannot starve the engine on purpose.
- `usdc.balanceOf(registry) >= totalAvailable + totalReserved + totalCredits`, and each total equals its sum over releases or resolutions. The only surplus is USDC sent straight to the contract, which has no sweep function.
- Six-decimal accounting is tested explicitly.

`test/invariant/` checks the accounting after every call of random handler sequences. Operations that must fail must fail with their expected error.

## Limits

- Nothing on chain checks the x402 payment. The provider's voucher must carry the amount actually paid. It activates only if the release has that much available bond when it is submitted, by `activateBy`.
- Resolution ids and payment references are global, not per release, so both must stay private until the warranty is active (see [Security Model](../docs/security-model.md#required-controls)). Keying warranties by release would close this, but it needs the release digest in `Outcome`.
- A smart-account role's `isValidSignature` gets all remaining gas, so relayers must simulate each submission and cap its gas. An EOA role that delegates its code with EIP-7702 is checked the same way, so its plain signatures stop working unless the delegate implements `isValidSignature`.
- With an engine set, `finalizeOutcome` needs about 325,000 gas left for the engine step. A failed engine call is only an event, with no on-chain retry.
- Roles are fixed per release, a release digest registers once, and a deactivated release stays deactivated. Handle a compromised provider or evaluator key by pausing and deactivating. A new version is a new digest.
- Withdrawal makes the refund address public next to the resolution id. A buyer that wants its purchase to stay unlinkable commits to a fresh refund address.
- Timestamps come from the Arbitrum sequencer. Claim windows and voucher and outcome lifetimes should be hours or more.

The trust the registry places in its evaluator, providers, owner, and USDC is in [Security Model](../docs/security-model.md#accepted-mvp-trust).

## Development

From the repository root, with Foundry on `PATH` (and `jq` for the rehearsal):

```bash
git submodule update --init
npm run contracts:build
npm run contracts:test
npm run contracts:abi -- --check
npm run contracts:rehearse
```

The tests, the ABI export, and the rehearsal run with `FOUNDRY_OFFLINE=true`, so they need no network once `lib/` is checked out and solc 0.8.30 is installed. A plain `forge build`, as in `contracts:build` and the CI build step, downloads solc when it is missing. The CI `contracts` job pins Foundry v1.7.1 and runs `forge fmt --check`, the build, the tests, the ABI check, and the rehearsal.

### Dependencies

Solidity dependencies are git submodules under `lib/`, pinned to release tags. The build needs only the top level: OpenZeppelin's own nested submodules are never compiled, and CI does not fetch them.

| Dependency | Path | Tag | Commit |
| --- | --- | --- | --- |
| OpenZeppelin Contracts | `lib/openzeppelin-contracts` | `v5.6.1` | `5fd1781b1454fd1ef8e722282f86f9293cacf256` |
| forge-std | `lib/forge-std` | `v1.16.2` | `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` |

`remappings.txt` maps `@openzeppelin/contracts/` and `forge-std/` to these trees, and `foundry.toml` turns off remapping auto-detection, so a nested submodule cannot change an import. To move a pin, check out the new tag inside the submodule, commit the gitlink, and update this table. `.gitleaks.toml` skips these two trees, and nothing else under `lib/`, because their public test fixtures trip the generic secret rules.

The registry uses OpenZeppelin `EIP712`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, and `SignatureChecker`, and no hand-written signature, hashing, or token-transfer code. The compile target is Cancun, because OpenZeppelin v5.6 uses `MCOPY`. Arbitrum has run Cancun opcodes since ArbOS 20.

### ABIs

`npm run contracts:abi` builds the contracts and writes the ABIs of `ResolutionWarrantyRegistry` and `ICompatibilityEngine` to `abi/<Contract>.json`, sorted by kind, name, and input types. TypeScript code imports these files, for example with viem, and never needs Foundry. With `-- --check`, the script writes nothing and fails when a committed file differs from the build. CI runs the check, so a contract change must commit its regenerated ABI.

## Deploy

`script/DeployRegistry.s.sol` deploys the registry to Arbitrum Sepolia in two steps and fails closed. It reads addresses and the key from the environment only, funds nothing, and registers no release.

| Variable | Step | Meaning |
| --- | --- | --- |
| `ARBITRUM_SEPOLIA_RPC_URL` | both | RPC endpoint. `foundry.toml` maps it to `arbitrum_sepolia`. |
| `DEPLOYER_PRIVATE_KEY` | deploy | Deployer key. Never pass it as a command-line argument, and never write it to a file in the repository. |
| `DEPLOYER_ADDRESS` | deploy | Optional. When set, the key must belong to this address. |
| `USDC_ADDRESS` | deploy | Must be the Arbitrum Sepolia USDC, `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`. |
| `REGISTRY_OWNER_ADDRESS` | deploy | Registry owner. Nonzero. A multisig or a key other than the deployer is recommended. |
| `LEMMA_SOURCE_COMMIT` | record | The full 40-character commit that was deployed, from a clean tree. |
| `DEPLOYMENT_RECORD_PATH` | record | Optional. Defaults to `deployments/arbitrum-sepolia/ResolutionWarrantyRegistry.json`. |

From `contracts/`, deploy, then write the record. The second step needs no key:

```bash
forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url arbitrum_sepolia --broadcast
LEMMA_SOURCE_COMMIT="$(git rev-parse HEAD)" \
  forge script script/DeployRegistry.s.sol:DeployRegistry --sig "record()" --rpc-url arbitrum_sepolia
```

The deploy step refuses a chain other than 421614, any other USDC address or one without code, a zero owner, and a key that does not match `DEPLOYER_ADDRESS`. After deploying, it reads the contract back and checks its constructor arguments, roles, empty state, and EIP-712 domain. The record step reads the deploy step's broadcast, repeats those checks, and writes a JSON record (`lemma.contracts.deployment.v1`) of public facts only: the address, deployer, transaction, block, constructor arguments, EIP-712 name and version, runtime code hash, compiler settings, and source commit.

Forge also writes the broadcast to `broadcast/`, and each transaction's RPC URL to `cache/`, since an RPC URL can carry a provider key. Both are git-ignored. Publish only the record. Keys and RPC credentials must never enter command arguments, source control, broadcast artifacts, or logs.

`npm run contracts:rehearse` runs both steps against a local anvil that poses as chain 421614, with mock USDC at the real USDC address and a throwaway deployer key made at run time. It checks the record and that the record does not contain the key, then deletes its broadcast, cache, and record. It refuses to run while a real deployment's broadcast (`broadcast/DeployRegistry.s.sol/421614/`) exists, unless `REHEARSAL_OVERWRITE=1`. `REHEARSAL_PORT` moves anvil off port 8545.

The [Arbitrum Sepolia runbook](../docs/deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation) runs both steps with the testnet role keys, then sets the engine, registers releases, and deposits bonds with `npm run warranty:admin -w @lemma/server`.

## Stylus compatibility-confidence engine

`contracts/stylus/` is a Rust workspace, separate from the Foundry project. It computes compatibility confidence for one release digest and profile index. The [confidence package guide](../packages/confidence/README.md#the-model) describes the model, and the crate docs in [`lemma-confidence/src/lib.rs`](stylus/lemma-confidence/src/lib.rs) give each integer step. The server runs the same crate as wasm for the catalog, so the catalog and the contract agree when they use [the same inputs](../packages/confidence/README.md#when-the-catalog-and-the-chain-agree).

The contract is not deployed yet. Once the registry's owner points `setEngine` at it, the registry records each finalized pass or failure with a weight above zero into it. The local end-to-end run (`npm run e2e`) puts a Solidity stand-in with its interface behind the registry (`e2e/contracts/src/ConfidenceStandIn.sol`), because anvil cannot run Stylus.

| Crate | Contents |
| --- | --- |
| `lemma-confidence` | The math: `#![no_std]`, integers only, no allocation, no `unsafe`. `vectors.json` pins its results for the Rust and TypeScript tests. |
| `confidence-wasm` | Plain-integer `extern "C"` exports for Node, built into `packages/confidence/wasm/lemma_confidence.wasm`. |
| `confidence-contract` | The Stylus contract `CompatibilityConfidence` (stylus-sdk 0.10.9). |

`rust-toolchain.toml` pins Rust 1.94.1 with the `wasm32-unknown-unknown` target. `Cargo.lock` is committed, and `target/` is ignored.

### Contract interface

`confidence-contract/ICompatibilityConfidence.sol` is the interface that `cargo stylus export-abi` prints. CI fails when it drifts from the contract.

| Function | Caller | Effect |
| --- | --- | --- |
| `constructor(address owner, address registry)` | deployer | Sets the roles. The owner cannot be zero. A zero registry leaves recording off. |
| `setRegistry(address)` | owner | Sets the only address that may record. Zero turns recording off. |
| `setPrior(bytes32 releaseDigest, uint8 profileIndex, uint32 passes, uint32 failures, bytes32 evidenceDigest)` | owner | Sets the benchmark prior and cites its evidence. |
| `record(bytes32 releaseDigest, uint8 profileIndex, bool passed, uint16 weightBps)` | registry | Adds one outcome at `block.timestamp`. Reverts `WeightTooLarge` above 10,000 bps. Its selector matches the registry-side `ICompatibilityEngine.record`. |
| `confidence(bytes32, uint8)` | anyone | Returns `(uint16 confidenceBps, uint64 effectiveNMilli)` at `block.timestamp`. |
| `stats(bytes32, uint8)` | anyone | Returns `(uint128 passWad, uint128 failWad, uint64 last, uint32 priorPasses, uint32 priorFailures)`. |
| `transferOwnership(address)` | owner | Offers ownership. The owner keeps every right until the offer is accepted. Zero withdraws the offer. |
| `acceptOwnership()` | pending owner | Takes ownership. |
| `owner()`, `pendingOwner()`, `registry()` | anyone | The current roles. |

`export-abi` prints functions and errors only. The contract also emits `OutcomeRecorded(bytes32 indexed releaseDigest, uint8 indexed profileIndex, bool passed, uint16 weightBps)`, `PriorSet(bytes32 indexed releaseDigest, uint8 indexed profileIndex, uint32 passes, uint32 failures, bytes32 evidenceDigest)`, `RegistrySet(address indexed registry)`, `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` and `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`. Its errors are `NotOwner`, `NotRegistry`, `NotPendingOwner`, `ZeroOwner` and `WeightTooLarge`.

Each entry is keyed by `keccak256(abi.encode(releaseDigest, profileIndex))` and holds two sums, a time and the prior counts. No buyer, payer or resolution id is stored.

Ownership has the semantics, selectors and events of OpenZeppelin's `Ownable2Step`, so a mistyped address cannot lock the owner out of `setPrior` and `setRegistry`. It is a small local implementation because `openzeppelin-stylus` 0.3.0 and `motsu` 0.10.0 pin `stylus-sdk` 0.9.0, which does not link with 0.10. The unit tests use the SDK's `TestVM`.

### Size and validity

`cargo stylus check` builds the program, then needs an Arbitrum RPC endpoint for its activation dry run. This repository's checks must run offline, so CI checks the same limits without a chain:

```bash
cd contracts/stylus
cargo build --locked --release --target wasm32-unknown-unknown -p confidence-contract --lib
node scripts/contract-size.mjs
```

The script strips custom sections, compresses with brotli 11 as cargo stylus does, checks the imports and the entry point, and refuses any floating-point or SIMD instruction. Measured on 2026-09-27: 72,406 bytes of wasm and 19,722 bytes compressed, one fragment under the 24 KiB fragment size (96 KiB is the hard limit). `cargo stylus check` itself reports about 19.5 KB (19,441 to 19,490 bytes) before it contacts the endpoint. That figure moves slightly with the checkout location, because cargo stylus hashes the project's file paths and contents into the module.

### Gas for `record`

The warranty registry calls `record` with a fixed budget of 300,000 gas (`ENGINE_GAS_LIMIT`) inside try/catch. If `record` runs out of gas, finalization still succeeds, the registry emits `EngineRecordFailed`, and the outcome never reaches the on-chain sums. `TestVM` does not charge gas, so `record` was measured on the [Arbitrum Sepolia deployment](../docs/deployments/arbitrum-sepolia.md) on 2026-10-01 with `eth_estimateGas` from the registry's address, less the 21,000 intrinsic gas and the calldata: about 90,100 gas for a key's first record with the program not cached, and about 63,000 for a key that already holds outcomes (testnet). Both are well inside the budget, so the program is not cached through ArbOS's CacheManager; cache it if a later version comes near the budget. The offline estimates this section held before (17 memory pages, at least 8,832 gas of program init uncached, up to about 46,000 gas of storage and log) were in the same range.

### Commands

From `contracts/stylus/`:

```bash
cargo test --locked --workspace
cargo run --locked --quiet -p confidence-contract --features export-abi -- abi
```

The first runs the engine, wasm-export and contract tests (`npm run stylus:test` from the root). The second prints the Solidity interface, byte for byte what `cargo stylus export-abi` prints. After an engine change, run `npm run confidence:wasm` from the root and commit the rebuilt module.

### Deploying

The engine is deployed on Arbitrum Sepolia at `0x0ede0baf8b11b256fb1c3bfd678a2087188d44b6` ([record](deployments/arbitrum-sepolia/ConfidenceEngine.json), [deployment](../docs/deployments/arbitrum-sepolia.md)). Deployment needs a reachable Arbitrum Sepolia RPC and a deployer with about 0.001 testnet ETH; that deployment cost 0.000437 testnet ETH, 0.000122 of it the activation data fee. Run `cargo stylus check --endpoint <rpc>` first. Both commands simulate the activation, which the official endpoint (`https://sepolia-rollup.arbitrum.io/rpc`) refuses with `stylus activations not allowed for this request` (seen on 2026-10-01); a keyless public endpoint such as `https://arbitrum-sepolia-rpc.publicnode.com` answers it (the check there on that day: 19.4 KB compressed, activation data fee 0.000122 ETH with the 20% bump). Then, from `contracts/stylus/confidence-contract`:

```bash
cargo stylus deploy --endpoint <rpc> --private-key-path <key file, mode 0600> --no-verify --constructor-args <owner> <registry>
```

`--constructor-args` takes every argument after it, so `--no-verify` (build locally, without Docker) must come before it. `cargo stylus deploy --estimate-gas` with the same arguments only estimates; its figures mean nothing for an unfunded deployer.

This deploys, activates and runs the constructor in one transaction. Never run the constructor in a separate transaction: it runs once, for whoever calls it first. Never pass `--private-key`, which exposes the key in shell history and process listings. After deployment, call `setRegistry` if the registry was deployed later, call `setPrior` for each benchmarked profile from frozen evidence only, and measure `record`'s gas before the registry calls `setEngine` with this contract. `npm run warranty:admin -w @lemma/server -- set-priors` calls `setPrior` from each profile's frozen evidence, and `-- set-engine` points the registry at the contract; the [runbook](../docs/deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation) gives the order. A Stylus program must be reactivated every 365 days.
