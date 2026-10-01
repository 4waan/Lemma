// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ResolutionWarrantyRegistry as Registry} from "../src/ResolutionWarrantyRegistry.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";
import {MockUSDC, FeeOnTransferUSDC, BlocklistUSDC} from "./utils/MockUSDC.sol";
import {MockERC1271Signer} from "./utils/MockERC1271Signer.sol";

contract RegistryAdminTest is RegistryTestBase {
    function test_constructor_setsTokenOwnerAndDomain() public view {
        assertEq(address(registry.usdc()), address(usdc));
        assertEq(registry.owner(), owner);
        assertEq(registry.engine(), address(0));
        assertFalse(registry.paused());
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = registry.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "Lemma Warranty Registry");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(registry));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);
    }

    function test_constructor_revertsOnTokenWithoutCode() public {
        vm.expectRevert(Registry.InvalidToken.selector);
        new Registry(IERC20(address(0)), owner);
        vm.expectRevert(Registry.InvalidToken.selector);
        new Registry(IERC20(stranger), owner);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Registry(usdc, address(0));
    }

    function test_typeHashes_matchTheSpecStrings() public view {
        assertEq(
            registry.VOUCHER_TYPEHASH(),
            keccak256(
                "Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)"
            )
        );
        assertEq(
            registry.OUTCOME_TYPEHASH(),
            keccak256(
                "Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)"
            )
        );
    }

    function test_registerRelease_storesRolesAndEmits() public {
        bytes32 digest = keccak256("another release");
        vm.expectEmit(address(registry));
        emit Registry.ReleaseRegistered(digest, provider, evaluator, 3 days);
        vm.prank(owner);
        registry.registerRelease(digest, provider, evaluator, 3 days);

        Registry.Release memory r = registry.release(digest);
        assertEq(r.provider, provider);
        assertEq(r.evaluator, evaluator);
        assertEq(r.claimWindowSeconds, 3 days);
        assertTrue(r.active);
        assertEq(r.available, 0);
        assertEq(r.reserved, 0);
    }

    function test_registerRelease_onlyOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, provider)
        );
        vm.prank(provider);
        registry.registerRelease(keccak256("x"), provider, evaluator, 1 days);
    }

    function test_registerRelease_revertsOnBadInput() public {
        vm.startPrank(owner);
        vm.expectRevert(Registry.InvalidReleaseDigest.selector);
        registry.registerRelease(bytes32(0), provider, evaluator, 1 days);
        vm.expectRevert(Registry.InvalidRoles.selector);
        registry.registerRelease(keccak256("x"), address(0), evaluator, 1 days);
        vm.expectRevert(Registry.InvalidRoles.selector);
        registry.registerRelease(keccak256("x"), provider, address(0), 1 days);
        vm.expectRevert(Registry.InvalidRoles.selector);
        registry.registerRelease(keccak256("x"), provider, provider, 1 days);
        vm.expectRevert(Registry.InvalidClaimWindow.selector);
        registry.registerRelease(keccak256("x"), provider, evaluator, 0);
        vm.expectRevert(abi.encodeWithSelector(Registry.ReleaseAlreadyRegistered.selector, RELEASE));
        registry.registerRelease(RELEASE, stranger, evaluator, 1 days);
        vm.stopPrank();
    }

    function test_setEngine_onlyOwnerNeedsCodeAndZeroDisables() public {
        MockUSDC someContract = new MockUSDC();
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        registry.setEngine(address(someContract));

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(Registry.EngineHasNoCode.selector, stranger));
        registry.setEngine(stranger);

        vm.expectEmit(address(registry));
        emit Registry.EngineSet(address(0), address(someContract));
        registry.setEngine(address(someContract));
        assertEq(registry.engine(), address(someContract));

        registry.setEngine(address(0));
        assertEq(registry.engine(), address(0));
        vm.stopPrank();
    }

    function test_pause_onlyOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        registry.pause();

        vm.prank(owner);
        registry.pause();
        assertTrue(registry.paused());

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        registry.unpause();

        vm.prank(owner);
        registry.unpause();
        assertFalse(registry.paused());
    }

    function test_renounceOwnership_isDisabled() public {
        vm.expectRevert(Registry.RenounceOwnershipDisabled.selector);
        vm.prank(owner);
        registry.renounceOwnership();
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        registry.renounceOwnership();
        assertEq(registry.owner(), owner);
    }

    function test_ownership_transfersInTwoSteps() public {
        address next = makeAddr("nextOwner");
        vm.prank(owner);
        registry.transferOwnership(next);
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), next);

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        vm.prank(stranger);
        registry.acceptOwnership();

        vm.prank(next);
        registry.acceptOwnership();
        assertEq(registry.owner(), next);
    }
}

