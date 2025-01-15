// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRoleManager {
    function checkRolePermission(address account, bytes32 role) external view returns (bool);
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
    function setRoleQuorum(bytes32 role, uint32 quorum) external;
    function setRoleTransactionLimit(bytes32 role, uint256 limit) external;
    function getRoleQuorum(bytes32 role) external view returns (uint32);
    function getRoleTransactionLimit(bytes32 role) external view returns (uint256);
    function checkRoleActivity(address account) external view returns (bool);
    function getRoleActivity(address account) external view returns (uint64);
}
