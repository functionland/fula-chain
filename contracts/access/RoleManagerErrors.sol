// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface RoleManagerErrors {
    error InvalidQuorum(bytes32 role, uint32 quorum);
    error TimeLockActive(address operator);
    error InvalidAddress(address wallet);
    error MinimumRoleNoRequired();
    error CannotRemoveSelf();
    error InvalidRole(bytes32 role);
    error UnauthorizedCaller(address caller);
    error InactiveRole(address account);
    error ExceedsTransactionLimit(uint256 amount, uint256 limit);
}