contract RegistryBondTest is RegistryTestBase {
    function test_depositBond_anyoneCanFundAnActiveRelease() public {
        address funder = makeAddr("funder");
        usdc.mint(funder, 5 * ONE_USDC);
        vm.startPrank(funder);
        usdc.approve(address(registry), 5 * ONE_USDC);
        vm.expectEmit(address(registry));
        emit Registry.BondDeposited(RELEASE, funder, 5 * ONE_USDC);
        registry.depositBond(RELEASE, 5 * ONE_USDC);
        vm.stopPrank();

        assertEq(_available(RELEASE), 5 * ONE_USDC);
        (uint256 available,,) = registry.totals();
        assertEq(available, 5 * ONE_USDC);
        _assertBalanceMatchesTotals();
    }

    function test_depositBond_reverts() public {
        vm.startPrank(provider);
        vm.expectRevert(Registry.ZeroAmount.selector);
        registry.depositBond(RELEASE, 0);
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(Registry.UnknownRelease.selector, unknown));
        registry.depositBond(unknown, ONE_USDC);
        registry.deactivateRelease(RELEASE);
        vm.expectRevert(abi.encodeWithSelector(Registry.ReleaseNotActive.selector, RELEASE));
        registry.depositBond(RELEASE, ONE_USDC);
        vm.stopPrank();
    }

    function test_depositBond_revertsWhilePaused() public {
        vm.prank(owner);
        registry.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _deposit(RELEASE, ONE_USDC);
    }

    function test_depositBond_failsClosedOnFeeOnTransfer() public {
        FeeOnTransferUSDC feeToken = new FeeOnTransferUSDC();
        Registry feeRegistry = new Registry(feeToken, owner);
        vm.prank(owner);
        feeRegistry.registerRelease(RELEASE, provider, evaluator, CLAIM_WINDOW);
        feeToken.mint(provider, 100 * ONE_USDC);
        vm.startPrank(provider);
        feeToken.approve(address(feeRegistry), type(uint256).max);
        feeRegistry.depositBond(RELEASE, 10 * ONE_USDC); // no fee yet
        feeToken.setFeeBps(10); // 0.1%
        vm.expectRevert(
            abi.encodeWithSelector(
                Registry.TransferAmountMismatch.selector, 10 * ONE_USDC, 9_990_000
            )
        );
        feeRegistry.depositBond(RELEASE, 10 * ONE_USDC);
        vm.stopPrank();
        assertEq(feeRegistry.release(RELEASE).available, 10 * ONE_USDC);
    }

    function test_withdrawUnreservedBond_paysTheProvidersRecipient() public {
        _deposit(RELEASE, 10 * ONE_USDC);
        address treasury = makeAddr("treasury");
        vm.expectEmit(address(registry));
        emit Registry.BondWithdrawn(RELEASE, treasury, 4 * ONE_USDC);
        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, 4 * ONE_USDC, treasury);
        assertEq(usdc.balanceOf(treasury), 4 * ONE_USDC);
        assertEq(_available(RELEASE), 6 * ONE_USDC);
        _assertBalanceMatchesTotals();
    }

    function test_withdrawUnreservedBond_reverts() public {
        _deposit(RELEASE, 10 * ONE_USDC);
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(Registry.UnknownRelease.selector, unknown));
        vm.prank(provider);
        registry.withdrawUnreservedBond(unknown, ONE_USDC, provider);

        vm.expectRevert(Registry.NotProvider.selector);
        vm.prank(owner);
        registry.withdrawUnreservedBond(RELEASE, ONE_USDC, owner);

        vm.startPrank(provider);
        vm.expectRevert(Registry.InvalidRecipient.selector);
        registry.withdrawUnreservedBond(RELEASE, ONE_USDC, address(0));
        vm.expectRevert(Registry.InvalidRecipient.selector);
        registry.withdrawUnreservedBond(RELEASE, ONE_USDC, address(registry));
        vm.expectRevert(Registry.ZeroAmount.selector);
        registry.withdrawUnreservedBond(RELEASE, 0, provider);
        vm.expectRevert(
            abi.encodeWithSelector(
                Registry.InsufficientAvailableBond.selector, 10 * ONE_USDC, 10 * ONE_USDC + 1
            )
        );
        registry.withdrawUnreservedBond(RELEASE, 10 * ONE_USDC + 1, provider);
        vm.stopPrank();
    }

    function test_reservedBond_isNotWithdrawable() public {
        _deposit(RELEASE, 10 * ONE_USDC);
        _activate(_rid(1), 3 * ONE_USDC);
        assertEq(_available(RELEASE), 7 * ONE_USDC);
        assertEq(_reserved(RELEASE), 3 * ONE_USDC);

        vm.expectRevert(
            abi.encodeWithSelector(
                Registry.InsufficientAvailableBond.selector, 7 * ONE_USDC, 10 * ONE_USDC
            )
        );
        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, 10 * ONE_USDC, provider);

        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, 7 * ONE_USDC, provider);
        assertEq(_available(RELEASE), 0);
        assertEq(_reserved(RELEASE), 3 * ONE_USDC);
        assertEq(usdc.balanceOf(address(registry)), 3 * ONE_USDC);
        _assertBalanceMatchesTotals();
    }

    function test_withdrawUnreservedBond_worksWhilePausedAndAfterDeactivation() public {
        _deposit(RELEASE, 10 * ONE_USDC);
        vm.prank(owner);
        registry.pause();
        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, ONE_USDC, provider);
        vm.prank(owner);
        registry.deactivateRelease(RELEASE);
        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, 9 * ONE_USDC, provider);
        assertEq(_available(RELEASE), 0);
    }

    function test_deactivateRelease_byOwnerOrProviderOnly() public {
        bytes32 second = keccak256("second");
        vm.prank(owner);
        registry.registerRelease(second, provider, evaluator, CLAIM_WINDOW);

        vm.expectRevert(Registry.NotOwnerOrProvider.selector);
        vm.prank(evaluator);
        registry.deactivateRelease(RELEASE);

        vm.expectEmit(address(registry));
        emit Registry.ReleaseDeactivated(RELEASE, owner);
        vm.prank(owner);
        registry.deactivateRelease(RELEASE);
        assertFalse(registry.release(RELEASE).active);

        vm.prank(provider);
        registry.deactivateRelease(second);
        assertFalse(registry.release(second).active);

        vm.expectRevert(abi.encodeWithSelector(Registry.ReleaseNotActive.selector, RELEASE));
        vm.prank(owner);
        registry.deactivateRelease(RELEASE);
        bytes32 unknown = keccak256("unknown");
        vm.expectRevert(abi.encodeWithSelector(Registry.UnknownRelease.selector, unknown));
        vm.prank(owner);
        registry.deactivateRelease(unknown);
    }

    function test_deactivatedRelease_keepsExistingWarranties() public {
        _deposit(RELEASE, 10 * ONE_USDC);
        _activate(_rid(1), 2 * ONE_USDC);
        _activate(_rid(2), 3 * ONE_USDC);
        _activate(_rid(3), ONE_USDC);

        vm.prank(provider);
        registry.deactivateRelease(RELEASE);

        // No new warranty.
        Registry.Voucher memory v = _voucher(_rid(4), ONE_USDC);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.expectRevert(abi.encodeWithSelector(Registry.ReleaseNotActive.selector, RELEASE));
        registry.activateResolution(v, sig);

        // Existing ones still reach every end state.
        _finalize(_rid(1), registry.VERDICT_FAILED(), 10_000);
        _finalize(_rid(2), registry.VERDICT_PASSED(), 10_000);
        vm.warp(block.timestamp + CLAIM_WINDOW + 1);
        registry.expireResolution(_rid(3));
        _withdrawCredit(_rid(1));

        assertEq(usdc.balanceOf(refundTo), 2 * ONE_USDC);
        assertEq(_available(RELEASE), 8 * ONE_USDC);
        assertEq(_reserved(RELEASE), 0);
        _assertBalanceMatchesTotals();
    }
}

