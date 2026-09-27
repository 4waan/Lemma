# Lemma Warranty Registry

This Foundry workspace holds `ResolutionWarrantyRegistry`, the Arbitrum Sepolia contract that backs paid Compatibility Resolutions with provider-funded USDC. x402 stays the payment rail. The registry adds bounded recourse after payment, not a custom escrow.

The contract, its unit, fuzz, and invariant tests, exported ABIs, and a fail-closed deploy script are in place. It is not deployed or audited. Do not treat it as safe for funds. Still open: deploy it, verify the bytecode on Arbitrum Sepolia, and take one real paid resolution through the pass path and one through the refunded failure path.

## Layout

| Path | Contents |
| --- | --- |
| `src/ResolutionWarrantyRegistry.sol` | The registry: bonds, vouchers, outcomes, expiry, and refund credits. |
| `src/interfaces/ICompatibilityEngine.sol` | The hook the registry calls on a finalized, weighted pass or failure. The Stylus compatibility-confidence contract implements it and must keep this exact `record` signature in its exported ABI. |
| `script/DeployRegistry.s.sol` | Fail-closed deployment and the secret-free deployment record. |
| `script/rehearse-deploy.sh` | That deployment, rehearsed on a local anvil. |
| `script/export-abi.mjs` | Writes and checks `abi/*.json`. |
| `abi/*.json` | ABIs for TypeScript, checked against the build in CI. |
| `test/` | Unit, fuzz, invariant, vector, pause, engine, and deploy-script tests, with mocks in `test/utils/`. |
| `lib/` | OpenZeppelin Contracts and forge-std, pinned git submodules. |

## State machine

The owner registers a Capability Release with its provider, its evaluator, and a claim window. The provider deposits USDC bond. After x402 settlement, a provider-signed voucher activates one warranty and reserves bond equal to the covered price.

The release's evaluator can finalize a pass or an eligible failure up to and including the claim deadline. PASSED releases the reservation. FAILED turns it into the buyer's withdrawal credit. VOID, for an ineligible or abandoned run, releases it and records nothing. If no outcome arrives, anyone can expire the warranty after the deadline, which releases the reservation without claiming that the software passed. A PASSED or FAILED outcome with a nonzero weight is also recorded with the compatibility engine.

A warranty moves `None -> Active` on activation, `Active -> Passed | Failed | Voided` on finalization, `Active -> Expired` after the claim deadline, and `Failed -> Refunded` when its credit is withdrawn. No other move exists, and the invariant tests check it.

Full manifests, profiles, patches, and test output remain offchain. The contract stores identifiers, typed-signature commitments, role addresses, deadlines, and accounting state. It does not check USDC payment logs, judge software correctness, price resolutions, or run the x402 facilitator. It has no upgradeability, token, auction, governance, or general arbitration.

## Interface

Amounts are atomic USDC (six decimals) as `uint256`. The constructor is `constructor(IERC20 usdc, address initialOwner)`: `usdc` must be a contract and the owner nonzero. The deploy script pins the Arbitrum Sepolia USDC.

| Function | Caller | While paused | Effect |
| --- | --- | --- | --- |
| `registerRelease(releaseDigest, provider, evaluator, claimWindowSeconds)` | owner | allowed | Registers a release once. Digest, roles, and window are nonzero, and provider and evaluator differ. |
| `setEngine(newEngine)` | owner | allowed | Sets the engine (a contract), or disables it with zero. The ABI names the parameter `newEngine` because `engine` is the public getter; the selector is `setEngine(address)`. |
| `depositBond(releaseDigest, amount)` | anyone | blocked | Pulls `amount` USDC from the caller into an active release's available bond. |
| `withdrawUnreservedBond(releaseDigest, amount, to)` | the release's provider | allowed | Pays out unreserved bond, also after deactivation. |
| `deactivateRelease(releaseDigest)` | owner or provider | allowed | Stops new activations. Active warranties keep running. |
| `activateResolution(voucher, providerSignature)` | anyone | blocked | Reserves the voucher's amount and opens the claim window. |
| `finalizeOutcome(outcome, evaluatorSignature)` | anyone | blocked | Applies the verdict up to and including the claim deadline in force, and calls the engine for a weighted pass or failure. |
| `expireResolution(resolutionId)` | anyone | blocked | Releases the reserved bond after the claim deadline in force. |
| `withdrawCredit(resolutionId, claimSecret, to)` | anyone | allowed | Pays a FAILED resolution's credit to the committed `to`, once. |
| `pause()`, `unpause()` | owner | | Stop or resume deposits, activations, finalizations, expiries, and the claim clock. |

