// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "../governance/libraries/ProposalTypes.sol";

contract SubstrateAddressMapper is 
    AccessControlUpgradeable, 
    ReentrancyGuardUpgradeable, 
    PausableUpgradeable,
    UUPSUpgradeable 
{
    mapping(address => bytes) public ethereumToSubstrate;

    event AddressesAdded(uint256 count);
    event AddressRemoved(address indexed ethereumAddr);

    error InvalidAddressLength();

    function initialize(address admin) public initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ProposalTypes.ADMIN_ROLE, admin);
    }

    function addAddress(
        address ethereumAddr,
        bytes calldata substrateAddr
    ) external nonReentrant whenNotPaused onlyRole(DEFAULT_ADMIN_ROLE) {
        require(ethereumAddr != address(0), "Invalid ethereum address");
        require(substrateAddr.length <= 50, "Invalid substrate address length");
        ethereumToSubstrate[ethereumAddr] = substrateAddr;
        emit AddressesAdded(1);
    }

    function batchAddAddresses(
        address[] calldata ethereumAddrs, 
        bytes[] calldata substrateAddrs
    ) external nonReentrant whenNotPaused onlyRole(DEFAULT_ADMIN_ROLE) {
        require(ethereumAddrs.length == substrateAddrs.length, "Arrays length mismatch");
        require(ethereumAddrs.length <= 1000, "Batch too large");
        
        for(uint256 i = 0; i < ethereumAddrs.length; i++) {
            require(ethereumAddrs[i] != address(0), "Invalid ethereum address");
            require(substrateAddrs[i].length <= 50, "Invalid substrate address length");
            ethereumToSubstrate[ethereumAddrs[i]] = substrateAddrs[i];
        }

        emit AddressesAdded(ethereumAddrs.length);
    }

    function removeAddress(address ethereumAddr) external nonReentrant whenNotPaused onlyRole(DEFAULT_ADMIN_ROLE) {
        require(ethereumToSubstrate[ethereumAddr].length != 0, "Address not mapped");
        delete ethereumToSubstrate[ethereumAddr];
        emit AddressRemoved(ethereumAddr);
    }

    function _authorizeUpgrade(address newImplementation) 
        internal 
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
        override 
    {
        // Delegate the authorization to the governance module
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
    }

    function _checkUpgrade(address newImplementation) internal pure returns (bool) {
        // Add any additional upgrade checks here
        return newImplementation != address(0);
    }

    function verifySubstrateAddress(address wallet, bytes calldata substrateAddr) public view returns (bool) {
        bytes memory mappedAddr = ethereumToSubstrate[wallet];
        return mappedAddr.length > 0 && keccak256(mappedAddr) == keccak256(substrateAddr);
    }
}