contract RegistryActivationTest is RegistryTestBase {
    function setUp() public override {
        super.setUp();
        _deposit(RELEASE, 100 * ONE_USDC);
    }

    function test_activate_reservesBondAndOpensTheClaimWindow() public {
        Registry.Voucher memory v = _voucher(_rid(1), 250_000);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.expectEmit(address(registry));
        emit Registry.ResolutionActivated(
            v.resolutionId,
            RELEASE,
            PROFILE,
            250_000,
            v.paymentRef,
            uint64(block.timestamp + CLAIM_WINDOW)
        );
        vm.prank(relayer);
        registry.activateResolution(v, sig);

        Registry.Resolution memory res = registry.resolution(v.resolutionId);
        assertEq(uint8(res.status), uint8(Registry.Status.Active));
        assertEq(res.releaseDigest, RELEASE);
        assertEq(res.claimHash, v.claimHash);
        assertEq(res.amount, 250_000);
        assertEq(res.profileIndex, PROFILE);
        assertEq(res.claimDeadline, block.timestamp + CLAIM_WINDOW);
        assertTrue(registry.paymentRefUsed(v.paymentRef));
        assertEq(_available(RELEASE), 100 * ONE_USDC - 250_000);
        assertEq(_reserved(RELEASE), 250_000);
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertEq(available, 100 * ONE_USDC - 250_000);
        assertEq(reserved, 250_000);
        assertEq(credits, 0);
        _assertBalanceMatchesTotals();
    }

    function test_activate_acceptsTheVoucherUntilActivateBy() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.warp(v.activateBy);
        registry.activateResolution(v, sig);
        assertEq(uint8(_status(v.resolutionId)), uint8(Registry.Status.Active));
    }

    function test_activate_revertsOnExpiredVoucher() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.warp(uint256(v.activateBy) + 1);
        vm.expectRevert(abi.encodeWithSelector(Registry.VoucherExpired.selector, v.activateBy));
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnZeroAmount() public {
        Registry.Voucher memory v = _voucher(_rid(1), 0);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.expectRevert(Registry.ZeroAmount.selector);
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnZeroIdentifiers() public {
        Registry.Voucher memory v = _voucher(bytes32(0), ONE_USDC);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.expectRevert(Registry.InvalidVoucher.selector);
        registry.activateResolution(v, sig);

        v = _voucher(_rid(1), ONE_USDC);
        v.paymentRef = bytes32(0);
        sig = _signVoucher(providerKey, v);
        vm.expectRevert(Registry.InvalidVoucher.selector);
        registry.activateResolution(v, sig);

        v = _voucher(_rid(1), ONE_USDC);
        v.claimHash = bytes32(0);
        sig = _signVoucher(providerKey, v);
        vm.expectRevert(Registry.InvalidVoucher.selector);
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnUnknownRelease() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        v.releaseDigest = keccak256("unknown");
        bytes memory sig = _signVoucher(providerKey, v);
        vm.expectRevert(abi.encodeWithSelector(Registry.UnknownRelease.selector, v.releaseDigest));
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnReplayedResolutionId() public {
        Registry.Voucher memory v = _activate(_rid(1), ONE_USDC);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.expectRevert(
            abi.encodeWithSelector(Registry.ResolutionAlreadyExists.selector, v.resolutionId)
        );
        registry.activateResolution(v, sig);

        // A fresh payment reference does not help: the resolution id is spent.
        v.paymentRef = keccak256("another payment");
        sig = _signVoucher(providerKey, v);
        vm.expectRevert(
            abi.encodeWithSelector(Registry.ResolutionAlreadyExists.selector, v.resolutionId)
        );
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnReplayedPaymentRef() public {
        Registry.Voucher memory first = _activate(_rid(1), ONE_USDC);
        Registry.Voucher memory v = _voucher(_rid(2), ONE_USDC);
        v.paymentRef = first.paymentRef;
        bytes memory sig = _signVoucher(providerKey, v);
        vm.expectRevert(
            abi.encodeWithSelector(Registry.PaymentRefAlreadyUsed.selector, first.paymentRef)
        );
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnWrongSigner() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        (, uint256 strangerKey) = makeAddrAndKey("voucherForger");
        bytes memory sig = _signVoucher(strangerKey, v);
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, sig);

        // The evaluator is not the provider either.
        sig = _signVoucher(evaluatorKey, v);
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnTamperedVoucher() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        bytes memory sig = _signVoucher(providerKey, v);
        v.amount = 2 * ONE_USDC;
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, sig);
        v.amount = ONE_USDC;
        v.claimHash = _claimHash(v.resolutionId, _claimSecret(v.resolutionId), relayer);
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnMalformedSignature() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, "");
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, new bytes(65));
    }

    function test_activate_revertsOnASignatureForAnotherRegistry() public {
        Registry other = new Registry(usdc, owner);
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        bytes memory sig = _sign(providerKey, other.hashVoucher(v));
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnASignatureForAnotherChain() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        uint256 chainId = block.chainid;
        vm.chainId(421614);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.chainId(chainId);
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsOnInsufficientBond() public {
        Registry.Voucher memory v = _voucher(_rid(1), 100 * ONE_USDC + 1);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.expectRevert(
            abi.encodeWithSelector(
                Registry.InsufficientAvailableBond.selector, 100 * ONE_USDC, 100 * ONE_USDC + 1
            )
        );
        registry.activateResolution(v, sig);
    }

    function test_activate_revertsWhilePaused() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.prank(owner);
        registry.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.activateResolution(v, sig);
    }

    function test_activate_acceptsAnERC1271Provider() public {
        (address signerKey, uint256 signerPk) = makeAddrAndKey("smartAccountKey");
        MockERC1271Signer account = new MockERC1271Signer(signerKey);
        bytes32 digest = keccak256("smart-account release");
        vm.prank(owner);
        registry.registerRelease(digest, address(account), evaluator, CLAIM_WINDOW);
        usdc.mint(address(account), 10 * ONE_USDC);
        vm.startPrank(address(account));
        usdc.approve(address(registry), 10 * ONE_USDC);
        registry.depositBond(digest, 10 * ONE_USDC);
        vm.stopPrank();

        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        v.releaseDigest = digest;
        bytes memory sig = _signVoucher(signerPk, v);

        account.setEnabled(false);
        vm.expectRevert(Registry.InvalidProviderSignature.selector);
        registry.activateResolution(v, sig);

        account.setEnabled(true);
        registry.activateResolution(v, sig);
        assertEq(uint8(_status(v.resolutionId)), uint8(Registry.Status.Active));
    }

    /// The privacy rule: activation writes hashes and amounts, never the submitter's or the
    /// refund recipient's address.
    function test_activate_storesNoAddress() public {
        Registry.Voucher memory v = _voucher(_rid(1), ONE_USDC);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.record();
        vm.prank(relayer);
        registry.activateResolution(v, sig);
        (, bytes32[] memory writes) = vm.accesses(address(registry));
        assertGt(writes.length, 0);
        for (uint256 i = 0; i < writes.length; i++) {
            bytes32 word = vm.load(address(registry), writes[i]);
            assertTrue(word != bytes32(uint256(uint160(relayer))), "relayer stored");
            assertTrue(word != bytes32(uint256(uint160(refundTo))), "refund address stored");
            assertTrue(uint160(uint256(word)) != uint160(relayer), "relayer packed");
            assertTrue(uint160(uint256(word)) != uint160(refundTo), "refund packed");
        }
    }
}

