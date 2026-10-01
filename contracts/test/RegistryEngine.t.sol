// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ResolutionWarrantyRegistry as Registry} from "../src/ResolutionWarrantyRegistry.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";
import {
    RecordingEngine,
    RevertingEngine,
    GasBurningEngine,
    ReturnBombEngine,
    ReentrantEngine
} from "./utils/MockEngines.sol";

/// The compatibility engine hook: called once per weighted PASSED/FAILED outcome, with a fixed
/// gas budget, and never able to block or change finalization.
contract RegistryEngineTest is RegistryTestBase {
    bytes32 internal rid;

    function setUp() public override {
        super.setUp();
        _deposit(RELEASE, 100 * ONE_USDC);
        rid = _rid(1);
        _activate(rid, 5 * ONE_USDC);
    }

    function _setEngine(address engine) internal {
        vm.prank(owner);
        registry.setEngine(engine);
    }

    function _signed(uint8 verdict, uint16 weightBps)
        internal
        view
        returns (Registry.Outcome memory o, bytes memory sig)
    {
        o = _outcome(rid, verdict, weightBps);
        sig = _signOutcome(evaluatorKey, o);
    }

    function test_engine_recordsPassedAndFailedWithTheirWeight() public {
        RecordingEngine engine = new RecordingEngine();
        _setEngine(address(engine));
        _activate(_rid(2), ONE_USDC);

        _finalize(rid, 1, 10_000);
        _finalize(_rid(2), 2, 5_000);

        assertEq(engine.callCount(), 2);
        RecordingEngine.Call memory first = engine.callAt(0);
        assertEq(first.releaseDigest, RELEASE);
        assertEq(first.profileIndex, PROFILE);
        assertTrue(first.passed);
        assertEq(first.weightBps, 10_000);
        assertEq(first.caller, address(registry));
        RecordingEngine.Call memory second = engine.callAt(1);
        assertFalse(second.passed);
        assertEq(second.weightBps, 5_000);
    }

    function test_engine_isSkippedForVoidAndZeroWeight() public {
        RecordingEngine engine = new RecordingEngine();
        _setEngine(address(engine));
        _activate(_rid(2), ONE_USDC);
        _activate(_rid(3), ONE_USDC);

        _finalize(rid, 3, 10_000); // VOID
        _finalize(_rid(2), 1, 0); // PASSED, weight 0
        _finalize(_rid(3), 2, 0); // FAILED, weight 0
        assertEq(engine.callCount(), 0);
        assertEq(uint8(_status(_rid(3))), uint8(Registry.Status.Failed));
    }

    function test_engine_notSetMeansNoCall() public {
        (Registry.Outcome memory o, bytes memory sig) = _signed(2, 10_000);
        vm.recordLogs();
        registry.finalizeOutcome(o, sig);
        assertEq(vm.getRecordedLogs().length, 1); // OutcomeFinalized only
    }

    function test_engine_revertingEngineDoesNotBlockFinalization() public {
        _setEngine(address(new RevertingEngine()));
        (Registry.Outcome memory o, bytes memory sig) = _signed(2, 10_000);
        vm.expectEmit(address(registry));
        emit Registry.EngineRecordFailed(rid);
        registry.finalizeOutcome(o, sig);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Failed));
        _assertBalanceMatchesTotals();
    }

    function test_engine_gasBurningEngineIsCappedAndDoesNotBlockFinalization() public {
        _setEngine(address(new GasBurningEngine()));
        (Registry.Outcome memory o, bytes memory sig) = _signed(1, 10_000);
        vm.expectEmit(address(registry));
        emit Registry.EngineRecordFailed(rid);
        uint256 gasBefore = gasleft();
        registry.finalizeOutcome{gas: 1_000_000}(o, sig);
        uint256 used = gasBefore - gasleft();
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Passed));
        // The engine can burn its budget and no more.
        assertLt(used, registry.ENGINE_GAS_LIMIT() + 100_000);
    }

    function test_engine_returnBombIsNotCopied() public {
        ReturnBombEngine bomb = new ReturnBombEngine();
        // The bomb really fires within the engine budget.
        (bool ok, bytes memory payload) = address(bomb).call{gas: registry.ENGINE_GAS_LIMIT()}(
            abi.encodeCall(bomb.record, (RELEASE, PROFILE, true, 1))
        );
        assertFalse(ok);
        assertEq(payload.length, bomb.PAYLOAD_BYTES());

        _setEngine(address(bomb));
        (Registry.Outcome memory o, bytes memory sig) = _signed(2, 10_000);
        vm.expectEmit(address(registry));
        emit Registry.EngineRecordFailed(rid);
        uint256 gasBefore = gasleft();
        registry.finalizeOutcome{gas: 1_000_000}(o, sig);
        uint256 used = gasBefore - gasleft();
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Failed));
        // Copying 352 KiB of revert data would cost the caller about 282k gas of memory on top.
        assertLt(used, registry.ENGINE_GAS_LIMIT() + 100_000);
    }

    function test_engine_cannotReenterTheRegistry() public {
        // First make a credit the engine could try to steal or double-spend.
        _activate(_rid(2), ONE_USDC);
        _finalize(_rid(2), 2, 0);

        ReentrantEngine engine = new ReentrantEngine();
        engine.arm(
            address(registry),
            abi.encodeCall(Registry.withdrawCredit, (_rid(2), _claimSecret(_rid(2)), refundTo))
        );
        _setEngine(address(engine));
        (Registry.Outcome memory o, bytes memory sig) = _signed(1, 10_000);
        vm.expectEmit(address(registry));
        emit Registry.EngineRecordFailed(rid);
        registry.finalizeOutcome(o, sig);
        assertFalse(engine.reentered());
        assertEq(uint8(_status(_rid(2))), uint8(Registry.Status.Failed));
        assertEq(usdc.balanceOf(refundTo), 0);
    }

    function test_engine_withoutCodeEmitsAndDoesNotRevert() public {
        RecordingEngine engine = new RecordingEngine();
        _setEngine(address(engine));
        vm.etch(address(engine), ""); // e.g. a delegated account that dropped its code
        (Registry.Outcome memory o, bytes memory sig) = _signed(1, 10_000);
        vm.expectEmit(address(registry));
        emit Registry.EngineRecordFailed(rid);
        registry.finalizeOutcome(o, sig);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Passed));
    }

    /// A relayer cannot starve the engine on purpose: too little gas reverts the whole
    /// finalization instead of recording EngineRecordFailed.
    function test_engine_tooLittleGasRevertsInsteadOfStarvingTheEngine() public {
        _setEngine(address(new RecordingEngine()));
        (Registry.Outcome memory o, bytes memory sig) = _signed(1, 10_000);
        vm.expectRevert(Registry.InsufficientGasForEngine.selector);
        registry.finalizeOutcome{gas: 250_000}(o, sig);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Active));
    }

    /// Whatever gas the caller supplies, the engine either gets its full budget or the call
    /// reverts: never a finalization with a starved engine.
    function testFuzz_engine_getsItsFullBudgetOrNothing(uint256 gasLimit) public {
        RecordingEngine engine = new RecordingEngine();
        _setEngine(address(engine));
        gasLimit = bound(gasLimit, 60_000, 800_000);
        (Registry.Outcome memory o, bytes memory sig) = _signed(1, 10_000);
        try registry.finalizeOutcome{gas: gasLimit}(o, sig) {
            assertEq(uint8(_status(rid)), uint8(Registry.Status.Passed));
            assertEq(engine.callCount(), 1);
            // Only the callee's own dispatch overhead is missing from the budget.
            assertGt(engine.callAt(0).gasAtEntry, registry.ENGINE_GAS_LIMIT() - 1_000);
        } catch {
            assertEq(uint8(_status(rid)), uint8(Registry.Status.Active));
            assertEq(engine.callCount(), 0);
        }
    }
}
