// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice A smart-account signer (ERC-1271) that accepts its owner key's ECDSA signatures while
/// enabled. Disabling it models a revoked or rotated contract signer.
contract MockERC1271Signer is IERC1271 {
    address public immutable signerKey;
    bool public enabled = true;

    constructor(address signerKey_) {
        signerKey = signerKey_;
    }

    function setEnabled(bool isEnabled) external {
        enabled = isEnabled;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (enabled && err == ECDSA.RecoverError.NoError && recovered == signerKey) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}
