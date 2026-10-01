// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Compatibility-confidence engine stand-in for a local chain
/// @notice anvil cannot run Stylus, so the end-to-end run puts this contract where the Stylus
/// engine (contracts/stylus/confidence-contract) sits on Arbitrum Sepolia. It has that engine's
/// constructor, owner and registry checks, errors and events, and the calls the operator script
/// and the registry make: `setRegistry`, `setPrior`, `record` (which matches the registry's
/// ICompatibilityEngine) and `stats`. It computes no confidence and keeps no decayed sums: the
/// server computes the confidence from indexed outcomes with the same crate compiled to wasm.
/// Instead, like the registry's RecordingEngine test mock, it keeps every `record` call, with the
/// gas it arrived with and its caller, for the run to check.
contract ConfidenceStandIn {
    /// @notice The caller is not the owner.
    error NotOwner(address caller);
    /// @notice The caller is not the registry, or no registry is set.
    error NotRegistry(address caller);
    /// @notice The owner cannot be the zero address.
    error ZeroOwner();
    /// @notice A weight above a full outcome (10 000 bps).
    error WeightTooLarge(uint16 weightBps);

    event OutcomeRecorded(
        bytes32 indexed releaseDigest, uint8 indexed profileIndex, bool passed, uint16 weightBps
    );
    event PriorSet(
        bytes32 indexed releaseDigest,
        uint8 indexed profileIndex,
        uint32 passes,
        uint32 failures,
        bytes32 evidenceDigest
    );
    event RegistrySet(address indexed registry);

    /// @notice One `record` call as it arrived.
    struct Call {
        bytes32 releaseDigest;
        uint8 profileIndex;
        bool passed;
        uint16 weightBps;
        uint256 gasAtEntry;
        address caller;
    }

    struct Prior {
        uint32 passes;
        uint32 failures;
    }

    /// @notice Sets priors and the registry.
    address public owner;
    /// @notice The only address that may record outcomes (zero: nobody).
    address public registry;

    mapping(bytes32 key => Prior) private _priors;
    Call[] private _calls;

    constructor(address owner_, address registry_) {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
        registry = registry_;
        emit RegistrySet(registry_);
    }

    /// @notice Owner only: the address allowed to record; zero turns recording off.
    function setRegistry(address newRegistry) external {
        _onlyOwner();
        registry = newRegistry;
        emit RegistrySet(newRegistry);
    }

    /// @notice Owner only: a (release, profile)'s benchmark prior, citing its evidence.
    function setPrior(
        bytes32 releaseDigest,
        uint8 profileIndex,
        uint32 passes,
        uint32 failures,
        bytes32 evidenceDigest
    ) external {
        _onlyOwner();
        _priors[_key(releaseDigest, profileIndex)] = Prior(passes, failures);
        emit PriorSet(releaseDigest, profileIndex, passes, failures, evidenceDigest);
    }

    /// @notice Registry only: one finalized outcome, kept as it arrived.
    function record(bytes32 releaseDigest, uint8 profileIndex, bool passed, uint16 weightBps)
        external
    {
        uint256 gasAtEntry = gasleft();
        if (registry == address(0) || msg.sender != registry) revert NotRegistry(msg.sender);
        if (weightBps > 10_000) revert WeightTooLarge(weightBps);
        _calls.push(Call(releaseDigest, profileIndex, passed, weightBps, gasAtEntry, msg.sender));
        emit OutcomeRecorded(releaseDigest, profileIndex, passed, weightBps);
    }

    /// @notice The Stylus engine's `stats` layout: `(passWad, failWad, last, priorPasses,
    /// priorFailures)`. This stand-in keeps no sums, so the first three are always zero.
    function stats(bytes32 releaseDigest, uint8 profileIndex)
        external
        view
        returns (uint128, uint128, uint64, uint32, uint32)
    {
        Prior memory p = _priors[_key(releaseDigest, profileIndex)];
        return (0, 0, 0, p.passes, p.failures);
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 i) external view returns (Call memory) {
        return _calls[i];
    }

    function _onlyOwner() private view {
        if (msg.sender != owner) revert NotOwner(msg.sender);
    }

    /// @dev The Stylus engine's storage key: keccak256(abi.encode(releaseDigest, profileIndex)).
    function _key(bytes32 releaseDigest, uint8 profileIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(releaseDigest, profileIndex));
    }
}
