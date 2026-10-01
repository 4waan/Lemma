// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Compatibility engine hook
/// @notice What the warranty registry calls when an evaluator finalizes a weighted PASSED or FAILED
/// outcome. The Stylus compatibility-confidence contract implements it; its exported ABI must keep
/// this exact signature.
/// @dev The registry calls it at most once per resolution, with a fixed gas budget, inside try/catch:
/// a failing engine never blocks finalization.
interface ICompatibilityEngine {
    /// @notice Records one finalized adoption outcome for a release profile.
    /// @param releaseDigest The Capability Release's content digest.
    /// @param profileIndex The index of the release profile the resolution covered.
    /// @param passed True for a PASSED verdict, false for FAILED.
    /// @param weightBps The outcome's weight in basis points, 1 to 10000.
    function record(bytes32 releaseDigest, uint8 profileIndex, bool passed, uint16 weightBps)
        external;
}
