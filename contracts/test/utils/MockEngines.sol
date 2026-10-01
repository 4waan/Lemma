// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ICompatibilityEngine} from "../../src/interfaces/ICompatibilityEngine.sol";

/// @notice Records every call and the gas it was given.
contract RecordingEngine is ICompatibilityEngine {
    struct Call {
        bytes32 releaseDigest;
        uint8 profileIndex;
        bool passed;
        uint16 weightBps;
        uint256 gasAtEntry;
        address caller;
    }

    Call[] internal _calls;

    function record(bytes32 releaseDigest, uint8 profileIndex, bool passed, uint16 weightBps)
        external
    {
        _calls.push(Call(releaseDigest, profileIndex, passed, weightBps, gasleft(), msg.sender));
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 i) external view returns (Call memory) {
        return _calls[i];
    }
}

/// @notice Always reverts with a reason.
contract RevertingEngine is ICompatibilityEngine {
    error EngineDown();

    function record(bytes32, uint8, bool, uint16) external pure {
        revert EngineDown();
    }
}

/// @notice Burns every unit of gas it is given.
contract GasBurningEngine is ICompatibilityEngine {
    uint256 public sink;

    function record(bytes32, uint8, bool, uint16) external {
        while (true) {
            sink++;
        }
    }
}

/// @notice Reverts with a very large payload: a caller that copied revert data would pay for the
/// memory expansion ("return bomb"). 352 KiB costs the engine about 282k gas of memory, just
/// inside the registry's 300k engine budget, and would cost a copying caller as much again.
contract ReturnBombEngine is ICompatibilityEngine {
    uint256 public constant PAYLOAD_BYTES = 352 * 1024;

    function record(bytes32, uint8, bool, uint16) external pure {
        assembly ("memory-safe") {
            revert(0, 360448)
        }
    }
}

/// @notice Tries to call back into the registry with whatever call it was configured with.
contract ReentrantEngine is ICompatibilityEngine {
    address public target;
    bytes public payload;
    bool public reentered;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function record(bytes32, uint8, bool, uint16) external {
        (bool ok, bytes memory ret) = target.call(payload);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        reentered = true;
    }
}
