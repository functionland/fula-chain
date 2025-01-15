// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProposalManager {
    enum ProposalType { RoleChange, Upgrade, Recovery, Whitelist }

    function createProposal(
        ProposalType proposalType,
        address target,
        bytes32 role,
        uint256 amount,
        address tokenAddress,
        bool isAdd
    ) external returns (bytes32);

    function approveProposal(bytes32 proposalId) external;
    function executeProposal(bytes32 proposalId) external;
    function getProposalDetails(bytes32 proposalId) external view returns (
        uint8 proposalType,
        address target,
        bytes32 role,
        uint256 amount,
        address tokenAddress,
        bool isAdd,
        uint32 approvals,
        uint256 expiryTime,
        uint256 executionTime,
        bool executed,
        bool hasApproved
    );
    function getPendingProposals(uint256 offset, uint256 limit) external view returns (
        bytes32[] memory proposalIds,
        uint8[] memory types,
        address[] memory targets,
        uint256[] memory expiryTimes,
        bool[] memory executed,
        uint256 total
    );
    function hasApprovedProposal(bytes32 proposalId, address approver) external view returns (bool);
}
