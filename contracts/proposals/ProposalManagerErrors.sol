// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ProposalManagerErrors {
    error ProposalNotFoundErr();
    error ProposalExpiredErr();
    error ProposalAlreadyExecutedErr();
    error ProposalAlreadyApprovedErr();
    error InsufficientApprovalsErr(uint32 requiredApprovals, uint32 approvals);
    error InvalidProposalTypeErr(uint8 proposalType);
    error DuplicateProposalErr(uint8 proposalType, address target);
    error ProposalExecutionDelayNotMetErr(uint256 allowedTime);
    error UnauthorizedProposalApproverErr();
    error ExistingActiveProposal(address target);
    error LimitTooHigh();
    error InvalidAddress(address wallet);
    error TimeLockActive(address operator);
}