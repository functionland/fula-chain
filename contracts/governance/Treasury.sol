// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract Treasury is AccessControl, ReentrancyGuard, Pausable {
    address public immutable storageToken;

    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error Failed(uint8 status);

    constructor(
        address _storageToken,
        address _admin
    ) {
        if(_admin == address(0) || _storageToken == address(0)) 
            revert Failed(0);
        
        storageToken = _storageToken;
        
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    function withdrawFees(
        address token,
        uint256 amount
    ) external nonReentrant whenNotPaused onlyRole(DEFAULT_ADMIN_ROLE) {
        if(amount == 0) revert Failed(1);

        uint256 balance = IERC20(token).balanceOf(address(this));
        if(amount > balance) revert Failed(2);

        bool success = IERC20(token).transfer(storageToken, amount);
        if(!success) revert Failed(3);

        emit Withdrawn(token, storageToken, amount);
    }
}
