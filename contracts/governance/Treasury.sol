// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Treasury is AccessControl, ReentrancyGuard {
    address public immutable storageToken;

    event W(address indexed t, address indexed r, uint256 a); //Withdrawn(token, to, amount)

    error F(uint8 s); // Failed(status);

    constructor(
        address _storageToken,
        address _admin
    ) {
        if(_admin == address(0) || _storageToken == address(0)) 
            revert F(0);
        
        storageToken = _storageToken;
        
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

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
