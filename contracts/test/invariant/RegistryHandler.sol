// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ResolutionWarrantyRegistry as Registry} from "../../src/ResolutionWarrantyRegistry.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";
import {
    RecordingEngine,
    RevertingEngine,
    GasBurningEngine,
    ReturnBombEngine,
    ReentrantEngine
} from "../utils/MockEngines.sol";

/// Drives the registry through valid operations only (every call must succeed), tries invalid
/// ones that must fail for one expected reason, and keeps ghost accounting the invariants compare
/// against. `callSummary()` counts how often each action reached the registry.
contract RegistryHandler is CommonBase, StdCheats, StdUtils {
    /// Three live releases, plus one retired release (funded, then deactivated) that the
    /// inactive-release attack always has at hand.
    uint256 internal constant LIVE_RELEASES = 3;
    uint256 internal constant REFUND_COUNT = 3;
    uint256 internal constant MAX_DEPOSIT = 1e12; // one million USDC per call
    uint256 internal constant RETIRED_BOND = 1e9;
    uint32 internal constant CLAIM_WINDOW = 2 days;
    uint256 internal constant MAX_PAUSE = 3 days; // longer than a claim window

    uint8 internal constant PASSED = 1;
    uint8 internal constant FAILED = 2;
    uint8 internal constant VOID = 3;

    Registry public immutable registry;
    MockUSDC public immutable usdc;
    RecordingEngine public immutable engine;
    ReentrantEngine public immutable reentrantEngine;
    address public immutable owner;

    bytes32[] public releases;
    address[] public providers;
    uint256[] internal _providerKeys;
    uint256[] internal _evaluatorKeys;
    address[] public refundRecipients;
    address public relayer = makeAddr("invariant.relayer");
    address public treasury = makeAddr("invariant.treasury");
    address public donor = makeAddr("invariant.donor");

    /// The engines `rotateEngine` picks from: the recording engine, the failing mocks, and none.
    address[] internal _engines;
    address public currentEngine;

    struct Tracked {
        bytes32 id;
        uint256 releaseIndex;
        bytes32 claimSecret;
        address refundTo;
        bytes32 paymentRef;
        Registry.Status lastSeen;
    }

    /// Which tracked resolutions an action looks for. "Open" means at or before the claim
    /// deadline in force, "Closed" past it.
    enum Pick {
        ActiveOpen,
        ActiveClosed,
        ActiveAny,
        Failed,
        Refunded,
        Finished
    }

    Tracked[] internal _resolutions;
    uint256 internal _nonce;

    // Ghost accounting, in atomic USDC.
    uint256 public ghostDeposited;
    uint256 public ghostDonated;
    uint256 public ghostBondWithdrawn;
    uint256 public ghostCreditsPaid;
    /// Weighted PASSED/FAILED outcomes finalized while the recording engine was set.
    uint256 public ghostEngineRecords;
    // Set when something that must fail succeeded or failed for another reason, or a status
    // moved along a forbidden edge.
    bool public ghostViolation;
    string public ghostViolationReason;

    mapping(bytes32 => uint256) public calls;
    string[] internal _actionNames;

    constructor(Registry registry_, MockUSDC usdc_, RecordingEngine engine_, address owner_) {
        registry = registry_;
        usdc = usdc_;
        engine = engine_;
        owner = owner_;
        currentEngine = registry_.engine();
        reentrantEngine = new ReentrantEngine();
        _engines.push(address(engine_));
        _engines.push(address(new RevertingEngine()));
        _engines.push(address(new GasBurningEngine()));
        _engines.push(address(new ReturnBombEngine()));
        _engines.push(address(reentrantEngine));
        _engines.push(address(0));

        for (uint256 i = 0; i < LIVE_RELEASES + 1; i++) {
            (address provider, uint256 providerKey) =
                makeAddrAndKey(string.concat("invariant.provider", vm.toString(i)));
            (address evaluator, uint256 evaluatorKey) =
                makeAddrAndKey(string.concat("invariant.evaluator", vm.toString(i)));
            bytes32 digest = keccak256(abi.encode("invariant.release", i));
            vm.prank(owner_);
            registry_.registerRelease(digest, provider, evaluator, CLAIM_WINDOW);
            vm.prank(provider);
            usdc_.approve(address(registry_), type(uint256).max);
            releases.push(digest);
            providers.push(provider);
            _providerKeys.push(providerKey);
            _evaluatorKeys.push(evaluatorKey);
        }
        uint256 retired = LIVE_RELEASES;
        usdc_.mint(providers[retired], RETIRED_BOND);
        vm.prank(providers[retired]);
        registry_.depositBond(releases[retired], RETIRED_BOND);
        ghostDeposited += RETIRED_BOND;
        vm.prank(providers[retired]);
        registry_.deactivateRelease(releases[retired]);

        for (uint256 i = 0; i < REFUND_COUNT; i++) {
            refundRecipients.push(makeAddr(string.concat("invariant.refund", vm.toString(i))));
        }
        _registerActionNames();
    }

    // ---------------------------------------------------------------------------------------------
    // Views for the invariants
    // ---------------------------------------------------------------------------------------------

    function releaseCount() external view returns (uint256) {
        return releases.length;
    }

    function resolutionCount() external view returns (uint256) {
        return _resolutions.length;
    }

    function resolutionAt(uint256 i) external view returns (bytes32 id, uint256 releaseIndex) {
        return (_resolutions[i].id, _resolutions[i].releaseIndex);
    }

    function refundCount() external view returns (uint256) {
        return refundRecipients.length;
    }

    /// "action=count ..." for every action, counting the calls that reached the registry.
    function callSummary() external view returns (string memory summary) {
        for (uint256 i = 0; i < _actionNames.length; i++) {
            string memory name = _actionNames[i];
            summary = string.concat(
                summary, i == 0 ? "" : " ", name, "=", vm.toString(calls[keccak256(bytes(name))])
            );
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Valid operations
    // ---------------------------------------------------------------------------------------------

    function depositBond(uint256 releaseSeed, uint256 amount) external {
        uint256 i = releaseSeed % LIVE_RELEASES;
        if (registry.paused() || !registry.release(releases[i]).active) return;
        _deposit(i, bound(amount, 1, MAX_DEPOSIT));
        _after("depositBond");
    }

    function withdrawUnreservedBond(uint256 releaseSeed, uint256 amount) external {
        uint256 i = releaseSeed % releases.length;
        uint256 available = registry.release(releases[i]).available;
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(providers[i]);
        registry.withdrawUnreservedBond(releases[i], amount, treasury);
        ghostBondWithdrawn += amount;
        _after("withdrawUnreservedBond");
    }

    /// Activates a voucher on a live release, first funding its bond if none is available.
    function activateResolution(
        uint256 releaseSeed,
        uint256 amount,
        uint8 profileIndex,
        uint256 refundSeed
    ) external {
        uint256 i = releaseSeed % LIVE_RELEASES;
        Registry.Release memory r = registry.release(releases[i]);
        if (registry.paused() || !r.active) return;
        if (r.available == 0) {
            _deposit(i, bound(amount, 1, MAX_DEPOSIT));
            r = registry.release(releases[i]);
        }
        amount = bound(amount, 1, r.available);
        uint256 n = ++_nonce;
        bytes32 id = keccak256(abi.encode("invariant.resolution", n));
        bytes32 paymentRef = keccak256(abi.encode("invariant.paymentRef", n));
        bytes32 claimSecret = keccak256(abi.encode("invariant.claim", n));
        address refundTo = refundRecipients[refundSeed % REFUND_COUNT];
        Registry.Voucher memory v = _voucherFor(
            id,
            releases[i],
            profileIndex,
            amount,
            paymentRef,
            keccak256(abi.encode(id, claimSecret, refundTo))
        );
        bytes memory sig = _sign(_providerKeys[i], registry.hashVoucher(v));
        vm.prank(relayer);
        registry.activateResolution(v, sig);
        _resolutions.push(Tracked(id, i, claimSecret, refundTo, paymentRef, Registry.Status.None));
        _after("activateResolution");
    }

    function finalizeOutcome(uint256 resolutionSeed, uint8 verdict, uint16 weightBps) external {
        if (registry.paused()) return;
        (bool found, uint256 k) = _find(resolutionSeed, Pick.ActiveOpen);
        if (!found) return;
        _finalize(
            k,
            uint8(bound(verdict, PASSED, VOID)),
            uint16(bound(weightBps, 0, 10_000)),
            uint64(block.timestamp)
        );
        _after("finalizeOutcome");
    }

    /// Warps to exactly an open warranty's claim deadline and finalizes there, the last second
    /// it may.
    function finalizeAtDeadline(uint256 resolutionSeed, uint8 verdict, uint16 weightBps) external {
        if (registry.paused()) return;
        (bool found, uint256 k) = _find(resolutionSeed, Pick.ActiveOpen);
        if (!found) return;
        uint64 deadline = registry.claimDeadlineOf(_resolutions[k].id);
        vm.warp(deadline);
        _finalize(
            k, uint8(bound(verdict, PASSED, VOID)), uint16(bound(weightBps, 0, 10_000)), deadline
        );
        _after("finalizeAtDeadline");
    }

    /// A FAILED outcome for an open warranty meets a pause, possibly longer than the claim
    /// window. While paused, neither the outcome nor an expiry goes through. After the unpause
    /// the deadline has moved by the paused time, and the outcome lands.
    function finalizeFailedAcrossAPause(uint256 resolutionSeed, uint256 pauseSeconds) external {
        if (registry.paused()) return;
        (bool found, uint256 k) = _find(resolutionSeed, Pick.ActiveOpen);
        if (!found) return;
        bytes32 id = _resolutions[k].id;
        uint64 deadline = registry.claimDeadlineOf(id);
        pauseSeconds = bound(pauseSeconds, 1, MAX_PAUSE);

        vm.prank(owner);
        registry.pause();
        vm.warp(block.timestamp + pauseSeconds);
        bytes memory paused = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        _expectFinalizeFailure(k, paused, "finalization while paused");
        _expectExpireFailure(id, paused, "expiry while paused");
        vm.prank(owner);
        registry.unpause();

        if (registry.claimDeadlineOf(id) != deadline + pauseSeconds) {
            _violation("a pause did not move the claim deadline");
        }
        _finalize(k, FAILED, 10_000, uint64(block.timestamp));
        _after("finalizeFailedAcrossAPause");
    }

    function expireResolution(uint256 resolutionSeed) external {
        if (registry.paused()) return;
        (bool found, uint256 k) = _find(resolutionSeed, Pick.ActiveClosed);
        if (!found) return;
        registry.expireResolution(_resolutions[k].id);
        _after("expireResolution");
    }

    /// Warps one second past a warranty's claim deadline (unless it is already past): finalizing
    /// must now fail, and expiring must succeed.
    function expireAfterDeadline(uint256 resolutionSeed) external {
        if (registry.paused()) return;
        (bool found, uint256 k) = _find(resolutionSeed, Pick.ActiveAny);
        if (!found) return;
        bytes32 id = _resolutions[k].id;
        uint64 deadline = registry.claimDeadlineOf(id);
        if (block.timestamp <= deadline) vm.warp(uint256(deadline) + 1);
        _expectFinalizeFailure(
            k,
            abi.encodeWithSelector(Registry.ClaimWindowClosed.selector, deadline),
            "finalization after the deadline"
        );
        registry.expireResolution(id);
        _after("expireAfterDeadline");
    }

    function withdrawCredit(uint256 resolutionSeed) external {
        (bool found, uint256 k) = _find(resolutionSeed, Pick.Failed);
        if (!found) return;
        Tracked storage t = _resolutions[k];
        Registry.Resolution memory res = registry.resolution(t.id);
        vm.prank(relayer);
        registry.withdrawCredit(t.id, t.claimSecret, t.refundTo);
        ghostCreditsPaid += res.amount;
        _after("withdrawCredit");
    }

    function deactivateRelease(uint256 releaseSeed) external {
        uint256 i = releaseSeed % LIVE_RELEASES;
        if (!registry.release(releases[i]).active) return;
        // Rare, and never on the fuzzer's favourite edge values (0, 1, max), so runs keep
        // exercising activation.
        if (releaseSeed % 31 != 17) return;
        vm.prank(providers[i]);
        registry.deactivateRelease(releases[i]);
        _after("deactivateRelease");
    }

    function togglePause(uint256 seed) external {
        bool paused = registry.paused();
        // Pause rarely (and not on edge values), unpause readily: pauses stay short.
        if (paused ? seed % 2 != 0 : seed % 13 != 7) return;
        vm.prank(owner);
        if (paused) registry.unpause();
        else registry.pause();
        _after("togglePause");
    }

    /// Sets another engine: the recording one, one that reverts, burns its gas, returns a huge
    /// revert payload or tries to re-enter, or none.
    function rotateEngine(uint256 seed) external {
        address next = _engines[seed % _engines.length];
        if (next == currentEngine) return;
        vm.prank(owner);
        registry.setEngine(next);
        currentEngine = next;
        _after("rotateEngine");
    }

    function warp(uint256 secondsForward) external {
        // Mostly short steps, so warranties get finalized, and sometimes past a claim window.
        secondsForward = bound(secondsForward, 1, 1 days);
        vm.warp(block.timestamp + secondsForward);
        _after("warp");
    }

    /// USDC sent straight to the registry: the balance may exceed the totals, never fall short.
    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1e9);
        usdc.mint(donor, amount);
        vm.prank(donor);
        require(usdc.transfer(address(registry), amount), "donation failed");
        ghostDonated += amount;
        _after("donate");
    }

    // ---------------------------------------------------------------------------------------------
    // Operations that must fail, each for one expected reason
    // ---------------------------------------------------------------------------------------------

    /// Replays a spent resolution id or payment reference with a fresh, validly signed voucher
    /// for a live, funded release, so the replay is the only reason it can fail.
    function attackReplay(uint256 resolutionSeed, bool replayPaymentRef) external {
        if (_resolutions.length == 0 || registry.paused()) return;
        Tracked storage t = _resolutions[resolutionSeed % _resolutions.length];
        Registry.Release memory r = registry.release(releases[t.releaseIndex]);
        if (!r.active || r.available == 0) return;
        bytes32 fresh = keccak256(abi.encode("invariant.fresh", ++_nonce));
        Registry.Voucher memory v = _voucherFor(
            replayPaymentRef ? fresh : t.id,
            releases[t.releaseIndex],
            0,
            1,
            replayPaymentRef ? t.paymentRef : fresh,
            keccak256("x")
        );
        bytes memory sig = _sign(_providerKeys[t.releaseIndex], registry.hashVoucher(v));
        bytes memory expected = replayPaymentRef
            ? abi.encodeWithSelector(Registry.PaymentRefAlreadyUsed.selector, t.paymentRef)
            : abi.encodeWithSelector(Registry.ResolutionAlreadyExists.selector, t.id);
        try registry.activateResolution(v, sig) {
            _violation("replayed voucher activated");
        } catch (bytes memory reason) {
            _expectReason(reason, expected, "replayed voucher");
        }
        _after("attackReplay");
    }

    /// Activates a fresh, validly signed voucher on a deactivated but funded release.
    function attackActivateInactive(uint256 releaseSeed) external {
        if (registry.paused()) return;
        uint256 n = releases.length;
        uint256 start = releaseSeed % n;
        for (uint256 step = 0; step < n; step++) {
            uint256 i = (start + step) % n;
            Registry.Release memory r = registry.release(releases[i]);
            if (r.active || r.available == 0) continue;
            bytes32 fresh = keccak256(abi.encode("invariant.fresh", ++_nonce));
            Registry.Voucher memory v = _voucherFor(fresh, releases[i], 0, 1, fresh, fresh);
            bytes memory sig = _sign(_providerKeys[i], registry.hashVoucher(v));
            try registry.activateResolution(v, sig) {
                _violation("voucher activated on a deactivated release");
            } catch (bytes memory reason) {
                _expectReason(
                    reason,
                    abi.encodeWithSelector(Registry.ReleaseNotActive.selector, releases[i]),
                    "activation on a deactivated release"
                );
            }
            _after("attackActivateInactive");
            return;
        }
    }

    /// Finalizes a warranty that already reached an end state.
    function attackDoubleFinalize(uint256 resolutionSeed) external {
        if (registry.paused()) return;
        (bool found, uint256 k) = _find(resolutionSeed, Pick.Finished);
        if (!found) return;
        _expectFinalizeFailure(
            k,
            abi.encodeWithSelector(Registry.ResolutionNotActive.selector, _resolutions[k].id),
            "second finalization"
        );
        _after("attackDoubleFinalize");
    }

    /// Finalizes an Active warranty past its claim deadline, warping up to a day past it first
    /// if its window is still open. The warranty stays Active, for expiry to pick up.
    function attackLateFinalize(uint256 resolutionSeed, uint256 overshoot) external {
        if (registry.paused()) return;
        (bool found, uint256 k) = _find(resolutionSeed, Pick.ActiveAny);
        if (!found) return;
        uint64 deadline = registry.claimDeadlineOf(_resolutions[k].id);
        if (block.timestamp <= deadline) vm.warp(deadline + bound(overshoot, 1, 1 days));
        _expectFinalizeFailure(
            k,
            abi.encodeWithSelector(Registry.ClaimWindowClosed.selector, deadline),
            "finalization after the deadline"
        );
        _after("attackLateFinalize");
    }

    /// Expires a warranty whose claim window is still open.
    function attackEarlyExpire(uint256 resolutionSeed) external {
        if (registry.paused()) return;
        (bool found, uint256 k) = _find(resolutionSeed, Pick.ActiveOpen);
        if (!found) return;
        bytes32 id = _resolutions[k].id;
        _expectExpireFailure(
            id,
            abi.encodeWithSelector(Registry.ClaimWindowOpen.selector, registry.claimDeadlineOf(id)),
            "expiry before the deadline"
        );
        _after("attackEarlyExpire");
    }

    /// While paused, a warranty can be neither finalized nor expired, whatever its window. If
    /// the registry is not paused, the owner pauses it for the attempt and unpauses after.
    function attackWhilePaused(uint256 resolutionSeed) external {
        (bool found, uint256 k) = _find(resolutionSeed, Pick.ActiveAny);
        if (!found) return;
        bool pausedHere = !registry.paused();
        if (pausedHere) {
            vm.prank(owner);
            registry.pause();
        }
        bytes memory paused = abi.encodeWithSelector(Pausable.EnforcedPause.selector);
        _expectFinalizeFailure(k, paused, "finalization while paused");
        _expectExpireFailure(_resolutions[k].id, paused, "expiry while paused");
        if (pausedHere) {
            vm.prank(owner);
            registry.unpause();
        }
        _after("attackWhilePaused");
    }

    /// Claims a credit with a wrong secret, or redirects it to another address.
    function attackClaim(uint256 resolutionSeed, bytes32 guess, bool redirect) external {
        if (_resolutions.length == 0) return;
        Tracked storage t = _resolutions[resolutionSeed % _resolutions.length];
        bytes32 claimSecret = redirect ? t.claimSecret : guess;
        address to = redirect ? relayer : t.refundTo;
        if (claimSecret == t.claimSecret && to == t.refundTo) return;
        bytes memory expected = registry.resolution(t.id).status == Registry.Status.Failed
            ? abi.encodeWithSelector(Registry.InvalidClaim.selector)
            : abi.encodeWithSelector(Registry.NoCredit.selector, t.id);
        try registry.withdrawCredit(t.id, claimSecret, to) {
            _violation("credit paid on a wrong claim");
        } catch (bytes memory reason) {
            _expectReason(reason, expected, "wrong claim");
        }
        _after("attackClaim");
    }

    /// Withdraws a credit a second time, with the right secret and recipient.
    function attackDoubleWithdrawCredit(uint256 resolutionSeed) external {
        (bool found, uint256 k) = _find(resolutionSeed, Pick.Refunded);
        if (!found) return;
        Tracked storage t = _resolutions[k];
        vm.prank(relayer);
        try registry.withdrawCredit(t.id, t.claimSecret, t.refundTo) {
            _violation("credit paid twice");
        } catch (bytes memory reason) {
            _expectReason(
                reason,
                abi.encodeWithSelector(Registry.NoCredit.selector, t.id),
                "second credit withdrawal"
            );
        }
        _after("attackDoubleWithdrawCredit");
    }

    /// Withdraws one unit more than the unreserved bond.
    function attackOverWithdraw(uint256 releaseSeed) external {
        uint256 i = releaseSeed % releases.length;
        uint256 available = registry.release(releases[i]).available;
        vm.prank(providers[i]);
        try registry.withdrawUnreservedBond(releases[i], available + 1, treasury) {
            _violation("reserved bond withdrawn");
        } catch (bytes memory reason) {
            _expectReason(
                reason,
                abi.encodeWithSelector(
                    Registry.InsufficientAvailableBond.selector, available, available + 1
                ),
                "over-withdrawal"
            );
        }
        _after("attackOverWithdraw");
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Mints `amount` to release `i`'s provider and deposits it; the call must succeed.
    function _deposit(uint256 i, uint256 amount) internal {
        usdc.mint(providers[i], amount);
        vm.prank(providers[i]);
        registry.depositBond(releases[i], amount);
        ghostDeposited += amount;
    }

    function _voucherFor(
        bytes32 id,
        bytes32 releaseDigest,
        uint8 profileIndex,
        uint256 amount,
        bytes32 paymentRef,
        bytes32 claimHash
    ) internal view returns (Registry.Voucher memory) {
        return Registry.Voucher({
            resolutionId: id,
            releaseDigest: releaseDigest,
            profileIndex: profileIndex,
            amount: amount,
            paymentRef: paymentRef,
            claimHash: claimHash,
            activateBy: uint64(block.timestamp + 1 hours)
        });
    }

    function _signedOutcome(uint256 k, uint8 verdict, uint16 weightBps, uint64 validUntil)
        internal
        view
        returns (Registry.Outcome memory o, bytes memory sig)
    {
        Tracked storage t = _resolutions[k];
        o = Registry.Outcome({
            resolutionId: t.id,
            verdict: verdict,
            weightBps: weightBps,
            evidenceHash: keccak256(abi.encode("invariant.evidence", t.id)),
            validUntil: validUntil
        });
        sig = _sign(_evaluatorKeys[t.releaseIndex], registry.hashOutcome(o));
    }

    /// Finalizes tracked resolution `k`; the call must succeed.
    function _finalize(uint256 k, uint8 verdict, uint16 weightBps, uint64 validUntil) internal {
        (Registry.Outcome memory o, bytes memory sig) =
            _signedOutcome(k, verdict, weightBps, validUntil);
        if (currentEngine == address(reentrantEngine)) _armReentrantEngine(k, verdict);
        vm.prank(relayer);
        registry.finalizeOutcome(o, sig);
        if (verdict != VOID && weightBps != 0 && currentEngine == address(engine)) {
            ghostEngineRecords++;
        }
        if (reentrantEngine.reentered()) _violation("the engine re-entered the registry");
    }

    /// Aims the reentrant engine at the credit this finalization creates (FAILED), or else at
    /// another open credit. If the lock ever failed, that credit would be paid outside the ghost
    /// accounting and the invariants would catch it.
    function _armReentrantEngine(uint256 k, uint8 verdict) internal {
        uint256 target = k;
        if (verdict != FAILED) {
            (bool found, uint256 j) = _find(k, Pick.Failed);
            if (found) target = j;
        }
        Tracked storage t = _resolutions[target];
        reentrantEngine.arm(
            address(registry),
            abi.encodeCall(Registry.withdrawCredit, (t.id, t.claimSecret, t.refundTo))
        );
    }

    /// A validly signed FAILED outcome for tracked resolution `k` must fail with `expected`.
    function _expectFinalizeFailure(uint256 k, bytes memory expected, string memory what) internal {
        (Registry.Outcome memory o, bytes memory sig) =
            _signedOutcome(k, FAILED, 10_000, uint64(block.timestamp));
        vm.prank(relayer);
        try registry.finalizeOutcome(o, sig) {
            _violation(string.concat(what, " succeeded"));
        } catch (bytes memory reason) {
            _expectReason(reason, expected, what);
        }
    }

    function _expectExpireFailure(bytes32 id, bytes memory expected, string memory what) internal {
        try registry.expireResolution(id) {
            _violation(string.concat(what, " succeeded"));
        } catch (bytes memory reason) {
            _expectReason(reason, expected, what);
        }
    }

    function _expectReason(bytes memory reason, bytes memory expected, string memory what)
        internal
    {
        if (keccak256(reason) != keccak256(expected)) {
            _violation(string.concat(what, " failed for another reason"));
        }
    }

    /// First tracked resolution matching `pick`, scanning from `seed`.
    function _find(uint256 seed, Pick pick) internal view returns (bool found, uint256 index) {
        uint256 n = _resolutions.length;
        if (n == 0) return (false, 0);
        uint256 start = seed % n;
        for (uint256 step = 0; step < n; step++) {
            index = (start + step) % n;
            if (_matches(_resolutions[index].id, pick)) return (true, index);
        }
        return (false, 0);
    }

    function _matches(bytes32 id, Pick pick) internal view returns (bool) {
        Registry.Status status = registry.resolution(id).status;
        if (pick == Pick.Failed) return status == Registry.Status.Failed;
        if (pick == Pick.Refunded) return status == Registry.Status.Refunded;
        if (pick == Pick.Finished) {
            return status != Registry.Status.None && status != Registry.Status.Active;
        }
        if (status != Registry.Status.Active) return false;
        if (pick == Pick.ActiveAny) return true;
        bool open = block.timestamp <= registry.claimDeadlineOf(id);
        return pick == Pick.ActiveOpen ? open : !open;
    }

    function _violation(string memory reason) internal {
        ghostViolation = true;
        ghostViolationReason = reason;
    }

    /// Checks every tracked resolution moved only along allowed edges since the last call:
    /// None -> Active -> {Passed, Failed, Voided, Expired}, Failed -> Refunded.
    function _after(string memory action) internal {
        calls[keccak256(bytes(action))]++;
        for (uint256 k = 0; k < _resolutions.length; k++) {
            Tracked storage t = _resolutions[k];
            Registry.Status now_ = registry.resolution(t.id).status;
            Registry.Status was = t.lastSeen;
            if (now_ != was && !_allowed(was, now_)) _violation("forbidden status transition");
            t.lastSeen = now_;
        }
    }

    function _allowed(Registry.Status from, Registry.Status to) internal pure returns (bool) {
        if (from == Registry.Status.None) return to == Registry.Status.Active;
        if (from == Registry.Status.Active) {
            return to == Registry.Status.Passed || to == Registry.Status.Failed
                || to == Registry.Status.Voided || to == Registry.Status.Expired;
        }
        if (from == Registry.Status.Failed) return to == Registry.Status.Refunded;
        return false;
    }

    function _registerActionNames() internal {
        _actionNames.push("depositBond");
        _actionNames.push("withdrawUnreservedBond");
        _actionNames.push("activateResolution");
        _actionNames.push("finalizeOutcome");
        _actionNames.push("finalizeAtDeadline");
        _actionNames.push("finalizeFailedAcrossAPause");
        _actionNames.push("expireResolution");
        _actionNames.push("expireAfterDeadline");
        _actionNames.push("withdrawCredit");
        _actionNames.push("deactivateRelease");
        _actionNames.push("togglePause");
        _actionNames.push("rotateEngine");
        _actionNames.push("warp");
        _actionNames.push("donate");
        _actionNames.push("attackReplay");
        _actionNames.push("attackActivateInactive");
        _actionNames.push("attackDoubleFinalize");
        _actionNames.push("attackLateFinalize");
        _actionNames.push("attackEarlyExpire");
        _actionNames.push("attackWhilePaused");
        _actionNames.push("attackClaim");
        _actionNames.push("attackDoubleWithdrawCredit");
        _actionNames.push("attackOverWithdraw");
    }
}
