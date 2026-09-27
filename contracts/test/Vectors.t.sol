// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ResolutionWarrantyRegistry as Registry} from "../src/ResolutionWarrantyRegistry.sol";
import {RegistryTestBase} from "./utils/RegistryTestBase.sol";

/// Fixed cross-language vectors. The TypeScript side (packages/core, viem) asserts the same
/// literals, so a change on either side fails a test.
contract VectorsTest is RegistryTestBase {
    /// keccak256(abi.encode(bytes32 0x11..11, bytes32 0x22..22, address 0x33..33)).
    /// Computed with `cast keccak $(cast abi-encode "f(bytes32,bytes32,address)" ...)` and with
    /// viem `keccak256(encodeAbiParameters(...))`; core `warrantyClaimHash` asserts it too.
    bytes32 internal constant CLAIM_HASH_VECTOR =
        0xefe737cca6b5574d334f88508fb3149002c12c771f7bdeec10267e5cf8fa21eb;

    /// viem `hashTypedData` for the fixed voucher and outcome below, under the domain
    /// { name: "Lemma Warranty Registry", version: "1", chainId: 421614, verifyingContract: VECTOR_REGISTRY }.
    bytes32 internal constant VOUCHER_DIGEST_VECTOR =
        0x2770a4591ffeb5922cf0d77e5f159ea23e24297c9164f970a1cf74d85a1a2473;
    bytes32 internal constant OUTCOME_DIGEST_VECTOR =
        0xc4f2af8ca4c3b7a3a512cf4621f3ebf6de602412ed19545450663cf604c8b590;
    address internal constant VECTOR_REGISTRY = 0x4c454D4D41000000000000000000000000000001;
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;

    /// A word of 32 repeated bytes, built at run time so no 64-hex literal sits next to "secret".
    function _repeat(uint8 b) internal pure returns (bytes32) {
        return bytes32(uint256(type(uint256).max / 0xff) * b);
    }

    function _vectorResolutionId() internal pure returns (bytes32) {
        return _repeat(0x11);
    }

    function _vectorClaimSecret() internal pure returns (bytes32) {
        return _repeat(0x22);
    }

    function _vectorRefundTo() internal pure returns (address) {
        return address(uint160(type(uint160).max / 0xff) * 0x33);
    }

    function test_vectorInputs_areTheSpecifiedBytes() public pure {
        assertEq(
            _vectorResolutionId(),
            hex"1111111111111111111111111111111111111111111111111111111111111111"
        );
        assertEq(_vectorRefundTo(), 0x3333333333333333333333333333333333333333);
        assertEq(uint256(_vectorClaimSecret()) / (type(uint256).max / 0xff), 0x22);
    }

    function test_claimHash_fixedVector() public pure {
        assertEq(
            keccak256(abi.encode(_vectorResolutionId(), _vectorClaimSecret(), _vectorRefundTo())),
            CLAIM_HASH_VECTOR
        );
    }

    /// The registry pays exactly the vector's (secret, recipient) and nothing else.
    function test_claimHash_vectorUnlocksTheCredit() public {
        _deposit(RELEASE, 10 * ONE_USDC);
        Registry.Voucher memory v = _voucher(_vectorResolutionId(), 2 * ONE_USDC);
        v.claimHash = CLAIM_HASH_VECTOR;
        registry.activateResolution(v, _signVoucher(providerKey, v));
        Registry.Outcome memory o = _outcome(v.resolutionId, 2, 10_000);
        registry.finalizeOutcome(o, _signOutcome(evaluatorKey, o));

        vm.expectRevert(Registry.InvalidClaim.selector);
        registry.withdrawCredit(v.resolutionId, _repeat(0x23), _vectorRefundTo());
        registry.withdrawCredit(v.resolutionId, _vectorClaimSecret(), _vectorRefundTo());
        assertEq(usdc.balanceOf(_vectorRefundTo()), 2 * ONE_USDC);
    }

    function _vectorVoucher() internal pure returns (Registry.Voucher memory) {
        return Registry.Voucher({
            resolutionId: _repeat(0x11),
            releaseDigest: _repeat(0x44),
            profileIndex: 2,
            amount: 250_000,
            paymentRef: _repeat(0x55),
            claimHash: CLAIM_HASH_VECTOR,
            activateBy: 1_790_000_000
        });
    }

    function _vectorOutcome() internal pure returns (Registry.Outcome memory) {
        return Registry.Outcome({
            resolutionId: _repeat(0x11),
            verdict: 2,
            weightBps: 10_000,
            evidenceHash: _repeat(0x66),
            validUntil: 1_790_003_600
        });
    }

    function test_eip712_digestsMatchTheViemVectors() public {
        vm.chainId(ARBITRUM_SEPOLIA);
        deployCodeTo(
            "ResolutionWarrantyRegistry.sol:ResolutionWarrantyRegistry",
            abi.encode(address(usdc), owner),
            VECTOR_REGISTRY
        );
        Registry fixedRegistry = Registry(VECTOR_REGISTRY);
        assertEq(fixedRegistry.hashVoucher(_vectorVoucher()), VOUCHER_DIGEST_VECTOR);
        assertEq(fixedRegistry.hashOutcome(_vectorOutcome()), OUTCOME_DIGEST_VECTOR);
    }

    /// Foundry's own EIP-712 encoder (independent of OpenZeppelin) agrees on type hashes and
    /// digests for this deployment.
    function test_eip712_matchesFoundrysEncoder() public view {
        assertEq(
            vm.eip712HashType(
                "Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)"
            ),
            registry.VOUCHER_TYPEHASH()
        );
        assertEq(
            vm.eip712HashType(
                "Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)"
            ),
            registry.OUTCOME_TYPEHASH()
        );
        assertEq(registry.hashVoucher(_vectorVoucher()), vm.eip712HashTypedData(_voucherJson()));
        assertEq(registry.hashOutcome(_vectorOutcome()), vm.eip712HashTypedData(_outcomeJson()));
    }

    function _domainJson() internal view returns (string memory) {
        return string.concat(
            '"domain":{"name":"Lemma Warranty Registry","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(address(registry)),
            '"}'
        );
    }

    string internal constant DOMAIN_TYPE =
        '"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}]';

    function _voucherJson() internal view returns (string memory) {
        Registry.Voucher memory v = _vectorVoucher();
        return string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"Voucher":[{"name":"resolutionId","type":"bytes32"},{"name":"releaseDigest","type":"bytes32"},{"name":"profileIndex","type":"uint8"},{"name":"amount","type":"uint256"},{"name":"paymentRef","type":"bytes32"},{"name":"claimHash","type":"bytes32"},{"name":"activateBy","type":"uint64"}]},"primaryType":"Voucher",',
            _domainJson(),
            ',"message":{"resolutionId":"',
            vm.toString(v.resolutionId),
            '","releaseDigest":"',
            vm.toString(v.releaseDigest),
            '","profileIndex":2,"amount":"250000","paymentRef":"',
            vm.toString(v.paymentRef),
            '","claimHash":"',
            vm.toString(v.claimHash),
            '","activateBy":"1790000000"}}'
        );
    }

    function _outcomeJson() internal view returns (string memory) {
        Registry.Outcome memory o = _vectorOutcome();
        return string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"Outcome":[{"name":"resolutionId","type":"bytes32"},{"name":"verdict","type":"uint8"},{"name":"weightBps","type":"uint16"},{"name":"evidenceHash","type":"bytes32"},{"name":"validUntil","type":"uint64"}]},"primaryType":"Outcome",',
            _domainJson(),
            ',"message":{"resolutionId":"',
            vm.toString(o.resolutionId),
            '","verdict":2,"weightBps":10000,"evidenceHash":"',
            vm.toString(o.evidenceHash),
            '","validUntil":"1790003600"}}'
        );
    }
}