Views:

- `claimDeadlineOf(id)`: the claim deadline in force for an Active resolution, which is the deadline set at activation plus the time paused since, an ongoing pause included. Zero otherwise.
- `pausedSeconds()`: the total seconds the registry has spent paused, an ongoing pause included.
- `release(digest)`, `resolution(id)`, `totals()`, `paymentRefUsed(ref)`, `engine()`, and `usdc()`: state reads. `resolution(id).claimDeadline` and the `ResolutionActivated` event keep the deadline set at activation, and `pausedSecondsAtActivation` is the paused total then.
- `hashVoucher(voucher)`, `hashOutcome(outcome)`, and EIP-5267 `eip712Domain()`: the digests to sign, and the domain.

Ownership moves in two steps, with `transferOwnership` and `acceptOwnership`. `renounceOwnership` is disabled, because without an owner a paused registry could never finalize again.

## Signed messages

Vouchers and outcomes are EIP-712 typed data under the domain `{ name: "Lemma Warranty Registry", version: "1", chainId, verifyingContract }`, with no salt:

```text
Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)
Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)
```

- `amount` is atomic USDC.
- `paymentRef` is an opaque salted commitment the server chooses for the settled payment. It is never a public function of payer and nonce, and each one activates once.
- `claimHash = keccak256(abi.encode(bytes32 resolutionId, bytes32 claimSecret, address refundTo))`. The buyer's bridge makes it, through core `warrantyClaimHash` in the payment work.
- `verdict` is 1 PASSED (bond released), 2 FAILED (the reserved amount becomes the resolution's credit), or 3 VOID (bond released, nothing recorded). `weightBps` is 0 to 10000.
- `activateBy` and `validUntil` are the last timestamps at which the voucher or the outcome may be submitted.

`test/Vectors.t.sol` pins vectors that the TypeScript side must reproduce. The claim hash of `resolutionId = 0x11…11`, `claimSecret = 0x22…22`, and `refundTo = 0x3333333333333333333333333333333333333333` is `0xefe737cca6b5574d334f88508fb3149002c12c771f7bdeec10267e5cf8fa21eb`, computed with `cast` and with viem. One voucher digest and one outcome digest are computed with viem. The test also checks every digest against Foundry's own EIP-712 encoder.

## Roles

| Role | Holds | Can |
| --- | --- | --- |
| Owner | Registry administration. A multisig is recommended. | Register releases, set the engine, pause and unpause, and deactivate a release. Cannot move bond or credit. |
| Provider, per release | The release's bond. Signs vouchers. | Deposit, withdraw unreserved bond, and deactivate its release. |
| Evaluator, per release | Signs outcomes. | Decide PASSED, FAILED, or VOID for that release's active warranties. |
| Relayer, anyone | Gas. | Submit signed vouchers and outcomes, expiries, and credit withdrawals. |
| Buyer, off chain | The claim secret and refund address. | Unlock its own credit through any relayer. |
| Engine, a contract | The compatibility-confidence record. | Receive `record(...)` calls, and nothing else. |

Provider and evaluator must differ. Either may be a smart account: signatures go through OpenZeppelin `SignatureChecker`, so EOAs and ERC-1271 contracts both work, and a smart account can rotate its keys without a new release. The evaluator is a separate team-operated key for the MVP. This is bounded recourse, not decentralized correctness arbitration.

Every step a buyer depends on can be submitted by anyone. Vouchers and outcomes are signed, a credit withdrawal carries the claim secret and its committed recipient, and expiry needs no signature. The server or any other relayer pays the gas, so agents never hold ETH. A relayer cannot change what it submits.

## Pause and the claim clock

A pause stops deposits, activations, finalizations, and expiries, and it stops the claim clock: every second the registry spends paused is added to the claim deadline of each warranty activated before the pause. The registry counts its paused seconds and snapshots the count at activation. Finalization and expiry both use the deadline in force, which is the deadline set at activation plus the time paused since.

So a pause never costs a buyer its window. After the unpause, a warranty has exactly the seconds it had left when the pause began, and a window that had already closed stays closed. A provider cannot expire a warranty, or free its reserved bond, while its outcome cannot be submitted.

Unreserved bond and buyer credits stay withdrawable while paused. `activateBy` and `validUntil` are not extended, because their signers can sign again after a long pause. `test/RegistryPause.t.sol` covers this, and the invariant handler carries a FAILED outcome across pauses of up to three days.

## Invariants

- Storage holds hashes and accounting only. It never stores a buyer or payer address: a warranty is keyed by its resolution id, the payment by its opaque `paymentRef`, and the refund goes to whoever proves the claim secret behind `claimHash`. `test_activate_storesNoAddress` scans every storage slot activation writes.
- Signatures are bound to the chain and this contract. Expired vouchers and outcomes, replayed resolution ids and payment references, wrong providers and evaluators, and claims whose secret or recipient does not match the committed hash are rejected.
- The provider cannot withdraw reserved bond, and deactivating a release does not invalidate its active warranties.
- A deposit fails closed if the token delivers a different amount than asked, as a fee-on-transfer change to USDC would.
- Every state change follows checks, effects, then interactions, under `nonReentrant`. Credits are pulled, never pushed.
- The engine call gets exactly `ENGINE_GAS_LIMIT` (300,000) gas inside `try/catch`. A revert, out-of-gas, huge revert payload, missing code, or reentry attempt emits `EngineRecordFailed(resolutionId)`, and the finalization stands. A caller that supplies too little gas for that budget gets `InsufficientGasForEngine`, so a relayer cannot starve the engine on purpose.
- `usdc.balanceOf(registry) >= totalAvailable + totalReserved + totalCredits`, and each total equals its sum over releases (available, reserved) or resolutions (reserved while Active, credit while Failed). The only surplus is USDC sent straight to the contract.
- Six-decimal accounting is tested explicitly.

`test/invariant/` checks the balance invariant, the totals, and conservation of funds after every call of random handler sequences, with ghost accounting for deposits, donations, withdrawals, and credits. The handler also finalizes exactly at a claim deadline, expires one second after it, carries a FAILED outcome across a pause, and rotates the engine among the recording, reverting, gas-burning, return-bomb, reentrant, and missing engine.

It also tries operations that must fail, and each must fail with its one expected error: replayed resolution ids and payment references, activation on a deactivated release, a second finalization, a late finalization, an early expiry, finalization or expiry while paused, a wrong or redirected claim, a second credit withdrawal, and over-withdrawal of bond.

`forge test --match-contract RegistryInvariantsTest -vv` prints how often each action reached the registry in the last run. One campaign of 128 runs of 64 calls (seed 42, measured 2026-09-27) made 346 activations, 188 finalizations (56 at the exact claim deadline, 60 after a pause), and 116 expiries (74 from the deadline-plus-one action), and reached every must-fail action.

## Limits

- The evaluator is trusted. It signs one verdict per resolution, and the first valid one submitted wins. If it never signs, the warranty expires and the bond returns to the provider.
- The provider is trusted to sign a voucher after payment and to keep enough bond available. A voucher is only as good as the available bond when it is submitted, before `activateBy`.
- The registry does not check the x402 payment on chain. That the warranty amount equals the price paid is enforced off chain, by what the provider signs.
- A pause freezes every Active warranty until the unpause. An owner that never unpauses leaves reserved bond locked. `renounceOwnership` is disabled so that an owner always exists to unpause.
- Resolution ids and payment references are global, not per release. A registered provider of another release that learned a resolution id or `paymentRef` before its activation could activate it first on its own release with a one-unit voucher. The real activation would then revert with `ResolutionAlreadyExists` or `PaymentRefAlreadyUsed`. Neither value can be derived from public data, because the id comes from the secret preview id and the `paymentRef` is salted, and Arbitrum has no public mempool. Both must stay private until the warranty is active. Keying warranties by release and id would close this, but it needs the release digest in the `Outcome` type.
- When a role address has code, `SignatureChecker` calls its ERC-1271 `isValidSignature` with all remaining gas, so a malicious smart-account role can burn a relayer's gas. Relayers must simulate every submission and cap its gas. An EOA role that later delegates its code with EIP-7702 moves to that ERC-1271 path, and its plain ECDSA signatures stop working unless the delegate implements `isValidSignature`.
- Roles are fixed per release. A compromised provider or evaluator key is handled by pausing and deactivating, not by rotation. A smart-account role can rotate its own keys.
- USDC is centrally controlled. Circle can block an address or pause the token. A blocked refund recipient cannot be paid until it is unblocked, and the credit cannot be redirected, because the claim hash binds it. If USDC ever adds a transfer fee, deposits fail closed.
- USDC sent straight to the registry stays there. There is no sweep function, by design.
- At withdrawal, the refund address becomes public next to the resolution id. A buyer that wants its purchase to stay unlinkable should commit to a fresh refund address.
- An engine failure is only an event (`EngineRecordFailed`), with no on-chain retry. With an engine set, `finalizeOutcome` needs about 325,000 gas left for the engine step, or it reverts.
- Timestamps come from the Arbitrum sequencer. Claim windows and voucher and outcome lifetimes should be hours or more.
- A release digest registers once, and a deactivated release stays deactivated. A new version is a new digest.

## Development

From the repository root, with Foundry on `PATH` (and `jq` for the rehearsal):

```bash
git submodule update --init
npm run contracts:build
npm run contracts:test
npm run contracts:abi -- --check
npm run contracts:rehearse
```

`contracts:test` runs 117 tests, among them 14 fuzz properties at 256 runs and 7 invariants at 128 runs of 64 calls. Cloud and CI runs set `FOUNDRY_OFFLINE=true`: nothing needs the network once `lib/` is checked out and solc 0.8.30 is installed. The CI `contracts` job pins Foundry v1.7.1 and runs `forge fmt --check`, the build, the tests, the ABI check, and the rehearsal.

### Dependencies

Solidity dependencies are git submodules under `lib/`, pinned by gitlink to a release tag. The build needs only the top level: OpenZeppelin's own nested submodules are never compiled, and CI does not fetch them.

| Dependency | Path | Tag | Commit |
| --- | --- | --- | --- |
| OpenZeppelin Contracts | `lib/openzeppelin-contracts` | `v5.6.1` | `5fd1781b1454fd1ef8e722282f86f9293cacf256` |
| forge-std | `lib/forge-std` | `v1.16.2` | `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` |

`remappings.txt` maps `@openzeppelin/contracts/` and `forge-std/` to these trees, and `foundry.toml` turns off remapping auto-detection, so a dependency's nested submodules cannot change an import. To move a pin, check out the new tag inside the submodule, commit the gitlink, and update this table in the same change. The pinned trees are third-party code whose public test fixtures trip the generic secret rules, so `.gitleaks.toml` skips these two trees and nothing else under `lib/`.

The registry uses OpenZeppelin `EIP712`, `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, and `SignatureChecker`, and no hand-written signature, hashing, or token-transfer code. The compile target is Cancun, because OpenZeppelin v5.6 uses `MCOPY`. Arbitrum has run Cancun opcodes since ArbOS 20.

### ABIs

`npm run contracts:abi` runs `forge build`, then writes the `abi` array of `ResolutionWarrantyRegistry` and `ICompatibilityEngine` to `abi/<Contract>.json`, with entries sorted by kind, name, and input types. TypeScript code imports these files, for example with viem, and never needs Foundry. `npm run contracts:abi -- --check` writes nothing and fails when a committed file differs from the build. CI runs the check, so a contract change must commit its regenerated ABI. The script uses Node built-ins only.

## Deploy

`script/DeployRegistry.s.sol` deploys the registry to Arbitrum Sepolia and fails closed. It takes addresses and the key from the environment only, verifies the deployed contract and its constructor arguments, funds nothing, and writes a secret-free deployment record.

| Variable | Step | Meaning |
| --- | --- | --- |
| `ARBITRUM_SEPOLIA_RPC_URL` | both | RPC endpoint. `foundry.toml` maps it to `arbitrum_sepolia`. |
| `DEPLOYER_PRIVATE_KEY` | deploy | Deployer key, read with `vm.envUint`. Never pass it as a command-line argument, and never write it to a file in the repository. |
| `DEPLOYER_ADDRESS` | deploy | Optional. When set, the key must belong to this address. |
| `USDC_ADDRESS` | deploy | Must be the Arbitrum Sepolia USDC, `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`. |
| `REGISTRY_OWNER_ADDRESS` | deploy | Registry administrator: registers releases, sets the engine, and pauses. Nonzero. A multisig or a key other than the deployer is recommended. |
| `LEMMA_SOURCE_COMMIT` | record | The full 40-character git commit that was deployed (`git rev-parse HEAD` on a clean tree). |
| `DEPLOYMENT_RECORD_PATH` | record | Optional. Defaults to `deployments/arbitrum-sepolia/ResolutionWarrantyRegistry.json`. |

From `contracts/`, deploy first:

```bash
forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url arbitrum_sepolia --broadcast
```

Before broadcasting, the script refuses a chain id other than 421614, a `USDC_ADDRESS` other than the Arbitrum Sepolia USDC or one without code, a zero owner, and a key that does not match `DEPLOYER_ADDRESS`. After deploying, it reads the contract back: code present, `usdc()` and `owner()` equal to the constructor arguments, no pending owner, no engine, not paused, all totals zero, and the EIP-712 domain `Lemma Warranty Registry`, version `1`, on this chain and address. It sends no USDC or ETH anywhere and registers no release.

Then write the record. This step needs no key:

```bash
LEMMA_SOURCE_COMMIT="$(git rev-parse HEAD)" \
  forge script script/DeployRegistry.s.sol:DeployRegistry --sig "record()" --rpc-url arbitrum_sepolia
```

It reads the deploy step's broadcast (`broadcast/DeployRegistry.s.sol/421614/run-latest.json`), checks that its first transaction is the successful registry CREATE, runs the same fail-closed checks against its constructor arguments, verifies the deployed contract again, and writes the record.

The record is JSON with `schema` (`lemma.contracts.deployment.v1`), `contract`, `chainId`, `address`, `deployer`, `transactionHash`, `blockNumber`, `constructorArgs` (`usdc`, `initialOwner`), `eip712Name`, `eip712Version`, `runtimeCodeHash`, `compiler` (`version`, `optimizer`, `optimizerRuns`, `evmVersion`, and `bytecodeHash`, read from the build artifact), and `sourceCommit`. It holds public facts only.

Forge also writes the broadcast to `broadcast/`, and the RPC URL of each transaction to `cache/` as "sensitive values", since an RPC URL can carry a provider key. Both directories are git-ignored. Publish only the record. Keys and RPC credentials must never enter command arguments, source control, broadcast artifacts, or logs.

`npm run contracts:rehearse` runs both steps against a local anvil that poses as chain 421614, with mock USDC code at the real USDC address and a throwaway deployer key made at run time. It then checks the record's fields, its runtime code hash against the chain, and that it does not contain the key. It deletes its broadcast, cache, and record when it exits, and it refuses to run while `broadcast/DeployRegistry.s.sol/421614/` exists, which would be a real deployment's broadcast, unless `REHEARSAL_OVERWRITE=1`. `REHEARSAL_PORT` moves anvil off port 8545. CI runs the rehearsal on every change.

## Static analysis

Slither 0.11.6 ran on 2026-09-27 against `src/ResolutionWarrantyRegistry.sol`, with the remappings from `remappings.txt`, solc 0.8.30, and the build's optimizer and EVM settings. It ran from the repository root, outside the Foundry project, so that crytic-compile uses the given solc rather than reading `foundry.toml`:

```bash
slither contracts/src/ResolutionWarrantyRegistry.sol --compile-force-framework solc \
  --solc ~/.svm/0.8.30/solc-0.8.30 \
  --solc-remaps "@openzeppelin/contracts/=contracts/lib/openzeppelin-contracts/contracts/ forge-std/=contracts/lib/forge-std/src/" \
  --solc-args "--optimize --optimize-runs 200 --evm-version cancun" --filter-paths "contracts/lib/"
```

It reported three findings, all from the Low-impact `timestamp` detector, and nothing else in Lemma code. A re-run the same day, after the pause-clock change, reported the same three. `claimDeadline` below is the deadline in force, which pauses move later.

| Finding | Where | Decision |
| --- | --- | --- |
| `timestamp` | `activateResolution` (`block.timestamp > activateBy`) | Kept. Deadlines are the feature. The Arbitrum sequencer sets timestamps within a bounded drift of real time, far below the hours-long voucher lifetime. |
| `timestamp` | `finalizeOutcome` (`> validUntil`, `> claimDeadline`) | Kept, for the same reason. Claim windows are days. |
| `timestamp` | `expireResolution` (`<= claimDeadline`) | Kept, for the same reason. Expiry and finalization share one boundary: finalization is allowed at the deadline, expiry only after it. |

The findings slither reports inside OpenZeppelin (`Math.mulDiv` exponent and division order, assembly, `Ownable2Step.transferOwnership` without a zero check, and `SignatureChecker` ignoring a tuple element) are intended behavior of audited upstream code and out of scope. `forge lint` reports the same four timestamp comparisons. Each carries a `forge-lint: disable-next-line(block-timestamp)` comment for the reason above. Tests are not linted, because they compare timestamps on purpose.

The review also applied the Trail of Bits `building-secure-contracts` checklists, as reference only:

- Token integration: the only token is USDC, fixed at deploy. It returns booleans and has six decimals (tested), but it is upgradeable, pausable, and has a blocklist. The registry uses `SafeERC20`, checks the received amount on deposit, pays out by pull only, and documents the blocklist and pause limits above. There are no hooks (no ERC-777), no rebasing, no flash-mint exposure, and no approvals granted by the registry.
- Development guidelines: no upgradeability, proxy, or `delegatecall`; flat inheritance of OpenZeppelin bases; an event for every state change (`test_everyTransitionEmits`); NatSpec on the public surface; and dependencies pinned by commit instead of copied.
- Secure workflow: slither triaged above, and access control, arithmetic, and state-machine properties written down here and tested as fuzz and invariant properties. Manual review covered privacy (no addresses stored), front-running (every relayed message is signed or bound, so a front-runner can only submit the same result, and the engine gas floor stops a relayer from starving the engine on purpose), cryptography (OpenZeppelin ECDSA rejects malleable `s` values, the domain is bound to chain and contract, and replays are keyed by resolution id and payment reference), and external calls (the engine runs last, capped at 300,000 gas, inside `try/catch`, under the reentrancy lock).

## Gas

Local measurement on 2026-09-27, after the pause-clock change: `forge test --gas-report --no-match-contract 'RegistryInvariantsTest|DeployRegistryTest'` (the unit, engine, pause, vector, and fuzz suites) with Foundry 1.7.1, solc 0.8.30, optimizer 200 runs, and Cancun. These are L2 execution gas figures; Arbitrum also charges for the L1 data of each transaction's calldata. Minimums are mostly revert paths. The `finalizeOutcome` maximum includes a gas-burning engine that uses its full 300,000 budget. Averages move slightly between runs, because the fuzz suites draw new inputs.

The pause clock adds about 2,600 gas (one cold storage read) to activation and finalization, about 4,900 to expiry, which now also checks the pause, and about 22,000 to the first `pause`, which starts its slot.

Deployment: 2,523,424 gas, 12,472 bytes of runtime code.

| Function | Min | Avg | Median | Max |
| --- | ---: | ---: | ---: | ---: |
| `registerRelease` | 24,920 | 69,295 | 72,237 | 72,237 |
| `setEngine` | 24,047 | 50,219 | 50,498 | 50,498 |
| `depositBond` | 29,423 | 112,446 | 112,611 | 115,102 |
| `withdrawUnreservedBond` | 29,901 | 41,223 | 32,428 | 72,392 |
| `deactivateRelease` | 24,116 | 28,977 | 30,901 | 31,032 |
| `activateResolution` | 32,919 | 181,976 | 202,874 | 215,459 |
| `finalizeOutcome` | 0 | 78,357 | 72,977 | 373,095 |
| `expireResolution` | 29,176 | 55,586 | 51,591 | 85,791 |
| `withdrawCredit` | 29,938 | 51,660 | 64,541 | 74,537 |
| `pause` | 23,522 | 68,828 | 69,059 | 69,059 |
| `unpause` | 23,544 | 30,519 | 30,557 | 30,557 |
| `transferOwnership` | 47,855 | 47,855 | 47,855 | 47,855 |
| `acceptOwnership` | 23,488 | 25,890 | 25,890 | 28,292 |
| `renounceOwnership` (always reverts) | 2,491 | 2,496 | 2,496 | 2,501 |
| `hashVoucher` (view) | 1,416 | 1,416 | 1,416 | 1,668 |
| `hashOutcome` (view) | 1,382 | 1,382 | 1,382 | 1,382 |
| `release` (view) | 9,457 | 9,457 | 9,457 | 9,457 |
| `resolution` (view) | 9,770 | 9,770 | 9,770 | 9,770 |
| `claimDeadlineOf` (view) | 2,602 | 7,388 | 7,422 | 7,768 |
| `pausedSeconds` (view) | 4,612 | 4,760 | 4,612 | 4,958 |
| `totals` (view) | 6,572 | 6,572 | 6,572 | 6,572 |
| `eip712Domain` (view) | 1,729 | 1,729 | 1,729 | 1,729 |

The `finalizeOutcome` minimum of 0 comes from the gas-limit fuzz test, which gives some calls too little gas to start. Without it, the minimum is 31,937, a revert path.
