# Warranty Registry Review

This note records how `ResolutionWarrantyRegistry` was checked before deployment. It is an internal review, not an audit. The [contracts guide](../contracts/README.md) describes the contract itself.

Every figure below was measured on 2026-09-27 with Foundry 1.7.1, solc 0.8.30, 200 optimizer runs, and the Cancun target, on the contract as committed. Measure again after a contract change, and update this note in the same change.

## Tests

`npm run contracts:test` runs 117 tests: unit, engine, pause, vector, and deploy-script tests, 14 fuzz properties at 256 runs, and 7 invariants at 128 runs of 64 calls.

The invariant handler in `test/invariant/` checks the balance invariant, the totals, and conservation of funds after every call, with ghost accounting for deposits, donations, withdrawals, and credits. It finalizes exactly at a claim deadline, expires one second after it, carries a FAILED outcome across pauses of up to three days, and rotates the engine among recording, reverting, gas-burning, return-bomb, reentrant, and missing engines.

It also tries operations that must fail, and each must fail with its one expected error: replayed resolution ids and payment references, activation on a deactivated release, a second finalization, a late finalization, an early expiry, finalization or expiry while paused, a wrong or redirected claim, a second credit withdrawal, and over-withdrawal of bond.

`forge test --match-contract RegistryInvariantsTest -vv` prints how often each action reached the registry in the last run. Over a whole campaign of 128 runs of 64 calls (seed 42), the handler made 346 activations, 188 finalizations (56 at the exact claim deadline, 60 after a pause), and 116 expiries (74 from the deadline-plus-one action), and reached every must-fail action.

## Static analysis

Slither 0.11.6 ran against the registry with the remappings from `remappings.txt` and the build's compiler settings. It ran from the repository root, outside the Foundry project, so that crytic-compile uses the given solc rather than reading `foundry.toml`:

```bash
slither contracts/src/ResolutionWarrantyRegistry.sol --compile-force-framework solc \
  --solc ~/.svm/0.8.30/solc-0.8.30 \
  --solc-remaps "@openzeppelin/contracts/=contracts/lib/openzeppelin-contracts/contracts/ forge-std/=contracts/lib/forge-std/src/" \
  --solc-args "--optimize --optimize-runs 200 --evm-version cancun" --filter-paths "contracts/lib/"
```

It reported three findings in Lemma code, all from the Low-impact `timestamp` detector: `activateResolution` compares `block.timestamp` with `activateBy`, `finalizeOutcome` with `validUntil` and the claim deadline in force, and `expireResolution` with the claim deadline in force. All three are kept. Deadlines are the feature, and the Arbitrum sequencer keeps timestamps within a bounded drift of real time, far below hours-long voucher lifetimes and days-long claim windows. Finalization is allowed at the deadline and expiry only after it, so the two share one boundary.

`forge lint` reports the same four comparisons, and each carries a `forge-lint: disable-next-line(block-timestamp)` comment for that reason. Tests are not linted, because they compare timestamps on purpose. The findings Slither reports inside OpenZeppelin (`Math.mulDiv` exponent and division order, assembly, `Ownable2Step.transferOwnership` without a zero check, and `SignatureChecker` ignoring a tuple element) are intended behavior of audited upstream code and out of scope.

## Checklists

The review applied the Trail of Bits `building-secure-contracts` checklists as reference:

- Token integration: USDC is the only token, fixed at deploy. It returns booleans and has six decimals, but it is upgradeable, pausable, and has a blocklist. The registry uses `SafeERC20`, checks the received amount on deposit, and pays out by pull only. A blocked refund address cannot be paid until it is unblocked, and its credit cannot be redirected, because the claim hash binds it. There are no hooks, rebasing, flash mints, or approvals granted by the registry.
- Development guidelines: no upgradeability, proxy, or `delegatecall`, flat inheritance of OpenZeppelin bases, an event for every state change (`test_everyTransitionEmits`), NatSpec on the public surface, and dependencies pinned by commit instead of copied.
- Manual review: no address is stored. Every relayed message is signed or bound, so a front-runner can only submit the same result, and the engine gas floor stops a relayer from starving the engine on purpose. OpenZeppelin ECDSA rejects malleable signatures, the domain binds chain and contract, and replays are keyed by resolution id and payment reference. The engine runs last, capped at 300,000 gas, inside `try/catch`, under the reentrancy lock.

## Gas

Measured with `forge test --gas-report --no-match-contract 'RegistryInvariantsTest|DeployRegistryTest'`, over the unit, engine, pause, vector, and fuzz suites. These are L2 execution gas figures. Arbitrum also charges for each transaction's L1 calldata. Minimums are mostly revert paths. Averages and medians move slightly between runs, because the fuzz suites draw new inputs.

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

The `finalizeOutcome` minimum of 0 comes from the gas-limit fuzz test, which gives some calls too little gas to start. Without it, the minimum is 31,937, a revert path. Its maximum includes a gas-burning engine that uses its whole 300,000 budget. The pause clock costs about 2,600 gas (one cold storage read) in activation and finalization, about 4,900 in expiry, which also checks the pause, and about 22,000 in the first `pause`, which starts its slot.
