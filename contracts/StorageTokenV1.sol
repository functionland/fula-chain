// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract StorageTokenV1 is ERC20Upgradeable, OwnableUpgradeable, UUPSUpgradeable {
    uint256 private constant MAX_SUPPLY = 1_000_000 * 10**18;
    
    event BridgeTransfer(address indexed from, uint256 amount, uint256 targetChain);
    
    function initialize() public initializer {
        __ERC20_init("Test Token", "TT");
        __Ownable_init();
        __UUPSUpgradeable_init();
        _mint(msg.sender, MAX_SUPPLY);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // - Transfer of Token implementation
    function bridgeTransfer(uint256 targetChain, uint256 amount) external {
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");
        _burn(msg.sender, amount);
        emit BridgeTransfer(msg.sender, amount, targetChain);
    }
}
