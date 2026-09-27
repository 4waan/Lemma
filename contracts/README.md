# Lemma Warranty Registry

This Foundry workspace is reserved for the Arbitrum Sepolia contract that backs paid Compatibility Resolutions with provider-funded USDC.

The registry is not implemented. The current package contains only the compiler configuration and a scaffold test. Do not treat it as deployed, audited, or safe for funds.

## Target state machine

The provider registers a Capability Release and deposits USDC bond. After x402 settlement, a provider-signed voucher activates one warranty and reserves bond equal to the covered price.

A separate evaluator can finalize a pass or eligible failure during the claim window. A pass releases the reservation. A failure creates buyer withdrawal credit. If no outcome arrives, expiry releases the reservation without claiming that the software passed.

The MVP interface is expected to include:

- `registerRelease`
- `depositBond`
- `deactivateRelease`
- `withdrawUnreservedBond`
- `activateResolution`
- `finalizeOutcome`
- `expireResolution`
- `withdrawCredit`

Full manifests, profiles, patches, and test output remain offchain. The contract stores identifiers, typed-signature commitments, role addresses, deadlines, and accounting state.

## Required invariants

- Vouchers and outcomes use EIP-712 domain separation bound to chain and contract.
- Resolution ids, payment references, and authorizations cannot be replayed.
- The buyer, evaluator, release, payload, amount, and expiry must match the signed data.
- Reserved bond cannot be withdrawn by the provider.
- Release deactivation does not invalidate an active warranty.
- Withdrawals use pull credits and reentrancy protection.
- USDC balance always covers available bond, reserved bond, and withdrawal credits.
- Six-decimal accounting is tested explicitly.

The evaluator remains a separate team-operated key for the MVP. This is bounded recourse, not decentralized correctness arbitration.

## Development

From the repository root:

```bash
npm run contracts:build
npm run contracts:test
```

The implementation milestone requires unit, fuzz, and invariant coverage, a deployment script that reads roles from the environment, verified Arbitrum Sepolia bytecode, and one demonstrated pass and refunded failure.

Deployment records must contain only public chain data, compiler settings, and the source commit. Keys and RPC credentials must never enter command arguments, source control, broadcast artifacts, or logs.

## Stylus compatibility-confidence engine

`contracts/stylus/` is a Rust workspace, separate from the Foundry project. It computes compatibility confidence for one release digest and profile index. The [confidence package guide](../packages/confidence/README.md#the-model) describes the model, and the crate docs in [`lemma-confidence/src/lib.rs`](stylus/lemma-confidence/src/lib.rs) give each integer step. The server runs the same crate as wasm for the catalog, so the catalog and the contract agree when they use [the same inputs](../packages/confidence/README.md#when-the-catalog-and-the-chain-agree).

The contract is not deployed, and nothing records outcomes into it yet.

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

### Gas for `record` (not measured)

The warranty registry's pending implementation calls `record` inside try/catch with a fixed budget of 300,000 gas. If `record` runs out of gas, finalization still succeeds, the registry emits `EngineRecordFailed`, and the outcome never reaches the on-chain sums. `TestVM` does not charge gas, and no Arbitrum RPC was reachable from the build environment, so nobody has measured `record` yet. Offline estimates from ArbOS's default Stylus pricing (read 2026-09-27): about 15,000 gas for the 17 memory pages the module declares (Rust's default 1 MiB stack), at least 8,832 gas of program init while the program is not cached, and up to about 46,000 gas of storage and the log for a key's first record. Measure `record` on Arbitrum Sepolia, cold and warm, before the registry points at this contract. Cache the program through ArbOS's CacheManager if the cold figure comes near the budget.

### Commands

From `contracts/stylus/`:

```bash
cargo test --locked --workspace
cargo run --locked --quiet -p confidence-contract --features export-abi -- abi
```

The first runs the engine, wasm-export and contract tests (`npm run stylus:test` from the root). The second prints the Solidity interface, byte for byte what `cargo stylus export-abi` prints. After an engine change, run `npm run confidence:wasm` from the root and commit the rebuilt module.

### Deploying (not done yet)

Deployment needs a reachable Arbitrum Sepolia RPC and a deployer with about 0.001 testnet ETH. Run `cargo stylus check --endpoint <rpc>` first. Then, from `contracts/stylus/confidence-contract`:

```bash
cargo stylus deploy --endpoint <rpc> --private-key-path <key file, mode 0600> --constructor-args <owner> <registry> --no-verify
```

This deploys, activates and runs the constructor in one transaction. Never run the constructor in a separate transaction: it runs once, for whoever calls it first. Never pass `--private-key`, which exposes the key in shell history and process listings. After deployment, call `setRegistry` if the registry was deployed later, call `setPrior` for each benchmarked profile from frozen evidence only, and measure `record`'s gas before the registry calls `setEngine` with this contract. A Stylus program must be reactivated every 365 days.
