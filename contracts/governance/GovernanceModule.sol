// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./libraries/ProposalTypes.sol";

/// @title GovernanceModule
/// @notice Multi-sig and common features used across all contracts
/// @dev Used to manage proposals for common features and delegates custom proposals to corresponding contracts
/// @dev Handles proposal for Managing Roles, Upgrades, Ownerships
abstract contract GovernanceModule is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    // Events
    event RU(address target, address caller, bytes32 role, bool status); //RoleUpdates
    event EA(uint8 action, uint256 timestamp, address caller); // EmergencyAction 1 pause, 2 unpause
    event ProposalCreated(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed target, bytes32 role, uint256 amount, address tokenAddress, address proposer);
    event ProposalApproved(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed approver);
    event ProposalReadyForExecution(bytes32 indexed proposalId, uint8 indexed proposalType);
    event ProposalExpired(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed target);
    event QuorumUpdated(bytes32 indexed role, uint256 newQuorum);
    event TransactionLimitUpdated(bytes32 indexed role, uint256 newLimit);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    /// @notice Event emitted when a proposal is executed
    /// @param proposalId The ID of the executed proposal
    /// @param proposalType The type of the executed proposal
    /// @param target The target address affected by the proposal
    event ProposalExecuted(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed target);

    // Errors
    error ProposalErr(uint8 err); // 1: not found, 2: expired, 3: ProposalAlreadyExecuted, 4: ProposalAlreadyApproved, 5: DuplicateProposal, 6: UnauthorizedProposalApproverErr
    error InsufficientApprovals(uint16 requiredApprovals, uint16 approvals);
    error InvalidProposalType(uint8 proposalType);
    error ExecutionDelayNotMet(uint256 allowedTime);
    error InvalidQuorumErr(bytes32 role, uint16 quorum);
    error TimeLockActive(address operator);
    error ExistingActiveProposal(address target);
    error InvalidAddress();
    error MinimumRoleNoRequired();
    error CannotRemoveSelf();
    error CoolDownActive(uint256 waitUntil);
    error NotPendingOwner();
    error InvalidRole(bytes32 role);
    error AlreadyOwnsRole(address target);
    error AlreadyUpgraded();
    error RoleAssignment(address account, bytes32 role, uint8 status);
    error LimitTooHigh();
    error AmountMustBePositive();
    error TransferRestricted();
    error Failed(uint8 status); //1: recovery contract is same as current contract, 0 or 2: unknown
    error LowBalance(uint256 walletBalance, uint256 requiredBalance);

    uint32 private constant PROPOSAL_TIMEOUT = 48 hours;
    // Flag Constants
    uint8 constant INITIATED = 1;
    uint8 private constant PENDING_OWNERSHIP = 2;
    uint8 constant TGE_INITIATED = 4;
    uint256 public adminCount;

    /// @notice Core storage mappings
    mapping(bytes32 => ProposalTypes.UnifiedProposal) public proposals;
    mapping(address => ProposalTypes.PendingProposals) public pendingProposals;
    mapping(address => ProposalTypes.TimeConfig) public timeConfigs;
    mapping(bytes32 => ProposalTypes.RoleConfig) public roleConfigs;
    mapping(address => bytes32) public upgradeProposals;
    mapping(bytes32 => uint256) public proposalIndex;

    /// @notice Proposal tracking
    uint256 public proposalCount;
    mapping(uint256 => bytes32) public proposalRegistry;

    /// @notice Packed storage variables
    struct PackedVars {
        uint8 flags;
        uint40 lastEmergencyAction;
    }
    PackedVars private packedVars;

    address private _pendingOwnerRequest;

    /// @notice Update the last activity timestamp
    function _updateActivityTimestamp() internal {
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[msg.sender];
        timeConfig.lastActivityTime = uint64(block.timestamp);
    }

    /// @notice Initialize the governance module
    /// @param initialOwner Address of the initial owner
    /// @param initialAdmin Address of the initial admin
    function __GovernanceModule_init(
        address initialOwner,
        address initialAdmin
    ) internal onlyInitializing {
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();

        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControl_init();

        _grantRole(ProposalTypes.ADMIN_ROLE, initialOwner);
        _grantRole(ProposalTypes.ADMIN_ROLE, initialAdmin);
        adminCount = 2;

        uint256 lockTime = block.timestamp + ProposalTypes.ROLE_CHANGE_DELAY;
        timeConfigs[initialOwner].roleChangeTimeLock = uint64(lockTime);
        timeConfigs[initialAdmin].roleChangeTimeLock = uint64(lockTime);
    }

    /// @notice Proposal helper function to create a unique id
    function _createProposalId(uint8 proposalType, bytes32 data) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            proposalType,
            data,
            block.timestamp
        ));
    }

    /// @notice Transfer ownership with two-step pattern
    function transferOwnership(address newOwner) 
        public 
        virtual 
        override 
        whenNotPaused 
        nonReentrant 
        onlyOwner 
    {
        if (newOwner == address(0)) revert InvalidAddress();
        
        PackedVars storage vars = packedVars;
        vars.flags |= PENDING_OWNERSHIP;
        _pendingOwnerRequest = newOwner;
        _updateActivityTimestamp();
        emit OwnershipTransferStarted(owner(), newOwner);
    }

    /// @notice Accept pending ownership transfer
    function acceptOwnership() 
        public 
        virtual 
        whenNotPaused 
        nonReentrant
    {
        address pendingOwnerAddress = _pendingOwnerRequest;
        if (msg.sender != pendingOwnerAddress) revert NotPendingOwner();
        
        PackedVars storage vars = packedVars;
        vars.flags &= ~PENDING_OWNERSHIP;
        
        delete _pendingOwnerRequest;
        _transferOwnership(msg.sender);
    }

    /// @notice Set transaction limit for a role
    function setRoleTransactionLimit(bytes32 role, uint240 limit) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        _validateTimelock(msg.sender);
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[role];
        roleConfig.transactionLimit = limit;
        _updateActivityTimestamp();
        emit TransactionLimitUpdated(role, limit);
    }

    /// @notice Get pending owner address
    function pendingOwner() external view virtual returns (address) {
        return _pendingOwnerRequest;
    }

    /// @notice sets common properties ofa proposal
    function _initializeProposal(
        ProposalTypes.UnifiedProposal storage proposal,
        address target
    ) internal {
        proposal.target = target;
        proposal.config.expiryTime = uint64(block.timestamp + PROPOSAL_TIMEOUT);
        proposal.config.executionTime = uint64(block.timestamp + ProposalTypes.MIN_PROPOSAL_EXECUTION_DELAY);
        proposal.config.approvals = 1;
        proposal.hasApproved[msg.sender] = true;
    }

    /// @notice checks if an account has already approved a specific proposal
    function hasProposalApproval(bytes32 proposalId, address account) external view returns (bool) {
        return proposals[proposalId].hasApproved[account];
    }

    /// @notice Create a new proposal
    function createProposal(
        uint8 proposalType,
        uint40 id,
        address target,
        bytes32 role,
        uint96 amount,
        address tokenAddress
    ) 
        external 
        virtual 
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
        returns (bytes32)
    {
        if (target == address(0)) revert InvalidAddress();
        
        // Validate timelock and quorum
        _validateTimelock(msg.sender);
        _validateQuorum(ProposalTypes.ADMIN_ROLE);
        
        // Check for existing proposals
        if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);

        bytes32 proposalId;
        
        if (proposalType == uint8(ProposalTypes.ProposalType.AddRole) || proposalType == uint8(ProposalTypes.ProposalType.RemoveRole)) {
            if (role != ProposalTypes.ADMIN_ROLE && role != ProposalTypes.CONTRACT_OPERATOR_ROLE && role != ProposalTypes.BRIDGE_OPERATOR_ROLE && role != ProposalTypes.POOL_ADMIN_ROLE)
                revert InvalidRole(role);
            if (proposalType == uint8(ProposalTypes.ProposalType.AddRole)) {
                ProposalTypes.TimeConfig storage targetTimeConfig = timeConfigs[target];
                if (targetTimeConfig.roleChangeTimeLock != 0) revert AlreadyOwnsRole(target);
            }
            
            proposalId = _createRoleChangeProposal(target, role, proposalType);
        } 
        else if (proposalType == uint8(ProposalTypes.ProposalType.Upgrade)) {
            if (target == address(this)) revert AlreadyUpgraded();
            
            proposalId = _createUpgradeProposal(target);
            upgradeProposals[target] = proposalId;
        }
        else if (proposalType == uint8(ProposalTypes.ProposalType.Recovery)) {
            if(tokenAddress == address(this)) revert Failed(1);
            if (amount <= 0) revert AmountMustBePositive();
            if (pendingProposals[target].proposalType != 0) {
                revert ExistingActiveProposal(target);
            }

            proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(target, tokenAddress, amount))
            );

            ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
            _initializeProposal(
                proposal,
                target
            );

            proposal.proposalType = proposalType;
            proposal.tokenAddress = tokenAddress;
            proposal.amount = amount;
        }
        else {
            // Contract-specific proposals
            proposalId = _createCustomProposal(proposalType, id, target, role, amount, tokenAddress);
        }

        // Register proposal
        proposalRegistry[proposalCount] = proposalId;
        proposalIndex[proposalId] = proposalCount;
        proposalCount += 1;
        pendingProposals[target].proposalType = uint8(proposalType);

        emit ProposalCreated(
            proposalId,
            proposalType, 
            target, 
            role, 
            amount, 
            tokenAddress,
            msg.sender
        );
        _updateActivityTimestamp();
        return proposalId;
    }

    /// @notice handles proposal creation for assigning or removing a role from an account
    function _createRoleChangeProposal(
        address target, 
        bytes32 role,
        uint8 proposalType
    ) internal returns (bytes32) {
        if (proposalType == uint8(ProposalTypes.ProposalType.AddRole)) {
            if (hasRole(role, target)) revert RoleAssignment(target, role, 1);
        } else if (proposalType == uint8(ProposalTypes.ProposalType.RemoveRole)){
            if (!hasRole(role, target)) revert RoleAssignment(target, role, 2);
            if (target == msg.sender) revert CannotRemoveSelf();
            if (role == ProposalTypes.ADMIN_ROLE && adminCount <= 2) revert MinimumRoleNoRequired();
        }

        bytes32 proposalId = _createProposalId(
            proposalType,
            keccak256(abi.encodePacked(target, role))
        );

        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        _initializeProposal(
            proposal,
            target
        );

        proposal.role = role;
        proposal.proposalType = proposalType;
        
        return proposalId;
    }

    /// @notice creates a proposal for upgrading hte contract
    function _createUpgradeProposal(address newImplementation) internal returns (bytes32) {
        bytes32 existingProposal = upgradeProposals[newImplementation];
        if(existingProposal != 0) {
            ProposalTypes.UnifiedProposal storage oldProposal = proposals[existingProposal];
            if(block.timestamp >= oldProposal.config.expiryTime) {
                delete upgradeProposals[newImplementation];
                delete proposals[existingProposal];
            } else {
                revert ProposalErr(5);
            }
        }

        bytes32 proposalId = _createProposalId(
            uint8(ProposalTypes.ProposalType.Upgrade), 
            bytes32(bytes20(newImplementation))
        );

        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        _initializeProposal(
            proposal,
            newImplementation
        );

        proposal.proposalType = uint8(ProposalTypes.ProposalType.Upgrade);
        
        return proposalId;
    }

    /// @notice checks and removes expired proposals
    function _checkExpiredProposal(bytes32 proposalId) internal returns (bool) {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        if (block.timestamp >= proposal.config.expiryTime) {
            // Handle common proposal types
            if (proposal.proposalType == uint8(ProposalTypes.ProposalType.Upgrade)) {
                delete upgradeProposals[proposal.target];
            } else {
                _handleCustomProposalExpiry(proposalId);
            }

            // Delete entire record
            delete pendingProposals[proposal.target];
            delete proposals[proposalId];
            _removeFromRegistry(proposalId);
            
            emit ProposalExpired(proposalId, proposal.proposalType, proposal.target);
            return true; // Indicate that the proposal has expired
        }
        return false; // Indicate that the proposal has not expired
    }

    /// @notice Cleans up expired proposals in batches to avoid gas limits
    /// @param maxProposalsToCheck Maximum number of proposals to check in this batch
    function cleanupExpiredProposals(uint256 maxProposalsToCheck) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        uint256 checked = 0;
        uint256 index = proposalCount;
        
        // Process from the end of the registry to minimize storage changes
        while (checked < maxProposalsToCheck && index > 0) {
            unchecked { index--; } // Gas optimization: unchecked as index > 0
            checked++;
            
            bytes32 proposalId = proposalRegistry[index];
            if (proposals[proposalId].target == address(0)) {
                continue; // Skip already cleaned proposals
            }
            
            // Check expiration and automatically clean if needed
            _checkExpiredProposal(proposalId);
        }
        _updateActivityTimestamp();
    }

    function _removeFromRegistry(bytes32 proposalId) internal {
        uint256 index = proposalIndex[proposalId];
        if (index >= proposalCount) return;

        // Swap with the last element
        bytes32 lastProposalId = proposalRegistry[proposalCount - 1];
        proposalRegistry[index] = lastProposalId;
        proposalIndex[lastProposalId] = index;

        // Delete the last element
        delete proposalRegistry[proposalCount - 1];
        delete proposalIndex[proposalId];
        proposalCount -= 1;
    }

    // Virtual function for contract-specific proposals
    function _createCustomProposal(
        uint8 proposalType,
        uint40 id,
        address target,
        bytes32 role,
        uint96 amount,
        address tokenAddress
    ) internal virtual returns (bytes32);

    /// @notice Approve an existing proposal
    function approveProposal(bytes32 proposalId)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalErr(1);
        if (proposal.config.status != 0) revert ProposalErr(3);
        if (proposal.hasApproved[msg.sender]) revert ProposalErr(4);
        
        _validateTimelock(msg.sender);
        _validateQuorum(ProposalTypes.ADMIN_ROLE);
        
        if (_checkExpiredProposal(proposalId)) {
            revert ProposalErr(2); // Revert if expired
        }
        
        proposal.hasApproved[msg.sender] = true;
        proposal.config.approvals++;
        
        emit ProposalApproved(proposalId, proposal.proposalType, msg.sender);
        
        ProposalTypes.RoleConfig storage adminConfig = roleConfigs[ProposalTypes.ADMIN_ROLE];
        if (proposal.config.approvals >= adminConfig.quorum && 
            block.timestamp >= proposal.config.executionTime) {
            emit ProposalReadyForExecution(proposalId, proposal.proposalType);
            
            _executeProposal(proposalId);
        }
        _updateActivityTimestamp();
    }

    // Virtual function for child contracts to handle their specific proposal flag cleanup
    function _handleCustomProposalExpiry(bytes32 proposalId) internal virtual {}

    /// @notice executes a proposal depending on the type of proposal
    function executeProposal(bytes32 proposalId) 
        public
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalErr(1);
        
        // Cache storage reads
        ProposalTypes.RoleConfig storage adminConfig = roleConfigs[ProposalTypes.ADMIN_ROLE];
        if (adminConfig.quorum < 2) revert InvalidQuorumErr(ProposalTypes.ADMIN_ROLE, adminConfig.quorum);
        
        // Check approvals first
        if (proposal.config.approvals < adminConfig.quorum) revert InsufficientApprovals(adminConfig.quorum, proposal.config.approvals);
        
        // Check execution status
        if (proposal.config.status != 0) revert ProposalErr(3);
        
        // Check execution time and expiry
        if (block.timestamp < proposal.config.executionTime) revert ExecutionDelayNotMet(proposal.config.executionTime);

        _validateTimelock(msg.sender);
        _validateQuorum(ProposalTypes.ADMIN_ROLE);
        
       _executeProposal(proposalId);
        _updateActivityTimestamp();
    }

    function _executeProposal(bytes32 proposalId) 
        internal
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        if (_checkExpiredProposal(proposalId)) {
            revert ProposalErr(2); // Revert if expired
        }

        // All checks passed, execute the proposal
        if (proposal.proposalType == uint8(ProposalTypes.ProposalType.AddRole) ||
            proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveRole)) {
            _executeCommonProposal(proposalId);
            emit ProposalExecuted(proposalId, proposal.proposalType, proposal.target);
            // Clean up pending proposals if all flags are cleared
            delete pendingProposals[proposal.target];

            // Mark proposal as executed
            proposal.config.status = 1;
            delete proposals[proposalId];
            _removeFromRegistry(proposalId);
        } else if (proposal.proposalType == uint8(ProposalTypes.ProposalType.Upgrade)) {
            // Nothing
        } else if (proposal.proposalType == uint8(ProposalTypes.ProposalType.Recovery)) {
            if(proposal.tokenAddress == address(this)) revert Failed(1);
            if(proposal.amount <= 0) revert AmountMustBePositive();
            
            IERC20 token = IERC20(proposal.tokenAddress);
            uint256 balance = token.balanceOf(address(this));
            if(balance < proposal.amount) revert LowBalance(balance, proposal.amount);
            
            bool success = token.transfer(proposal.target, proposal.amount);
            if (!success) revert Failed(2);
            // Add cleanup
            delete pendingProposals[proposal.target];
            delete proposals[proposalId];
            _removeFromRegistry(proposalId);
            emit ProposalExecuted(proposalId, proposal.proposalType, proposal.target);
        } else {
            _executeCustomProposal(proposalId);
            emit ProposalExecuted(proposalId, proposal.proposalType, proposal.target);
            // Clean up pending proposals if all flags are cleared
            delete pendingProposals[proposal.target];

            // Mark proposal as executed
            proposal.config.status = 1;
            delete proposals[proposalId];
            _removeFromRegistry(proposalId);
        }
    }


    function _executeCommonProposal(bytes32 proposalId) internal {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        if (proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveRole) || proposal.proposalType == uint8(ProposalTypes.ProposalType.AddRole)) {
            address account = proposal.target;
            bytes32 role = proposal.role;

            if (proposal.proposalType == uint8(ProposalTypes.ProposalType.AddRole)) {
                
                _grantRole(role, account);
                if (role == ProposalTypes.ADMIN_ROLE) {
                    ++adminCount;
                }
                
                // Set timelock for new role
                ProposalTypes.TimeConfig storage timeConfig = timeConfigs[account];
                timeConfig.roleChangeTimeLock = uint32(block.timestamp + ProposalTypes.ROLE_CHANGE_DELAY);
                _updateActivityTimestamp();
                emit RU(account, msg.sender, role, true);
            } else if(proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveRole)) {
                if (role == ProposalTypes.ADMIN_ROLE) {
                    if (adminCount <=2) revert MinimumRoleNoRequired();
                    --adminCount;
                }
                _revokeRole(role, account);
                delete timeConfigs[account];
                emit RU(account, msg.sender, role, false);
            }
        }
    }

    function _executeCustomProposal(bytes32 proposalId) internal virtual;

    /// @notice Emergency pause functionality
    /// @param op 1 is pause and 2 is unpause
    function emergencyAction(uint8 op) 
        external 
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        // Cache storage reads
        PackedVars storage vars = packedVars;
        uint256 lastAction = vars.lastEmergencyAction;
        
        if (block.timestamp < lastAction + ProposalTypes.EMERGENCY_COOLDOWN) revert CoolDownActive(lastAction + ProposalTypes.EMERGENCY_COOLDOWN);
        
        // Use TimeConfig struct for time-related values
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        if(op == uint8(1)) 
            _pause();
        else if(op == uint8(2))
             _unpause();
        else
            revert Failed(0);
        vars.lastEmergencyAction = uint40(block.timestamp);
        _updateActivityTimestamp();
        emit EA(op, block.timestamp, msg.sender);
    }

    /// @notice Set quorum for a role which is the number of required votes from that role for a change
    function setRoleQuorum(bytes32 role, uint16 quorum) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (quorum <= 1) revert InvalidQuorumErr(role, quorum);
        
        // Use the packed RoleConfig struct
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[role];
        roleConfig.quorum = quorum;
        _updateActivityTimestamp();
        emit QuorumUpdated(role, quorum);
    }

    /// @notice Internal function to validate timelock
    /// @param account Address to check timelock for
    function _validateTimelock(address account) internal view {
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[account];
        if (block.timestamp < timeConfig.roleChangeTimeLock) {
            revert TimeLockActive(account);
        }
    }

    /// @notice Internal function to validate quorum
    /// @param role Role to check quorum for
    function _validateQuorum(bytes32 role) internal view {
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[role];
        if (roleConfig.quorum < 2) {
            revert InvalidQuorumErr(role, roleConfig.quorum);
        }
    }

    /// @notice checks if conditions for upgrading hte contract is met
    function _checkUpgrade(address newImplementation) 
        internal 
        virtual
        returns (bool)
    {
        if (newImplementation == address(0)) revert InvalidAddress();
        
        // Use RoleConfig struct for role-related values
        ProposalTypes.RoleConfig storage adminConfig = roleConfigs[ProposalTypes.ADMIN_ROLE];
        if (adminConfig.quorum < 2) revert InvalidQuorumErr(ProposalTypes.ADMIN_ROLE, adminConfig.quorum);
        
        // Cache current timestamp
        uint256 currentTime = block.timestamp;
        
        // Find the active upgrade proposal
        bytes32 currentId = upgradeProposals[newImplementation];
        if (currentId == 0) revert ProposalErr(1);
        
        // Cache proposal storage
        ProposalTypes.UnifiedProposal storage currentProposal = proposals[currentId];
        if (_checkExpiredProposal(currentId)) {
            revert ProposalErr(2); // Revert if expired
        }
        
        // Check if proposal is valid
        if (currentProposal.proposalType != uint8(ProposalTypes.ProposalType.Upgrade) || 
            currentProposal.target != newImplementation ||
            currentProposal.config.status != 0 ||  // Check executed flag
            currentProposal.config.expiryTime <= currentTime) {
            revert ProposalErr(1);
        }
        
        // Cache target address
        address target = currentProposal.target;
        if (target == address(0)) revert InvalidAddress();
        
        // Cache required approvals
        uint16 requiredApprovals = adminConfig.quorum;
        if (currentProposal.config.approvals < requiredApprovals) revert InsufficientApprovals(requiredApprovals, currentProposal.config.approvals);
        
        if (currentTime < currentProposal.config.executionTime) revert ExecutionDelayNotMet(currentProposal.config.executionTime);
        
        // Update state
        delete upgradeProposals[newImplementation];
        currentProposal.config.status = 1;  // Set executed flag
        
        // Delete pending proposals if all flags are cleared
        delete pendingProposals[target];
        delete proposals[currentId];
        _removeFromRegistry(currentId);
        _updateActivityTimestamp();
        emit ProposalExecuted(currentId, currentProposal.proposalType, target);
        return true;
    }
}
