// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal ERC20 mock for testing recoverERC20 with non-FULA tokens.
contract MockERC20 is ERC20 {
    constructor(uint256 initialSupply) ERC20("MockToken", "MCK") {
        _mint(msg.sender, initialSupply);
    }
}