contract RegistryFinalizationTest is RegistryTestBase {
    bytes32 internal rid;

    function setUp() public override {
        super.setUp();
        _deposit(RELEASE, 100 * ONE_USDC);
        rid = _rid(1);
        _activate(rid, 5 * ONE_USDC);
    }

    function test_finalize_passedReleasesTheBond() public {
        Registry.Outcome memory o = _outcome(rid, 1, 10_000);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.expectEmit(address(registry));
        emit Registry.OutcomeFinalized(rid, RELEASE, 1, 10_000, o.evidenceHash);
        vm.prank(relayer);
        registry.finalizeOutcome(o, sig);

        assertEq(uint8(_status(rid)), uint8(Registry.Status.Passed));
        assertEq(_available(RELEASE), 100 * ONE_USDC);
        assertEq(_reserved(RELEASE), 0);
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertEq(available, 100 * ONE_USDC);
        assertEq(reserved, 0);
        assertEq(credits, 0);
        _assertBalanceMatchesTotals();
    }

    function test_finalize_failedCreatesACredit() public {
        _finalize(rid, 2, 10_000);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Failed));
        assertEq(_available(RELEASE), 95 * ONE_USDC);
        assertEq(_reserved(RELEASE), 0);
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertEq(available, 95 * ONE_USDC);
        assertEq(reserved, 0);
        assertEq(credits, 5 * ONE_USDC);
        _assertBalanceMatchesTotals();
    }

    function test_finalize_voidReleasesTheBond() public {
        _finalize(rid, 3, 10_000);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Voided));
        assertEq(_available(RELEASE), 100 * ONE_USDC);
        _assertBalanceMatchesTotals();
    }

    function test_finalize_acceptsAtTheClaimDeadline() public {
        vm.warp(registry.resolution(rid).claimDeadline);
        _finalize(rid, 1, 10_000);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Passed));
    }

    function test_finalize_revertsOnUnknownOrFinishedResolution() public {
        bytes32 unknown = _rid(99);
        Registry.Outcome memory o = _outcome(unknown, 1, 10_000);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.expectRevert(abi.encodeWithSelector(Registry.ResolutionNotActive.selector, unknown));
        registry.finalizeOutcome(o, sig);

        _finalize(rid, 1, 10_000);
        o = _outcome(rid, 2, 10_000);
        sig = _signOutcome(evaluatorKey, o);
        vm.expectRevert(abi.encodeWithSelector(Registry.ResolutionNotActive.selector, rid));
        registry.finalizeOutcome(o, sig);
    }

    function test_finalize_revertsOnInvalidVerdict() public {
        for (uint8 verdict = 0; verdict < 6; verdict += 4) {
            Registry.Outcome memory o = _outcome(rid, verdict, 10_000);
            bytes memory sig = _signOutcome(evaluatorKey, o);
            vm.expectRevert(abi.encodeWithSelector(Registry.InvalidVerdict.selector, verdict));
            registry.finalizeOutcome(o, sig);
        }
    }

    function test_finalize_revertsOnWeightAboveOneHundredPercent() public {
        Registry.Outcome memory o = _outcome(rid, 1, 10_001);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.expectRevert(abi.encodeWithSelector(Registry.InvalidWeight.selector, 10_001));
        registry.finalizeOutcome(o, sig);
    }

    function test_finalize_revertsOnExpiredOutcome() public {
        Registry.Outcome memory o = _outcome(rid, 1, 10_000);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.warp(uint256(o.validUntil) + 1);
        vm.expectRevert(abi.encodeWithSelector(Registry.OutcomeExpired.selector, o.validUntil));
        registry.finalizeOutcome(o, sig);
    }

    function test_finalize_revertsAfterTheClaimWindow() public {
        uint64 deadline = registry.resolution(rid).claimDeadline;
        vm.warp(uint256(deadline) + 1);
        Registry.Outcome memory o = _outcome(rid, 2, 10_000);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowClosed.selector, deadline));
        registry.finalizeOutcome(o, sig);
    }

    function test_finalize_revertsOnWrongEvaluator() public {
        Registry.Outcome memory o = _outcome(rid, 2, 10_000);
        bytes memory sig = _signOutcome(providerKey, o);
        vm.expectRevert(Registry.InvalidEvaluatorSignature.selector);
        registry.finalizeOutcome(o, sig);

        // Another release's evaluator cannot finalize this release's resolution.
        (address otherEvaluator, uint256 otherEvaluatorKey) = makeAddrAndKey("otherEvaluator");
        vm.prank(owner);
        registry.registerRelease(keccak256("other"), provider, otherEvaluator, CLAIM_WINDOW);
        sig = _signOutcome(otherEvaluatorKey, o);
        vm.expectRevert(Registry.InvalidEvaluatorSignature.selector);
        registry.finalizeOutcome(o, sig);
    }

    function test_finalize_revertsOnTamperedOutcome() public {
        Registry.Outcome memory o = _outcome(rid, 1, 10_000);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        o.verdict = 2;
        vm.expectRevert(Registry.InvalidEvaluatorSignature.selector);
        registry.finalizeOutcome(o, sig);
    }

    function test_finalize_revertsWhilePaused() public {
        Registry.Outcome memory o = _outcome(rid, 2, 10_000);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.prank(owner);
        registry.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.finalizeOutcome(o, sig);
    }

    function test_finalize_acceptsAnERC1271Evaluator() public {
        (address signerKey, uint256 signerPk) = makeAddrAndKey("evaluatorAccountKey");
        MockERC1271Signer account = new MockERC1271Signer(signerKey);
        bytes32 digest = keccak256("smart-account evaluator");
        vm.prank(owner);
        registry.registerRelease(digest, provider, address(account), CLAIM_WINDOW);
        _deposit(digest, ONE_USDC);
        Registry.Voucher memory v = _voucher(_rid(2), ONE_USDC);
        v.releaseDigest = digest;
        registry.activateResolution(v, _signVoucher(providerKey, v));

        Registry.Outcome memory o = _outcome(v.resolutionId, 2, 5_000);
        bytes memory sig = _signOutcome(signerPk, o);
        account.setEnabled(false);
        vm.expectRevert(Registry.InvalidEvaluatorSignature.selector);
        registry.finalizeOutcome(o, sig);
        account.setEnabled(true);
        registry.finalizeOutcome(o, sig);
        assertEq(uint8(_status(v.resolutionId)), uint8(Registry.Status.Failed));
    }
}

