// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "../access/IRoleManager.sol";
import "./IProposalManager.sol";
import "./ProposalManagerEvents.sol";
import "./ProposalManagerErrors.sol";

contract ProposalManager is 
    IProposalManager,
    ProposalManagerEvents,
    ProposalManagerErrors,
    Initializable,
    UUPSUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    // Constants
    uint8 constant WHITELIST_FLAG = 1;
    uint8 constant ROLE_CHANGE_FLAG = 2;
    uint8 constant RECOVERY_FLAG = 4;
    uint8 constant UPGRADE_FLAG = 8;
    
    uint8 constant ISADD_FLAG = 1;
    uint8 constant EXECUTED_FLAG = 2;
    uint8 constant ISREMOVED_FLAG = 4;

    uint32 public constant MIN_PROPOSAL_EXECUTION_DELAY = 24 hours;

    // Packed storage structs
    struct UnifiedProposal {
        bytes32 role;
        uint256 amount;
        uint256 expiryTime;
        uint256 executionTime;
        address target;
        address tokenAddress;
        uint32 approvals;
        uint8 proposalType;
        uint8 flags;
        mapping(address => bool) hasApproved;
    }

    struct PendingProposals {
        uint8 flags;
    }

    // Storage
    IRoleManager public roleManager;
    mapping(bytes32 => UnifiedProposal) public proposals;
    mapping(address => PendingProposals) public pendingProposals;
    mapping(address => bytes32) private upgradeProposals;
    mapping(uint256 => bytes32) private proposalRegistry;
    uint256 public proposalTimeout;
    uint256 private proposalCount;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _roleManager,
        uint256 _proposalTimeout
    ) external initializer {
        if (_roleManager == address(0)) revert InvalidAddress(_roleManager);
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        roleManager = IRoleManager(_roleManager);
        proposalTimeout = _proposalTimeout;
        proposalCount = 0;
    }

    function createProposal(
        ProposalType proposalType,
        address target,
        bytes32 role,
        uint256 amount,
        address tokenAddress,
        bool isAdd
    ) external whenNotPaused nonReentrant returns (bytes32) {
        if (!roleManager.checkRolePermission(msg.sender, roleManager.ADMIN_ROLE())) 
            revert UnauthorizedProposalApproverErr();
        if (target == address(0)) revert InvalidAddress(target);

        // Validate proposal based on type
        _validateProposal(proposalType, target, role, amount, tokenAddress);

        bytes32 proposalId = keccak256(abi.encodePacked(
            proposalType,
            target,
            role,
            amount,
            tokenAddress,
            isAdd,
            block.timestamp
        ));

        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.executionTime != 0) revert DuplicateProposalErr(uint8(proposalType), target);

        _createProposal(
            proposal,
            proposalId,
            target,
            role,
            amount,
            tokenAddress,
            uint8(proposalType),
            isAdd
        );

        return proposalId;
    }

    function approveProposal(bytes32 proposalId) 
        external 
        whenNotPaused 
        nonReentrant 
    {
        if (!roleManager.checkRolePermission(msg.sender, roleManager.ADMIN_ROLE())) 
            revert UnauthorizedProposalApproverErr();

        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalNotFoundErr();
        if ((proposal.flags & EXECUTED_FLAG) != 0) revert ProposalAlreadyExecutedErr();
        if (proposal.hasApproved[msg.sender]) revert ProposalAlreadyApprovedErr();
        
        _processProposalApproval(proposalId, proposal);
    }

    function executeProposal(bytes32 proposalId) 
        external 
        whenNotPaused 
        nonReentrant 
    {
        if (!roleManager.checkRolePermission(msg.sender, roleManager.ADMIN_ROLE())) 
            revert UnauthorizedProposalApproverErr();

        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalNotFoundErr();

        uint32 requiredQuorum = roleManager.getRoleQuorum(roleManager.ADMIN_ROLE());
        if (proposal.approvals < requiredQuorum) {
            revert InsufficientApprovalsErr(requiredQuorum, proposal.approvals);
        }

        if ((proposal.flags & EXECUTED_FLAG) != 0) revert ProposalAlreadyExecutedErr();
        if (block.timestamp < proposal.executionTime) {
            revert ProposalExecutionDelayNotMetErr(proposal.executionTime);
        }

        _executeProposal(proposalId);
    }

    function _validateProposal(
        ProposalType proposalType,
        address target,
        bytes32 role,
        uint256 amount,
        address tokenAddress
    ) internal view {
        PendingProposals storage pending = pendingProposals[target];
        
        if (proposalType == ProposalType.Whitelist) {
            if (pending.flags & WHITELIST_FLAG != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.RoleChange) {
            if (pending.flags & ROLE_CHANGE_FLAG != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.Recovery) {
            if (pending.flags & RECOVERY_FLAG != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.Upgrade) {
            if (pending.flags & UPGRADE_FLAG != 0) revert ExistingActiveProposal(target);
        } else {
            revert InvalidProposalTypeErr(uint8(proposalType));
        }
    }

    function _createProposal(
        UnifiedProposal storage proposal,
        bytes32 proposalId,
        address target,
        bytes32 role,
        uint256 amount,
        address tokenAddress,
        uint8 proposalType,
        bool isAdd
    ) internal {
        proposal.target = target;
        proposal.tokenAddress = tokenAddress;
        proposal.role = role;
        proposal.amount = amount;
        proposal.expiryTime = block.timestamp + proposalTimeout;
        proposal.executionTime = block.timestamp + MIN_PROPOSAL_EXECUTION_DELAY;
        proposal.approvals = 1;
        proposal.proposalType = proposalType;
        proposal.flags = isAdd ? ISADD_FLAG : ISREMOVED_FLAG;
        proposal.hasApproved[msg.sender] = true;

        uint8 flag = _getProposalFlag(ProposalType(proposalType));
        pendingProposals[target].flags |= flag;

        if (proposalType == uint8(ProposalType.Upgrade)) {
            upgradeProposals[target] = proposalId;
        }

        proposalRegistry[proposalCount] = proposalId;
        proposalCount++;

        emit ProposalCreated(
            proposalId,
            1, // version
            proposalType,
            target,
            role,
            amount,
            tokenAddress,
            isAdd,
            msg.sender
        );
    }

    function _processProposalApproval(
        bytes32 proposalId,
        UnifiedProposal storage proposal
    ) internal {
        if (block.timestamp >= proposal.expiryTime) {
            _handleExpiredProposal(proposalId, proposal);
            revert ProposalExpiredErr();
        }

        proposal.hasApproved[msg.sender] = true;
        proposal.approvals++;

        emit ProposalApproved(proposalId, proposal.proposalType, msg.sender);

        uint32 requiredQuorum = roleManager.getRoleQuorum(roleManager.ADMIN_ROLE());
        if (proposal.approvals >= requiredQuorum && 
            block.timestamp >= proposal.executionTime) {
            emit ProposalReadyForExecution(proposalId, proposal.proposalType);
            _executeProposal(proposalId);
        }
    }

    function _executeProposal(bytes32 proposalId) internal {
        UnifiedProposal storage proposal = proposals[proposalId];
        PendingProposals storage pending = pendingProposals[proposal.target];

        if (proposal.proposalType == uint8(ProposalType.Upgrade)) {
            delete upgradeProposals[proposal.target];
        }

        uint8 flag = _getProposalFlag(ProposalType(proposal.proposalType));
        pending.flags &= ~flag;

        if (pending.flags == 0) {
            delete pendingProposals[proposal.target];
        }

        proposal.flags |= EXECUTED_FLAG;
        emit ProposalExecuted(proposalId, proposal.proposalType, proposal.target);
    }

    function _handleExpiredProposal(
        bytes32 proposalId,
        UnifiedProposal storage proposal
    ) internal {
        PendingProposals storage pending = pendingProposals[proposal.target];
        uint8 flag = _getProposalFlag(ProposalType(proposal.proposalType));
        
        pending.flags &= ~flag;
        if (pending.flags == 0) {
            delete pendingProposals[proposal.target];
        }

        if (proposal.proposalType == uint8(ProposalType.Upgrade)) {
            delete upgradeProposals[proposal.target];
        }

        delete proposals[proposalId];
        proposalCount--;
        
        emit ProposalExpired(
            proposalId,
            ProposalType(proposal.proposalType),
            proposal.target
        );
    }

    function _getProposalFlag(ProposalType proposalType) internal pure returns (uint8) {
        if (proposalType == ProposalType.Whitelist) return WHITELIST_FLAG;
        if (proposalType == ProposalType.RoleChange) return ROLE_CHANGE_FLAG;
        if (proposalType == ProposalType.Recovery) return RECOVERY_FLAG;
        return UPGRADE_FLAG;
    }

        function getProposalDetails(bytes32 proposalId) 
        external 
        view 
        returns (
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
        ) 
    {
        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalNotFoundErr();

        bool isAdded = (proposal.flags & ISADD_FLAG) != 0;
        bool isRemoved = (proposal.flags & ISREMOVED_FLAG) != 0;
        bool isAddFlg = isAdded && !isRemoved;

        return (
            proposal.proposalType,
            proposal.target,
            proposal.role,
            proposal.amount,
            proposal.tokenAddress,
            isAddFlg,
            proposal.approvals,
            proposal.expiryTime,
            proposal.executionTime,
            (proposal.flags & EXECUTED_FLAG) != 0,
            proposal.hasApproved[msg.sender]
        );
    }

    function getPendingProposals(uint256 offset, uint256 limit) 
        external 
        view 
        returns (
            bytes32[] memory proposalIds,
            uint8[] memory types,
            address[] memory targets,
            uint256[] memory expiryTimes,
            bool[] memory executed,
            uint256 total
        ) 
    {
        if (limit > 20) revert LimitTooHigh();
        
        uint256 remaining = proposalCount > offset ? proposalCount - offset : 0;
        uint256 size = remaining < limit ? remaining : limit;
        
        proposalIds = new bytes32[](size);
        types = new uint8[](size);
        targets = new address[](size);
        expiryTimes = new uint256[](size);
        executed = new bool[](size);

        uint256 validCount = 0;
        uint256 skipped = 0;

        for (uint256 i = 0; i < proposalCount && validCount < size; i++) {
            bytes32 proposalId = proposalRegistry[i];
            UnifiedProposal storage proposal = proposals[proposalId];
            
            bool isExecuted = (proposal.flags & EXECUTED_FLAG) != 0;
            
            if (proposal.target != address(0) && 
                !isExecuted && 
                proposal.expiryTime > block.timestamp) {
                
                if (skipped < offset) {
                    skipped++;
                    continue;
                }
                
                proposalIds[validCount] = proposalId;
                types[validCount] = proposal.proposalType;
                targets[validCount] = proposal.target;
                expiryTimes[validCount] = proposal.expiryTime;
                executed[validCount] = isExecuted;
                validCount++;
            }
        }

        assembly {
            mstore(proposalIds, validCount)
            mstore(types, validCount)
            mstore(targets, validCount)
            mstore(expiryTimes, validCount)
            mstore(executed, validCount)
        }

        return (proposalIds, types, targets, expiryTimes, executed, proposalCount);
    }

    function hasApprovedProposal(bytes32 proposalId, address approver) 
        external 
        view 
        returns (bool) 
    {
        return proposals[proposalId].hasApproved[approver];
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        if (newImplementation == address(0)) revert InvalidAddress(newImplementation);
        
        // Check quorum requirements
        RoleConfig storage adminConfig = roleConfigs[ADMIN_ROLE];
        if (adminConfig.quorum < 2) {
            revert InvalidQuorumErr(ADMIN_ROLE, adminConfig.quorum);
        }

        // Find the active upgrade proposal
        bytes32 currentId = upgradeProposals[newImplementation];
        if (currentId == 0) revert ProposalNotFoundErr();
        
        // Cache proposal storage
        UnifiedProposal storage currentProposal = proposals[currentId];
        
        // Check if proposal is valid
        if (currentProposal.proposalType != uint8(ProposalType.Upgrade) || 
            currentProposal.target != newImplementation ||
            (currentProposal.flags & EXECUTED_FLAG) != 0 ||
            currentProposal.expiryTime <= block.timestamp) {
            revert ProposalNotFoundErr();
        }
        
        // Check required approvals
        uint32 requiredApprovals = adminConfig.quorum;
        if (currentProposal.approvals < requiredApprovals) {
            revert InsufficientApprovalsErr(requiredApprovals, currentProposal.approvals);
        }
        
        // Check execution delay
        if (block.timestamp < currentProposal.executionTime) {
            revert ProposalExecutionDelayNotMetErr(currentProposal.executionTime);
        }

        // Update state for upgrade
        delete upgradeProposals[newImplementation];
        currentProposal.flags |= EXECUTED_FLAG;
        
        // Update pending proposals
        PendingProposals storage pending = pendingProposals[currentProposal.target];
        pending.flags &= ~UPGRADE_FLAG;
        
        if (pending.flags == 0) {
            delete pendingProposals[currentProposal.target];
        }
        
        emit ProposalExecuted(currentId, ProposalType.Upgrade, currentProposal.target);
    }

    uint256[45] private __gap;
}