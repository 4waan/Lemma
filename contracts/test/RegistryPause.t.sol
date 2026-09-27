// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ResolutionWarrantyRegistry as Registry} from "../src/ResolutionWarrantyRegistry.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// A pause stops the claim clock. Time spent paused after activation moves a warranty's claim
/// deadline later, and expiry is paused with finalization, so a pause can never run out a buyer's
/// window: after the unpause, a warranty is finalizable exactly when it was at the pause.
contract RegistryPauseTest is RegistryTestBase {
    bytes32 internal rid;
    uint64 internal deadline;

    function setUp() public override {
        super.setUp();
        _deposit(RELEASE, 10 * ONE_USDC);
        rid = _rid(1);
        _activate(rid, 4 * ONE_USDC);
        deadline = registry.resolution(rid).claimDeadline; // START + 7 days
    }

    function _pause() internal {
        vm.prank(owner);
        registry.pause();
    }

    function _unpause() internal {
        vm.prank(owner);
        registry.unpause();
    }

    function _failedOutcome() internal view returns (Registry.Outcome memory o, bytes memory sig) {
        o = _outcome(rid, 2, 10_000);
        o.validUntil = uint64(START + 60 days);
        sig = _signOutcome(evaluatorKey, o);
    }

    /// The review scenario, reversed. A FAILED outcome signed a day before the deadline cannot be
    /// submitted during a pause. The provider can neither expire the warranty nor take its
    /// reserved bond meanwhile, and after the unpause the outcome still lands.
    function test_pause_cannotRunOutAFailedOutcomesClaimWindow() public {
        vm.warp(START + 6 days);
        (Registry.Outcome memory o, bytes memory sig) = _failedOutcome();

        _pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.finalizeOutcome(o, sig);

        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(provider);
        registry.expireResolution(rid);
        vm.expectRevert(
            abi.encodeWithSelector(
                Registry.InsufficientAvailableBond.selector, 6 * ONE_USDC, 10 * ONE_USDC
            )
        );
        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, 10 * ONE_USDC, provider);

        vm.warp(START + 8 days);
        _unpause();
        // Paused for two days with one day left: one day is still left.
        assertEq(registry.claimDeadlineOf(rid), deadline + 2 days);
        vm.expectRevert(
            abi.encodeWithSelector(Registry.ClaimWindowOpen.selector, deadline + 2 days)
        );
        vm.prank(provider);
        registry.expireResolution(rid);

        vm.prank(relayer);
        registry.finalizeOutcome(o, sig);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Failed));
        _withdrawCredit(rid);
        assertEq(usdc.balanceOf(refundTo), 4 * ONE_USDC);
        assertEq(_available(RELEASE), 6 * ONE_USDC);
        _assertBalanceMatchesTotals();
    }

    /// Finalization is allowed up to and including the moved deadline, expiry only after it.
    function test_pause_movesBothBoundariesByThePausedTime() public {
        vm.warp(START + 1 days);
        _pause();
        vm.warp(START + 4 days);
        _unpause();
        uint64 moved = deadline + 3 days;
        assertEq(registry.claimDeadlineOf(rid), moved);
        assertEq(registry.resolution(rid).claimDeadline, deadline, "stored deadline unchanged");

        vm.warp(moved);
        vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowOpen.selector, moved));
        registry.expireResolution(rid);
        uint256 snapshot = vm.snapshotState();
        (Registry.Outcome memory o, bytes memory sig) = _failedOutcome();
        registry.finalizeOutcome(o, sig);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Failed));
        vm.revertToState(snapshot);

        vm.warp(uint256(moved) + 1);
        vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowClosed.selector, moved));
        registry.finalizeOutcome(o, sig);
        vm.prank(stranger);
        registry.expireResolution(rid);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Expired));
        assertEq(_available(RELEASE), 10 * ONE_USDC);
        _assertBalanceMatchesTotals();
    }

    /// Pauses add up, and only the ones after a warranty's activation move its deadline.
    function test_pause_countsEveryPauseAfterActivationAndNoneBefore() public {
        vm.warp(START + 1 hours);
        _pause();
        vm.warp(START + 1 days + 1 hours);
        _unpause();
        assertEq(registry.pausedSeconds(), 1 days);

        // Activated after the first pause: that pause does not count for it.
        bytes32 later = _rid(2);
        _activate(later, ONE_USDC);
        uint64 laterDeadline = registry.resolution(later).claimDeadline;
        assertEq(laterDeadline, block.timestamp + CLAIM_WINDOW);
        assertEq(registry.resolution(later).pausedSecondsAtActivation, 1 days);
        assertEq(registry.claimDeadlineOf(later), laterDeadline);

        vm.warp(START + 2 days);
        _pause();
        vm.warp(START + 4 days);
        _unpause();
        assertEq(registry.pausedSeconds(), 3 days);
        assertEq(registry.claimDeadlineOf(rid), deadline + 3 days);
        assertEq(registry.claimDeadlineOf(later), laterDeadline + 2 days);
    }

    /// The views move with an ongoing pause, and the deadline view is zero once a warranty is
    /// no longer Active.
    function test_pause_viewsCountAnOngoingPause() public {
        assertEq(registry.pausedSeconds(), 0);
        assertEq(registry.claimDeadlineOf(rid), deadline);
        assertEq(registry.claimDeadlineOf(_rid(99)), 0, "never activated");

        vm.warp(START + 2 days);
        _pause();
        assertEq(registry.pausedSeconds(), 0);
        vm.warp(START + 3 days);
        assertEq(registry.pausedSeconds(), 1 days);
        assertEq(registry.claimDeadlineOf(rid), deadline + 1 days);
        vm.warp(START + 30 days);
        assertEq(registry.pausedSeconds(), 28 days);
        assertEq(registry.claimDeadlineOf(rid), deadline + 28 days);
        _unpause();
        assertEq(registry.pausedSeconds(), 28 days);

        (Registry.Outcome memory o, bytes memory sig) = _failedOutcome();
        registry.finalizeOutcome(o, sig);
        assertEq(registry.claimDeadlineOf(rid), 0, "finished");
    }

    /// A pause that begins after the deadline does not reopen the window: the paused time is
    /// added to the deadline and to the clock alike.
    function test_pause_afterTheDeadlineDoesNotReopenTheWindow() public {
        vm.warp(uint256(deadline) + 1);
        _pause();
        vm.warp(uint256(deadline) + 1 + 5 days);
        _unpause();
        uint64 moved = deadline + 5 days;
        (Registry.Outcome memory o, bytes memory sig) = _failedOutcome();
        vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowClosed.selector, moved));
        registry.finalizeOutcome(o, sig);
        registry.expireResolution(rid);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Expired));
    }

    /// While paused, nothing moves a warranty; bond and credit withdrawals keep working.
    function test_pause_freezesWarrantiesButNotWithdrawals() public {
        _activate(_rid(2), ONE_USDC);
        _finalize(_rid(2), 2, 10_000);
        vm.warp(uint256(deadline) + 1); // rid is expirable
        _pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.expireResolution(rid);
        _withdrawCredit(_rid(2));
        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, 5 * ONE_USDC, provider);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Active));
        assertEq(usdc.balanceOf(refundTo), ONE_USDC);
        _assertBalanceMatchesTotals();
    }

    /// Whenever a pause starts and however long it lasts, a warranty leaves it with the window it
    /// had when the pause started: the same seconds left if it was open, closed if it was closed.
    function testFuzz_pause_keepsTheWindowAWarrantyHadWhenItStarted(
        uint256 pauseAt,
        uint256 pauseLength
    ) public {
        pauseAt = bound(pauseAt, 0, 2 * CLAIM_WINDOW);
        pauseLength = bound(pauseLength, 1, 90 days);
        vm.warp(START + pauseAt);
        bool wasOpen = block.timestamp <= deadline;
        uint256 secondsLeft = wasOpen ? deadline - block.timestamp : 0;

        _pause();
        vm.warp(block.timestamp + pauseLength);
        _unpause();

        uint64 moved = registry.claimDeadlineOf(rid);
        assertEq(moved, deadline + pauseLength);
        (Registry.Outcome memory o, bytes memory sig) = _failedOutcome();
        o.validUntil = type(uint64).max;
        sig = _signOutcome(evaluatorKey, o);
        if (wasOpen) {
            assertEq(moved - block.timestamp, secondsLeft);
            registry.finalizeOutcome(o, sig);
            assertEq(uint8(_status(rid)), uint8(Registry.Status.Failed));
        } else {
            vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowClosed.selector, moved));
            registry.finalizeOutcome(o, sig);
            registry.expireResolution(rid);
            assertEq(uint8(_status(rid)), uint8(Registry.Status.Expired));
        }
        _assertBalanceMatchesTotals();
    }
}
