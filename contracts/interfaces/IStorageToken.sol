// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IStorageToken {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event BridgeTransfer(address indexed from, uint256 value, uint256 targetChain);
    
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function bridgeTransfer(uint256 targetChain, uint256 amount) external;
    function withdraw(uint256 amount) external;
}
