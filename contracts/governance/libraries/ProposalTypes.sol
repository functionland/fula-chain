// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ProposalTypes Library
/// @notice Library containing shared types and constants for governance proposals
/// @dev This library is used by both StorageToken and TokenDistributionEngine contracts
library ProposalTypes {
    /// @notice Enum representing different types of proposals
    enum ProposalType { 
        AddRole,  // For adding or removing roles
        RemoveRole,
        Upgrade,     // For contract upgrades
        Recovery,    // For token recovery operations
        AddWhitelist,    // For whitelist management
        RemoveWhitelist
    }

    /// @notice Time-related constants for proposal lifecycle
    uint32 constant MIN_PROPOSAL_EXECUTION_DELAY = 24 hours;
    uint32 constant PROPOSAL_TIMEOUT = 3 days;
    uint32 constant ROLE_CHANGE_DELAY = 1 days;
    bytes32 public constant BRIDGE_OPERATOR_ROLE = keccak256("BRIDGE_OPERATOR_ROLE");
    bytes32 public constant CONTRACT_OPERATOR_ROLE = keccak256("CONTRACT_OPERATOR_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant UNDER_REVIEW = keccak256("UNDER_REVIEW");

    // Time Constants
    uint32 public constant INACTIVITY_THRESHOLD = 365 days;
    uint32 public constant EMERGENCY_COOLDOWN = 30 minutes;
    uint8 public constant EMERGENCY_THRESHOLD = 3;

    /// @notice Structure for proposal configuration
    struct ProposalConfig {
        uint8 status; // 1: executed
        uint32 approvals;      // Number of approvals received
        uint64 expiryTime;     // Timestamp when proposal expires
        uint64 executionTime;  // Earliest timestamp when proposal can be executed
    }

    struct UnifiedProposal {
        // Basic proposal info
        uint8 proposalType;
        bytes32 role;
        address target;
        address tokenAddress;

        // Multi-wallet support
        address[] wallets;
        bytes32[] names;
        uint256[] allocations;
        
        // Token and amount related
        uint256 amount;
        uint256 capId;
        
        // Packed configuration
        ProposalConfig config;
        
        // Approval tracking
        mapping(address => bool) hasApproved;
    }

    /// @notice Structure for time-related configurations
    struct TimeConfig {
        uint64 lastActivityTime;    // Last activity timestamp
        uint64 roleChangeTimeLock;  // Timelock for role changes
        uint64 whitelistLockTime;   // Timelock for whitelist operations
    }

    /// @notice Structure for role-related configurations
    struct RoleConfig {
        uint32 quorum;             // Required number of approvals
        uint256 transactionLimit;  // Transaction limit for role
    }

    /// @notice Structure for pending proposal tracking
    struct PendingProposals {
        uint8 proposalType;  // Flags indicating pending proposal types
    }

    /// @notice Error codes for proposal operations
    // uint8 constant ERROR_PROPOSAL_NOT_FOUND = 1;
    // uint8 constant ERROR_PROPOSAL_EXPIRED = 2;
    // uint8 constant ERROR_ALREADY_EXECUTED = 3;
    // uint8 constant ERROR_ALREADY_APPROVED = 4;
    // uint8 constant ERROR_INSUFFICIENT_APPROVALS = 5;
    // uint8 constant ERROR_EXECUTION_DELAY = 6;
    // uint8 constant ERROR_UNAUTHORIZED = 7;
}
