// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ResolutionWarrantyRegistry as Registry} from "../src/ResolutionWarrantyRegistry.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// Property tests over whole input domains: accounting, signatures, deadlines and claims.
contract RegistryFuzzTest is RegistryTestBase {
    /// secp256k1 group order: valid private keys are 1 .. N - 1.
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// Up to one billion USDC, in atomic units.
    uint256 internal constant MAX_AMOUNT = 1e15;

    function testFuzz_lifecycle_accountingIsExact(
        uint256 deposit,
        uint256 amount,
        uint8 verdict,
        uint16 weightBps
    ) public {
        deposit = bound(deposit, 1, MAX_AMOUNT);
        amount = bound(amount, 1, deposit);
        verdict = uint8(bound(verdict, 1, 3));
        weightBps = uint16(bound(weightBps, 0, 10_000));
        usdc.mint(provider, deposit);
        _deposit(RELEASE, deposit);

        bytes32 rid = _rid(1);
        _activate(rid, amount);
        assertEq(_available(RELEASE), deposit - amount);
        assertEq(_reserved(RELEASE), amount);
        _assertBalanceMatchesTotals();

        _finalize(rid, verdict, weightBps);
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertEq(reserved, 0);
        if (verdict == 2) {
            assertEq(available, deposit - amount);
            assertEq(credits, amount);
            _withdrawCredit(rid);
            assertEq(usdc.balanceOf(refundTo), amount);
        } else {
            assertEq(available, deposit);
            assertEq(credits, 0);
        }
        _assertBalanceMatchesTotals();
    }

    function testFuzz_activate_rejectsEveryOtherSigner(uint256 key) public {
        key = bound(key, 1, SECP256K1_N - 1);
        vm.assume(key != providerKey);
        _deposit(RELEASE, ONE_USDC);
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        bytes memory sig = _signVoucher(key, v);
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, sig);
    }

    function testFuzz_finalize_rejectsEveryOtherSigner(uint256 key) public {
        key = bound(key, 1, SECP256K1_N - 1);
        vm.assume(key != evaluatorKey);
        _deposit(RELEASE, ONE_USDC);
        _activate(_rid(1), ONE_USDC);
        Registry.Outcome memory o = _outcome(_rid(1), 2, 10_000);
        bytes memory sig = _signOutcome(key, o);
        vm.expectRevert(Registry.InvalidEvaluatorSignature.selector);
        registry.finalizeOutcome(o, sig);
    }

    function testFuzz_activate_onlyUntilActivateBy(uint64 activateBy, uint256 elapsed) public {
        activateBy = uint64(bound(activateBy, START, START + 30 days));
        elapsed = bound(elapsed, 0, 60 days);
        _deposit(RELEASE, ONE_USDC);
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        v.activateBy = activateBy;
        bytes memory sig = _signVoucher(providerKey, v);
        vm.warp(START + elapsed);
        if (block.timestamp > activateBy) {
            vm.expectRevert(abi.encodeWithSelector(Registry.VoucherExpired.selector, activateBy));
        }
        registry.activateResolution(v, sig);
    }

    function testFuzz_finalize_onlyWhileTheOutcomeAndClaimWindowAreOpen(
        uint64 validUntil,
        uint256 elapsed
    ) public {
        _deposit(RELEASE, ONE_USDC);
        _activate(_rid(1), ONE_USDC);
        uint64 deadline = registry.resolution(_rid(1)).claimDeadline;
        validUntil = uint64(bound(validUntil, START, START + 2 * CLAIM_WINDOW));
        elapsed = bound(elapsed, 0, 3 * CLAIM_WINDOW);

        Registry.Outcome memory o = _outcome(_rid(1), 1, 10_000);
        o.validUntil = validUntil;
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.warp(START + elapsed);
        if (block.timestamp > validUntil) {
            vm.expectRevert(abi.encodeWithSelector(Registry.OutcomeExpired.selector, validUntil));
        } else if (block.timestamp > deadline) {
            vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowClosed.selector, deadline));
        }
        registry.finalizeOutcome(o, sig);
    }

    function testFuzz_finalize_weightAboveTenThousandReverts(uint16 weightBps) public {
        _deposit(RELEASE, ONE_USDC);
        _activate(_rid(1), ONE_USDC);
        Registry.Outcome memory o = _outcome(_rid(1), 1, weightBps);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        if (weightBps > 10_000) {
            vm.expectRevert(abi.encodeWithSelector(Registry.InvalidWeight.selector, weightBps));
        }
        registry.finalizeOutcome(o, sig);
    }

    function testFuzz_expire_onlyAfterTheDeadline(uint256 elapsed) public {
        _deposit(RELEASE, ONE_USDC);
        _activate(_rid(1), ONE_USDC);
        uint64 deadline = registry.resolution(_rid(1)).claimDeadline;
        elapsed = bound(elapsed, 0, 3 * CLAIM_WINDOW);
        vm.warp(START + elapsed);
        if (block.timestamp <= deadline) {
            vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowOpen.selector, deadline));
        }
        registry.expireResolution(_rid(1));
    }

    /// Only the exact committed (secret, recipient) pair unlocks a credit.
    function testFuzz_withdrawCredit_onlyTheCommittedPair(
        bytes32 claimSecret,
        address to,
        bytes32 otherSecret,
        address otherTo
    ) public {
        vm.assume(to != address(0) && to != address(registry));
        vm.assume(otherTo != address(0) && otherTo != address(registry));
        vm.assume(claimSecret != otherSecret || to != otherTo);
        _deposit(RELEASE, ONE_USDC);
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        v.claimHash = _claimHash(v.resolutionId, claimSecret, to);
        registry.activateResolution(v, _signVoucher(providerKey, v));
        _finalize(v.resolutionId, 2, 10_000);

        vm.expectRevert(Registry.InvalidClaim.selector);
        registry.withdrawCredit(v.resolutionId, otherSecret, otherTo);

        uint256 before = usdc.balanceOf(to);
        registry.withdrawCredit(v.resolutionId, claimSecret, to);
        assertEq(usdc.balanceOf(to) - before, ONE_USDC);
    }

    /// The provider can withdraw exactly the unreserved part, never a unit more.
    function testFuzz_withdrawUnreservedBond_neverTouchesReservedBond(
        uint256 deposit,
        uint256 reserve,
        uint256 withdrawAmount
    ) public {
        deposit = bound(deposit, 1, MAX_AMOUNT);
        reserve = bound(reserve, 1, deposit);
        withdrawAmount = bound(withdrawAmount, 1, MAX_AMOUNT);
        usdc.mint(provider, deposit);
        _deposit(RELEASE, deposit);
        _activate(_rid(1), reserve);

        uint256 unreserved = deposit - reserve;
        if (withdrawAmount > unreserved) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    Registry.InsufficientAvailableBond.selector, unreserved, withdrawAmount
                )
            );
        }
        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, withdrawAmount, provider);
        assertEq(_reserved(RELEASE), reserve);
        assertGe(usdc.balanceOf(address(registry)), reserve);
        _assertBalanceMatchesTotals();
    }

    /// Many sub-cent warranties add up to the atomic unit, whatever the split.
    function testFuzz_sixDecimals_manySmallWarrantiesSumExactly(uint256 seed, uint8 count) public {
        count = uint8(bound(count, 1, 20));
        _deposit(RELEASE, 100 * ONE_USDC);
        uint256 reservedSum;
        uint256 creditSum;
        for (uint256 i = 0; i < count; i++) {
            uint256 amount = bound(uint256(keccak256(abi.encode(seed, i))), 1, 999_999);
            _activate(_rid(i), amount);
            reservedSum += amount;
            if (i % 2 == 0) {
                _finalize(_rid(i), 2, 10_000);
                creditSum += amount;
            }
        }
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertEq(credits, creditSum);
        assertEq(reserved, reservedSum - creditSum);
        assertEq(available, 100 * ONE_USDC - reservedSum);
        _assertBalanceMatchesTotals();
    }

    /// The registry's voucher digest equals Foundry's independent EIP-712 struct encoding under
    /// the standard domain separator, for any field values.
    function testFuzz_hashVoucher_matchesFoundrysEncoder(Registry.Voucher memory v) public view {
        bytes32 structHash = vm.eip712HashStruct(
            "Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)",
            abi.encode(v)
        );
        assertEq(registry.hashVoucher(v), _typedDataDigest(structHash));
    }

    function testFuzz_hashOutcome_matchesFoundrysEncoder(Registry.Outcome memory o) public view {
        bytes32 structHash = vm.eip712HashStruct(
            "Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)",
            abi.encode(o)
        );
        assertEq(registry.hashOutcome(o), _typedDataDigest(structHash));
    }

    function _typedDataDigest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Lemma Warranty Registry"),
                keccak256("1"),
                block.chainid,
                address(registry)
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }
}