contract RegistryExpiryTest is RegistryTestBase {
    bytes32 internal rid;

    function setUp() public override {
        super.setUp();
        _deposit(RELEASE, 10 * ONE_USDC);
        rid = _rid(1);
        _activate(rid, 4 * ONE_USDC);
    }

    function test_expire_revertsWhileTheWindowIsOpen() public {
        uint64 deadline = registry.resolution(rid).claimDeadline;
        vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowOpen.selector, deadline));
        registry.expireResolution(rid);
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(Registry.ClaimWindowOpen.selector, deadline));
        registry.expireResolution(rid);
    }

    function test_expire_releasesTheBondForAnyone() public {
        vm.warp(uint256(registry.resolution(rid).claimDeadline) + 1);
        vm.expectEmit(address(registry));
        emit Registry.ResolutionExpired(rid, RELEASE, 4 * ONE_USDC);
        vm.prank(stranger);
        registry.expireResolution(rid);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Expired));
        assertEq(_available(RELEASE), 10 * ONE_USDC);
        assertEq(_reserved(RELEASE), 0);
        _assertBalanceMatchesTotals();
    }

    /// Expiry is paused with finalization (test/RegistryPause.t.sol has the claim clock).
    function test_expire_revertsWhilePaused() public {
        vm.warp(uint256(registry.resolution(rid).claimDeadline) + 1);
        vm.prank(owner);
        registry.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(stranger);
        registry.expireResolution(rid);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Active));
    }

    function test_expire_revertsOnUnknownOrFinishedResolution() public {
        vm.warp(uint256(registry.resolution(rid).claimDeadline) + 1);
        registry.expireResolution(rid);
        vm.expectRevert(abi.encodeWithSelector(Registry.ResolutionNotActive.selector, rid));
        registry.expireResolution(rid);
        bytes32 unknown = _rid(99);
        vm.expectRevert(abi.encodeWithSelector(Registry.ResolutionNotActive.selector, unknown));
        registry.expireResolution(unknown);
    }

    function test_expiredResolution_cannotBeFinalized() public {
        vm.warp(uint256(registry.resolution(rid).claimDeadline) + 1);
        registry.expireResolution(rid);
        Registry.Outcome memory o = _outcome(rid, 2, 10_000);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.expectRevert(abi.encodeWithSelector(Registry.ResolutionNotActive.selector, rid));
        registry.finalizeOutcome(o, sig);
    }
}

