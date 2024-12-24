// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract StorageToken is ERC20Upgradeable, UUPSUpgradeable {
    uint256 private constant TOTAL_SUPPLY = 1_000_000 * 10**18; // 1M tokens

    constructor() {}
    
    function initialize() public initializer {
        __ERC20_init("Test Token", "TT");
        __UUPSUpgradeable_init();
        _mint(msg.sender, TOTAL_SUPPLY);
    }

    function _authorizeUpgrade(address newImplementation) internal override {}

    // Bridge-specific functions
    function bridgeMint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function bridgeBurn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
