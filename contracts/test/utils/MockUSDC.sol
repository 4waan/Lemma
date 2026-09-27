// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Six-decimal test stand-in for USDC, on OpenZeppelin's ERC20.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A USDC whose transfers can start charging a fee (USDC is upgradeable, so the
/// registry must fail closed if that ever happens). The fee is burned from the amount received.
contract FeeOnTransferUSDC is MockUSDC {
    uint256 public feeBps;

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function _update(address from, address to, uint256 value) internal override {
        uint256 fee = (from == address(0) || to == address(0)) ? 0 : (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        if (fee != 0) super._update(from, address(0), fee);
    }
}

/// @notice A USDC with a blocklist, like Circle's: transfers to or from a blocked account revert.
contract BlocklistUSDC is MockUSDC {
    mapping(address => bool) public blocked;

    error Blocked(address account);

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
