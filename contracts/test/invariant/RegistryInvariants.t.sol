// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

import {ResolutionWarrantyRegistry as Registry} from "../../src/ResolutionWarrantyRegistry.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";
import {RecordingEngine} from "../utils/MockEngines.sol";
import {RegistryHandler} from "./RegistryHandler.sol";

/// The registry's money invariants, checked after every call of random handler sequences.
/// The handler makes only valid calls, so any revert is a bug: fail-on-revert is on. Its attack
/// actions must fail, each for its one expected reason, or they set a violation.
/// Run with -vv to see, per run, how often each action reached the registry.
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
contract RegistryInvariantsTest is Test {
    MockUSDC internal usdc;
    Registry internal registry;
    RecordingEngine internal engine;
    RegistryHandler internal handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        address owner = makeAddr("invariant.owner");
        usdc = new MockUSDC();
        registry = new Registry(usdc, owner);
        engine = new RecordingEngine();
        vm.prank(owner);
        registry.setEngine(address(engine));
        handler = new RegistryHandler(registry, usdc, engine, owner);
        targetContract(address(handler));
    }

    /// Coverage, visible with -vv: the calls of this run that reached the registry.
    function afterInvariant() public view {
        console2.log(handler.callSummary());
    }

    /// The spec's invariant: the registry always holds at least what it owes.
    function invariant_balanceCoversAvailableReservedAndCredits() public view {
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertGe(usdc.balanceOf(address(registry)), available + reserved + credits);
    }

    /// Stronger: the only surplus is USDC sent straight to the registry.
    function invariant_balanceEqualsTotalsPlusDonations() public view {
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertEq(
            usdc.balanceOf(address(registry)),
            available + reserved + credits + handler.ghostDonated()
        );
    }

    /// Every unit that came in either is still owed or went out through a bond withdrawal or a
    /// credit payment.
    function invariant_conservationOfFunds() public view {
        assertEq(
            handler.ghostDeposited() + handler.ghostDonated(),
            usdc.balanceOf(address(registry)) + handler.ghostBondWithdrawn()
                + handler.ghostCreditsPaid()
        );
        assertEq(usdc.balanceOf(handler.treasury()), handler.ghostBondWithdrawn());
    }

    /// Each total equals its sum over releases, and over resolutions.
    function invariant_totalsEqualTheirSums() public view {
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        uint256 sumAvailable;
        uint256 sumReserved;
        for (uint256 i = 0; i < handler.releaseCount(); i++) {
            Registry.Release memory r = registry.release(handler.releases(i));
            sumAvailable += r.available;
            sumReserved += r.reserved;
        }
        assertEq(available, sumAvailable, "available");
        assertEq(reserved, sumReserved, "reserved over releases");

        uint256 activeSum;
        uint256 creditSum;
        uint256[] memory perRelease = new uint256[](handler.releaseCount());
        for (uint256 k = 0; k < handler.resolutionCount(); k++) {
            (bytes32 id, uint256 releaseIndex) = handler.resolutionAt(k);
            Registry.Resolution memory res = registry.resolution(id);
            if (res.status == Registry.Status.Active) {
                activeSum += res.amount;
                perRelease[releaseIndex] += res.amount;
            } else if (res.status == Registry.Status.Failed) {
                creditSum += res.amount;
            }
        }
        assertEq(reserved, activeSum, "reserved over resolutions");
        assertEq(credits, creditSum, "credits over resolutions");
        for (uint256 i = 0; i < handler.releaseCount(); i++) {
            assertEq(registry.release(handler.releases(i)).reserved, perRelease[i], "per release");
        }
    }

    /// Credits reach only the committed refund recipients, and in full.
    function invariant_creditsReachOnlyCommittedRecipients() public view {
        uint256 received;
        for (uint256 i = 0; i < handler.refundCount(); i++) {
            received += usdc.balanceOf(handler.refundRecipients(i));
        }
        assertEq(received, handler.ghostCreditsPaid());
        assertEq(usdc.balanceOf(handler.relayer()), 0);
    }

    /// Replays, wrong claims, over-withdrawals, second finalizations and credit withdrawals, late
    /// finalizations, early expiries, activations on a deactivated release, and finalizations or
    /// expiries while paused all fail for their expected reason; a pause moves a claim deadline
    /// by the paused time; the engine never re-enters; and statuses only move forward.
    function invariant_noForbiddenSuccessOrTransition() public view {
        assertFalse(handler.ghostViolation(), handler.ghostViolationReason());
    }

    /// The recording engine hears about exactly the weighted PASSED and FAILED outcomes finalized
    /// while it is set; the other engines fail in every way and finalization goes on.
    function invariant_engineRecordsEveryWeightedOutcomeOnce() public view {
        assertEq(engine.callCount(), handler.ghostEngineRecords());
    }
}
