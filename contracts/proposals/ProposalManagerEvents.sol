// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ProposalManagerEvents {
    event ProposalCreated(
        bytes32 indexed proposalId,
        uint32 version,
        uint8 indexed proposalType,
        address indexed target,
        bytes32 role,
        uint256 amount,
        address tokenAddress,
        bool isAdd,
        address proposer
    );
    event ProposalApproved(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed approver);
    event ProposalReadyForExecution(bytes32 indexed proposalId, uint8 indexed proposalType);
    event ProposalExecuted(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed target);
    event ProposalExpired(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed target);
}