contract RegistryCreditTest is RegistryTestBase {
    bytes32 internal rid;

    function setUp() public override {
        super.setUp();
        _deposit(RELEASE, 10 * ONE_USDC);
        rid = _rid(1);
        _activate(rid, 3 * ONE_USDC);
    }

    function test_withdrawCredit_paysTheCommittedRecipientOnce() public {
        _finalize(rid, 2, 10_000);
        bytes32 claimSecret = _claimSecret(rid);
        vm.expectEmit(address(registry));
        emit Registry.CreditWithdrawn(rid, 3 * ONE_USDC);
        vm.prank(relayer);
        registry.withdrawCredit(rid, claimSecret, refundTo);
        assertEq(usdc.balanceOf(refundTo), 3 * ONE_USDC);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(uint8(_status(rid)), uint8(Registry.Status.Refunded));
        (,, uint256 credits) = registry.totals();
        assertEq(credits, 0);
        _assertBalanceMatchesTotals();

        vm.expectRevert(abi.encodeWithSelector(Registry.NoCredit.selector, rid));
        registry.withdrawCredit(rid, claimSecret, refundTo);
    }

    function test_withdrawCredit_worksWhilePaused() public {
        _finalize(rid, 2, 10_000);
        vm.prank(owner);
        registry.pause();
        _withdrawCredit(rid);
        assertEq(usdc.balanceOf(refundTo), 3 * ONE_USDC);
    }

    function test_withdrawCredit_revertsWithoutACredit() public {
        vm.expectRevert(abi.encodeWithSelector(Registry.NoCredit.selector, rid));
        _withdrawCredit(rid); // still active

        _finalize(rid, 1, 10_000);
        vm.expectRevert(abi.encodeWithSelector(Registry.NoCredit.selector, rid));
        _withdrawCredit(rid); // passed

        bytes32 unknown = _rid(99);
        vm.expectRevert(abi.encodeWithSelector(Registry.NoCredit.selector, unknown));
        registry.withdrawCredit(unknown, bytes32(0), refundTo);
    }

    function test_withdrawCredit_revertsOnAWrongSecretOrRecipient() public {
        _finalize(rid, 2, 10_000);
        bytes32 claimSecret = _claimSecret(rid);
        vm.expectRevert(Registry.InvalidClaim.selector);
        registry.withdrawCredit(rid, keccak256("guess"), refundTo);
        // A relayer that knows the secret still cannot redirect the money.
        vm.expectRevert(Registry.InvalidClaim.selector);
        registry.withdrawCredit(rid, claimSecret, relayer);
        vm.expectRevert(Registry.InvalidRecipient.selector);
        registry.withdrawCredit(rid, claimSecret, address(0));
        vm.expectRevert(Registry.InvalidRecipient.selector);
        registry.withdrawCredit(rid, claimSecret, address(registry));
    }

    /// Circle can block an address. A blocked committed recipient cannot be paid, and the claim
    /// cannot be redirected: the credit waits until the block is lifted (documented limit).
    function test_withdrawCredit_toABlockedRecipientRevertsAndKeepsTheCredit() public {
        BlocklistUSDC token = new BlocklistUSDC();
        Registry reg = new Registry(token, owner);
        vm.prank(owner);
        reg.registerRelease(RELEASE, provider, evaluator, CLAIM_WINDOW);
        token.mint(provider, 10 * ONE_USDC);
        vm.startPrank(provider);
        token.approve(address(reg), type(uint256).max);
        reg.depositBond(RELEASE, 10 * ONE_USDC);
        vm.stopPrank();

        Registry.Voucher memory v = _voucher(rid, 2 * ONE_USDC);
        reg.activateResolution(v, _sign(providerKey, reg.hashVoucher(v)));
        Registry.Outcome memory o = _outcome(rid, 2, 10_000);
        reg.finalizeOutcome(o, _sign(evaluatorKey, reg.hashOutcome(o)));

        token.setBlocked(refundTo, true);
        vm.expectRevert(abi.encodeWithSelector(BlocklistUSDC.Blocked.selector, refundTo));
        reg.withdrawCredit(rid, _claimSecret(rid), refundTo);
        assertEq(uint8(reg.resolution(rid).status), uint8(Registry.Status.Failed));

        token.setBlocked(refundTo, false);
        reg.withdrawCredit(rid, _claimSecret(rid), refundTo);
        assertEq(token.balanceOf(refundTo), 2 * ONE_USDC);
    }
}

