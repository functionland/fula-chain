// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Treasury
/// @notice Treasury contract for fee management
/// @dev Used in StorageToken contract
contract Treasury is AccessControl, ReentrancyGuard {
    address public immutable storageToken;
    uint256 private _adminCount; // Tracking admins manually to avoid using EnumerableAccessControl for contract size optimization

    event W(address indexed t, address indexed r, uint256 a); // Withdrawn(token, to, amount)

    error F(uint8 s); // Failed(status); 0 - zero address, 1 - zero amount, 2 - insufficient balance, 3 - transfer failed, 4 - last admin

    /// @notice initializes the Treasury
    /// @param  _storageToken is the address of main token contract
    /// @param _admin is the initial admin for treasury
    constructor(
        address _storageToken,
        address _admin
    ) {
        if(_admin == address(0) || _storageToken == address(0)) 
            revert F(0);
        
        storageToken = _storageToken;
        
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _adminCount = 1; // Initialize admin count
    }

    // Override grantRole to track admin count
    function grantRole(bytes32 role, address account) public override {
        if (role == DEFAULT_ADMIN_ROLE && !hasRole(role, account)) {
            _adminCount += 1;
        }
        super.grantRole(role, account);
    }

    // Override revokeRole to prevent last admin revocation
    function revokeRole(bytes32 role, address account) public override {
        if (role == DEFAULT_ADMIN_ROLE) {
            if (hasRole(role, account)) {
                if (_adminCount <= 1) {
                    revert F(4); // Prevent last admin revocation
                }
                _adminCount -= 1;
            }
        }
        super.revokeRole(role, account);
    }

    function renounceRole(bytes32 role, address account) public override {
        if (role == DEFAULT_ADMIN_ROLE) {
            if (hasRole(role, account)) {
                if (_adminCount <= 1) {
                    revert F(4);
                }
                _adminCount -= 1;
            }
        }
        super.renounceRole(role, account);
    }

    /// @notice this method withdraws the gathered fees to the main contract, which then can be burnt or recirculated
    /// @param t is the token contract address
    /// @param a is the amount to be transferred to token contract
    function withdrawFees(
        address t,  // token
        uint256 a   // amount
    ) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if(a == 0) revert F(1);
        uint256 b = IERC20(t).balanceOf(address(this));
        if(a > b) revert F(2);
        if(!IERC20(t).transfer(storageToken, a)) revert F(3);
        emit W(t, storageToken, a);
    }
}
