// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {ResolutionWarrantyRegistry} from "../../src/ResolutionWarrantyRegistry.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Shared setup: a six-decimal USDC, a registry, one registered release with a provider
/// and an evaluator whose keys are derived from labels at run time (no key literal anywhere).
abstract contract RegistryTestBase is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint32 internal constant CLAIM_WINDOW = 7 days;
    uint8 internal constant PROFILE = 2;
    uint256 internal constant START = 1_790_000_000;

    bytes32 internal constant RELEASE = keccak256("lemma.test.release.v1");

    MockUSDC internal usdc;
    ResolutionWarrantyRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal refundTo = makeAddr("refundTo");
    address internal stranger = makeAddr("stranger");
    address internal provider;
    uint256 internal providerKey;
    address internal evaluator;
    uint256 internal evaluatorKey;

    function setUp() public virtual {
        vm.warp(START);
        (provider, providerKey) = makeAddrAndKey("provider");
        (evaluator, evaluatorKey) = makeAddrAndKey("evaluator");
        usdc = new MockUSDC();
        registry = new ResolutionWarrantyRegistry(usdc, owner);

        vm.prank(owner);
        registry.registerRelease(RELEASE, provider, evaluator, CLAIM_WINDOW);

        usdc.mint(provider, 1_000_000 * ONE_USDC);
        vm.prank(provider);
        usdc.approve(address(registry), type(uint256).max);
    }

    // ---- Accounting helpers

    function _deposit(bytes32 releaseDigest, uint256 amount) internal {
        vm.prank(provider);
        registry.depositBond(releaseDigest, amount);
    }

    function _available(bytes32 releaseDigest) internal view returns (uint256) {
        return registry.release(releaseDigest).available;
    }

    function _reserved(bytes32 releaseDigest) internal view returns (uint256) {
        return registry.release(releaseDigest).reserved;
    }

    function _status(bytes32 resolutionId)
        internal
        view
        returns (ResolutionWarrantyRegistry.Status)
    {
        return registry.resolution(resolutionId).status;
    }

    /// Asserts balance == totals (no donations in unit tests) and returns the totals.
    function _assertBalanceMatchesTotals() internal view {
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        assertEq(usdc.balanceOf(address(registry)), available + reserved + credits, "balance");
    }

    // ---- Claim commitments

    function _rid(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("lemma.test.resolution", n));
    }

    function _claimSecret(bytes32 resolutionId) internal pure returns (bytes32) {
        return keccak256(abi.encode("lemma.test.claim", resolutionId));
    }

    function _claimHash(bytes32 resolutionId, bytes32 claimSecret, address to)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(resolutionId, claimSecret, to));
    }

    // ---- Vouchers and outcomes

    function _voucher(bytes32 resolutionId, uint256 amount)
        internal
        view
        returns (ResolutionWarrantyRegistry.Voucher memory)
    {
        return ResolutionWarrantyRegistry.Voucher({
            resolutionId: resolutionId,
            releaseDigest: RELEASE,
            profileIndex: PROFILE,
            amount: amount,
            paymentRef: keccak256(abi.encode("lemma.test.paymentRef", resolutionId)),
            claimHash: _claimHash(resolutionId, _claimSecret(resolutionId), refundTo),
            activateBy: uint64(block.timestamp + 1 hours)
        });
    }

    function _outcome(bytes32 resolutionId, uint8 verdict, uint16 weightBps)
        internal
        view
        returns (ResolutionWarrantyRegistry.Outcome memory)
    {
        return ResolutionWarrantyRegistry.Outcome({
            resolutionId: resolutionId,
            verdict: verdict,
            weightBps: weightBps,
            evidenceHash: keccak256(abi.encode("lemma.test.evidence", resolutionId)),
            validUntil: uint64(block.timestamp + 1 hours)
        });
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signVoucher(uint256 key, ResolutionWarrantyRegistry.Voucher memory v)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, registry.hashVoucher(v));
    }

    function _signOutcome(uint256 key, ResolutionWarrantyRegistry.Outcome memory o)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, registry.hashOutcome(o));
    }

    /// Activates `resolutionId` for `amount` through the relayer with the provider's signature.
    function _activate(bytes32 resolutionId, uint256 amount)
        internal
        returns (ResolutionWarrantyRegistry.Voucher memory v)
    {
        v = _voucher(resolutionId, amount);
        bytes memory sig = _signVoucher(providerKey, v);
        vm.prank(relayer);
        registry.activateResolution(v, sig);
    }

    /// Finalizes with the evaluator's signature through the relayer.
    function _finalize(bytes32 resolutionId, uint8 verdict, uint16 weightBps)
        internal
        returns (ResolutionWarrantyRegistry.Outcome memory o)
    {
        o = _outcome(resolutionId, verdict, weightBps);
        bytes memory sig = _signOutcome(evaluatorKey, o);
        vm.prank(relayer);
        registry.finalizeOutcome(o, sig);
    }

    function _withdrawCredit(bytes32 resolutionId) internal {
        vm.prank(relayer);
        registry.withdrawCredit(resolutionId, _claimSecret(resolutionId), refundTo);
    }
}