/// Six-decimal accounting: sub-cent warranties add and subtract to the atomic unit.
contract RegistrySixDecimalTest is RegistryTestBase {
    function test_sixDecimalAccounting_isExactToTheAtomicUnit() public {
        assertEq(usdc.decimals(), 6);
        _deposit(RELEASE, 12_345_678); // 12.345678 USDC

        _activate(_rid(1), 1); // 0.000001 USDC
        _activate(_rid(2), 250_000); // 0.25 USDC
        _activate(_rid(3), 1_999_999); // 1.999999 USDC
        _activate(_rid(4), 10_000); // 0.01 USDC

        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertEq(available, 12_345_678 - 1 - 250_000 - 1_999_999 - 10_000);
        assertEq(reserved, 2_260_000);
        assertEq(credits, 0);

        _finalize(_rid(1), 2, 10_000); // 0.000001 credit
        _finalize(_rid(2), 1, 10_000); // released
        _finalize(_rid(3), 2, 2_500); // 1.999999 credit
        vm.warp(block.timestamp + CLAIM_WINDOW + 1);
        registry.expireResolution(_rid(4));

        (available, reserved, credits) = registry.totals();
        assertEq(credits, 2_000_000);
        assertEq(reserved, 0);
        assertEq(available, 12_345_678 - 2_000_000);
        _assertBalanceMatchesTotals();

        _withdrawCredit(_rid(1));
        _withdrawCredit(_rid(3));
        assertEq(usdc.balanceOf(refundTo), 2_000_000);

        vm.prank(provider);
        registry.withdrawUnreservedBond(RELEASE, 10_345_678, provider);
        (available, reserved, credits) = registry.totals();
        assertEq(available + reserved + credits, 0);
        assertEq(usdc.balanceOf(address(registry)), 0);
    }
}

/// Every warranty transition emits its event, in order, so an indexer can rebuild the state.
contract RegistryEventsTest is RegistryTestBase {
    function test_everyTransitionEmits() public {
        _deposit(RELEASE, 10 * ONE_USDC);
        vm.recordLogs();
        _activate(_rid(1), ONE_USDC);
        _finalize(_rid(1), 2, 10_000);
        _withdrawCredit(_rid(1));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // activation, finalization, credit withdrawal, then the token's Transfer
        assertEq(logs.length, 4);
        assertEq(logs[0].topics[0], Registry.ResolutionActivated.selector);
        assertEq(logs[1].topics[0], Registry.OutcomeFinalized.selector);
        assertEq(logs[2].topics[0], Registry.CreditWithdrawn.selector);
        assertEq(logs[3].emitter, address(usdc));
    }
}
