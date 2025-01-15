// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface RoleManagerEvents {
    event RoleUpdated(address indexed target, address indexed caller, bytes32 indexed role, bool status);
    event QuorumUpdated(bytes32 indexed role, uint256 newQuorum);
    event TransactionLimitUpdated(bytes32 indexed role, uint256 newLimit);
    event RoleActivityUpdated(address indexed account, uint256 timestamp);
    event TimeLockConfigUpdated(address indexed account, uint256 newLockTime);
    event RoleTimeLockUpdated(address indexed account, uint64 duration);
    event RoleRevocationScheduled(address indexed account, bytes32 indexed role, uint256 effectiveTime);
}
