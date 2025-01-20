// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./libraries/ProposalTypes.sol";
import "hardhat/console.sol";


abstract contract GovernanceModule is 
    Initializable, 
    OwnableUpgradeable,
    UUPSUpgradeable, 
    PausableUpgradeable, 
    AccessControlEnumerableUpgradeable, 
    ReentrancyGuardUpgradeable
{
    using ProposalTypes for ProposalTypes.UnifiedProposal;
    using ProposalTypes for ProposalTypes.TimeConfig;
    using ProposalTypes for ProposalTypes.RoleConfig;
    using ProposalTypes for ProposalTypes.PendingProposals;
    using ProposalTypes for ProposalTypes.ProposalType;

    // Events
    event RoleUpdated(address target, address caller, bytes32 role, bool status);
    event EmergencyAction(uint8 action, uint256 timestamp, address caller);
    event ProposalCreated(bytes32 indexed proposalId, uint32 version, uint8 indexed proposalType, address indexed target, bytes32 role, uint256 amount, address tokenAddress, address proposer);
    event ProposalApproved(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed approver);
    event ProposalReadyForExecution(bytes32 indexed proposalId, uint8 indexed proposalType);
    event ProposalExpired(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed target);
    event QuorumUpdated(bytes32 indexed role, uint256 newQuorum);
    event TransactionLimitUpdated(bytes32 indexed role, uint256 newLimit);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    // Errors
    error ProposalErr(uint8 err); // 1: not found, 2: expired, 3: ProposalAlreadyExecuted, 4: ProposalAlreadyApproved, 5: DuplicateProposal, 6: UnauthorizedProposalApproverErr
    error InsufficientApprovalsErr(uint16 requiredApprovals, uint16 approvals);
    error InvalidProposalType(uint8 proposalType);
    error ProposalExecutionDelayNotMetErr(uint256 allowedTime);
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

    /// @notice Event emitted when a proposal is executed
    /// @param proposalId The ID of the executed proposal
    /// @param proposalType The type of the executed proposal
    /// @param target The target address affected by the proposal
    event ProposalExecuted(bytes32 indexed proposalId, uint8 indexed proposalType, address indexed target);

    uint32 private constant PROPOSAL_TIMEOUT = 48 hours;

    // Flag Constants
    uint8 constant INITIATED = 1;
    uint8 constant PENDING_OWNERSHIP = 2;
    uint8 constant TGE_INITIATED = 4;

    /// @notice Role constants
    bytes32 public constant BRIDGE_OPERATOR_ROLE = ProposalTypes.BRIDGE_OPERATOR_ROLE;
    bytes32 public constant CONTRACT_OPERATOR_ROLE = ProposalTypes.CONTRACT_OPERATOR_ROLE;
    bytes32 public constant ADMIN_ROLE = ProposalTypes.ADMIN_ROLE;

    // Time Constants
    uint256 private constant ROLE_CHANGE_DELAY = ProposalTypes.ROLE_CHANGE_DELAY;
    uint32 public constant MIN_PROPOSAL_EXECUTION_DELAY = ProposalTypes.MIN_PROPOSAL_EXECUTION_DELAY;
    uint32 public constant INACTIVITY_THRESHOLD = ProposalTypes.INACTIVITY_THRESHOLD;
    uint32 private constant EMERGENCY_COOLDOWN = ProposalTypes.EMERGENCY_COOLDOWN;
    uint8 public constant EMERGENCY_THRESHOLD = ProposalTypes.EMERGENCY_THRESHOLD;

    /// @notice Core storage mappings
    mapping(bytes32 => ProposalTypes.UnifiedProposal) public proposals;
    mapping(address => ProposalTypes.PendingProposals) public pendingProposals;
    mapping(address => ProposalTypes.TimeConfig) public timeConfigs;
    mapping(bytes32 => ProposalTypes.RoleConfig) public roleConfigs;
    mapping(address => bytes32) public upgradeProposals;

    /// @notice Proposal tracking
    uint256 private proposalCount;
    mapping(uint256 => bytes32) private proposalRegistry;

    /// @notice Packed storage variables
    struct PackedVars {
        uint8 flags;
        uint248 lastEmergencyAction;
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
        if (initialOwner == address(0) || initialAdmin == address(0)) 
            revert InvalidAddress();

        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControlEnumerable_init();

        _grantRole(ADMIN_ROLE, initialOwner);
        _grantRole(ADMIN_ROLE, initialAdmin);

        uint256 lockTime = block.timestamp + ROLE_CHANGE_DELAY;
        timeConfigs[initialOwner].roleChangeTimeLock = uint64(lockTime);
        timeConfigs[initialAdmin].roleChangeTimeLock = uint64(lockTime);
    }

    // Proposal helper function
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
        onlyRole(ADMIN_ROLE)
    {
        _validateTimelock(msg.sender);
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[role];
        roleConfig.transactionLimit = limit;
        _updateActivityTimestamp();
        emit TransactionLimitUpdated(role, limit);
    }

    /// @notice Check if an account is active within the threshold
    function checkRoleActivity(address account) 
        external 
        view 
        returns (bool) 
    {
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[account];
        return ((block.timestamp - timeConfig.lastActivityTime) <= INACTIVITY_THRESHOLD);
    }

    /// @notice Get the last activity timestamp for an account
    function getRoleActivity(address account) 
        external 
        view 
        returns (uint64) 
    {
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[account];
        return timeConfig.lastActivityTime;
    }

    /// @notice Get transaction limit for a role
    function getRoleTransactionLimit(bytes32 role) 
        external 
        view 
        returns (uint256) 
    {
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[role];
        return roleConfig.transactionLimit;
    }

    /// @notice Get quorum requirement for a role
    function getRoleQuorum(bytes32 role) 
        external 
        view 
        returns (uint16)
    {
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[role];
        return roleConfig.quorum;
    }

    /// @notice Get pending owner address
    function pendingOwner() public view virtual returns (address) {
        return _pendingOwnerRequest;
    }

    function _initializeProposal(
        ProposalTypes.UnifiedProposal storage proposal,
        address target
    ) internal {
        proposal.target = target;
        proposal.config.expiryTime = uint64(block.timestamp + PROPOSAL_TIMEOUT);
        proposal.config.executionTime = uint64(block.timestamp + MIN_PROPOSAL_EXECUTION_DELAY);
        proposal.config.approvals = 1;
        proposal.hasApproved[msg.sender] = true;
    }

    // Version tracking
    function version() public pure virtual returns (uint32) {
        return 1;
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
        onlyRole(ADMIN_ROLE)
        returns (bytes32)
    {
        if (target == address(0)) revert InvalidAddress();
        
        // Validate timelock and quorum
        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);
        
        // Check for existing proposals
        if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);

        bytes32 proposalId;
        
        if (proposalType == uint8(ProposalTypes.ProposalType.AddRole) || proposalType == uint8(ProposalTypes.ProposalType.RemoveRole)) {
            if (role != ADMIN_ROLE && role != CONTRACT_OPERATOR_ROLE && role != BRIDGE_OPERATOR_ROLE) 
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
        proposalCount += 1;
        pendingProposals[target].proposalType = uint8(proposalType);

        emit ProposalCreated(
            proposalId, 
            version(), 
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
            if (role == ADMIN_ROLE && getRoleMemberCount(ADMIN_ROLE) <= 2) {
                revert MinimumRoleNoRequired();
            }
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

    function _checkExpiredProposal(bytes32 proposalId) internal {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        if (block.timestamp >= proposal.config.expiryTime) {
            // Handle common proposal types
            if (proposal.proposalType == uint8(ProposalTypes.ProposalType.AddRole) || proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveRole)) {
                // Nothing needed for role changes
            } else if (proposal.proposalType == uint8(ProposalTypes.ProposalType.Upgrade)) {
                delete upgradeProposals[proposal.target];
            } else {
                // Let child contracts handle their specific flags
                _handleCustomProposalExpiry(proposalId);
            }

            // Delete entire record
            delete pendingProposals[proposal.target];
            delete proposals[proposalId];
            proposalCount -= 1;
            _removeFromRegistry(proposalId);
            
            emit ProposalExpired(proposalId, proposal.proposalType, proposal.target);
            revert ProposalErr(2);
        }
    }

    function _removeFromRegistry(bytes32 proposalId) internal {
        for (uint256 i = 0; i < proposalCount; i++) {
            if (proposalRegistry[i] == proposalId) {
                // Move last element to current position
                if (i != proposalCount - 1) {
                    proposalRegistry[i] = proposalRegistry[proposalCount - 1];
                }
                // Delete the last element
                delete proposalRegistry[proposalCount - 1];
                proposalCount--;
                break;
            }
        }
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
        onlyRole(ADMIN_ROLE)
    {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalErr(1);
        if (proposal.config.status != 0) revert ProposalErr(3);
        if (proposal.hasApproved[msg.sender]) revert ProposalErr(4);
        
        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);
        
        _checkExpiredProposal(proposalId);
        
        proposal.hasApproved[msg.sender] = true;
        proposal.config.approvals++;
        
        emit ProposalApproved(proposalId, proposal.proposalType, msg.sender);
        
        ProposalTypes.RoleConfig storage adminConfig = roleConfigs[ADMIN_ROLE];
        if (proposal.config.approvals >= adminConfig.quorum && 
            block.timestamp >= proposal.config.executionTime) {
            emit ProposalReadyForExecution(proposalId, proposal.proposalType);
            
            _executeProposal(proposalId);
        }
        _updateActivityTimestamp();
    }

    // Virtual function for child contracts to handle their specific proposal flag cleanup
    function _handleCustomProposalExpiry(bytes32 proposalId) internal virtual {}

    function executeProposal(bytes32 proposalId) 
        public
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
    {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalErr(1);
        
        // Cache storage reads
        ProposalTypes.RoleConfig storage adminConfig = roleConfigs[ADMIN_ROLE];
        if (adminConfig.quorum < 2) revert InvalidQuorumErr(ADMIN_ROLE, adminConfig.quorum);
        
        // Check approvals first
        if (proposal.config.approvals < adminConfig.quorum) revert InsufficientApprovalsErr(adminConfig.quorum, proposal.config.approvals);
        
        // Check execution status
        if (proposal.config.status != 0) revert ProposalErr(3);
        
        // Check execution time and expiry
        if (block.timestamp < proposal.config.executionTime) revert ProposalExecutionDelayNotMetErr(proposal.config.executionTime);

        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);
        
       _executeProposal(proposalId);
        _updateActivityTimestamp();
    }

    function _executeProposal(bytes32 proposalId) 
        internal
        whenNotPaused
        onlyRole(ADMIN_ROLE)
    {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
         _checkExpiredProposal(proposalId);

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
            proposalCount -= 1;
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
        } else {
            _executeCustomProposal(proposalId);
            emit ProposalExecuted(proposalId, proposal.proposalType, proposal.target);
            // Clean up pending proposals if all flags are cleared
            delete pendingProposals[proposal.target];

            // Mark proposal as executed
            proposal.config.status = 1;
            delete proposals[proposalId];
            proposalCount -= 1;
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
                
                // Set timelock for new role
                ProposalTypes.TimeConfig storage timeConfig = timeConfigs[account];
                timeConfig.roleChangeTimeLock = uint32(block.timestamp + ROLE_CHANGE_DELAY);
                _updateActivityTimestamp();
            } else if(proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveRole)) {
                // Prevent removing the last admin
                if (role == ADMIN_ROLE) {
                    // Additional validation for admin role
                    if (getRoleMemberCount(ADMIN_ROLE) <= 2) revert MinimumRoleNoRequired();

                    uint256 activeAdminCount = 0;
                    uint256 adminCount = getRoleMemberCount(ADMIN_ROLE);
                    
                    for (uint256 i = 0; i < adminCount; i++) {
                        address currentAdmin = getRoleMember(ADMIN_ROLE, i);
                        if (currentAdmin != account && 
                            block.timestamp - timeConfigs[currentAdmin].lastActivityTime <= INACTIVITY_THRESHOLD) {
                            activeAdminCount++;
                        }
                    }
                    
                    if (activeAdminCount < ((adminCount - 1) / 2 + 1)) {
                        revert MinimumRoleNoRequired();
                    }
                }
                
                _revokeRole(role, account);
                delete timeConfigs[account];
            }
        }
    }

    function _executeCustomProposal(bytes32 proposalId) internal virtual;

    /// @notice Emergency pause functionality
    /// @param op 1 is pause and 2 is unpause
    function emergencyAction(uint8 op) 
        external 
        nonReentrant
        onlyRole(ADMIN_ROLE)
    {
        // Cache storage reads
        PackedVars storage vars = packedVars;
        uint256 lastAction = vars.lastEmergencyAction;
        
        if (block.timestamp < lastAction + EMERGENCY_COOLDOWN) revert CoolDownActive(lastAction + EMERGENCY_COOLDOWN);
        
        // Use TimeConfig struct for time-related values
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        if(op == uint8(1)) 
            _pause();
        else if(op == uint8(2))
             _unpause();
        else
            revert Failed(0);
        vars.lastEmergencyAction = uint248(block.timestamp);
        _updateActivityTimestamp();
        emit EmergencyAction(op, block.timestamp, msg.sender);
    }

    /// @notice Set quorum for a role
    function setRoleQuorum(bytes32 role, uint16 quorum) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
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

    function getPendingProposals(uint256 offset, uint256 limit) 
        external 
        view
        returns (
            bytes32[] memory proposalIds,
            uint8[] memory types,
            address[] memory targets,
            uint256[] memory expiryTimes,
            uint256 total,
            uint256 totalWithExpired
        ) 
    {
        // Cap the maximum number of proposals that can be returned
        if (limit > 20) revert LimitTooHigh();
        
        // Initialize arrays with the smaller of limit or remaining proposals
        uint256 remaining = proposalCount > offset ? proposalCount - offset : 0;
        uint256 size = remaining < limit ? remaining : limit;
        
        proposalIds = new bytes32[](size);
        types = new uint8[](size);
        targets = new address[](size);
        expiryTimes = new uint256[](size);

        uint256 validCount = 0;
        uint256 skipped = 0;

        // Only iterate through the specified window
        for (uint256 i = 0; i < proposalCount && validCount < size; i++) {
            bytes32 proposalId = proposalRegistry[i];
            ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
            
            // Check if proposal is valid and not expired
            if (proposal.target != address(0) && 
                proposal.config.status == 0 && 
                proposal.config.expiryTime > block.timestamp) 
            {
                // Skip proposals until we reach the offset
                if (skipped < offset) {
                    skipped++;
                    continue;
                }
                
                proposalIds[validCount] = proposalId;
                types[validCount] = proposal.proposalType;
                targets[validCount] = proposal.target;
                expiryTimes[validCount] = proposal.config.expiryTime;
                
                validCount++;
            }
        }

        // Resize arrays to actual count using assembly for gas optimization
        assembly {
            mstore(proposalIds, validCount)
            mstore(types, validCount)
            mstore(targets, validCount)
            mstore(expiryTimes, validCount)
        }

        return (proposalIds, types, targets, expiryTimes, validCount, proposalCount);
    }

    // Helper view function to get specific proposal details
    function getProposalDetails(bytes32 proposalId) 
        external 
        view 
        returns (
            uint8 proposalType,
            address target,
            bytes32 role,
            uint256 amount,
            address tokenAddress,
            uint32 approvals,
            uint256 expiryTime,
            uint256 executionTime,
            uint8 executed,
            bool hasApproved
        ) 
    {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.proposalType == uint8(0)) revert ProposalErr(1);
        return (
            proposal.proposalType,
            proposal.target,
            proposal.role,
            proposal.amount,
            proposal.tokenAddress,
            proposal.config.approvals,
            proposal.config.expiryTime,
            proposal.config.executionTime,
            proposal.config.status,
            proposal.hasApproved[msg.sender]
        );
    }

    function _checkUpgrade(address newImplementation) 
        internal 
        virtual
        returns (bool)
    {
        if (newImplementation == address(0)) revert InvalidAddress();
        
        // Use RoleConfig struct for role-related values
        ProposalTypes.RoleConfig storage adminConfig = roleConfigs[ADMIN_ROLE];
        if (adminConfig.quorum < 2) {
            revert InvalidQuorumErr(ADMIN_ROLE, adminConfig.quorum);
        }
        
        // Cache current timestamp
        uint256 currentTime = block.timestamp;
        
        // Find the active upgrade proposal
        bytes32 currentId = upgradeProposals[newImplementation];
        if (currentId == 0) revert ProposalErr(1);
        
        // Cache proposal storage
        ProposalTypes.UnifiedProposal storage currentProposal = proposals[currentId];
        _checkExpiredProposal(currentId);
        
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
        if (currentProposal.config.approvals < requiredApprovals) {
            revert InsufficientApprovalsErr(requiredApprovals, currentProposal.config.approvals);
        }
        
        if (currentTime < currentProposal.config.executionTime) {
            revert ProposalExecutionDelayNotMetErr(currentProposal.config.executionTime);
        }
        
        // Update state
        delete upgradeProposals[newImplementation];
        currentProposal.config.status == 1;  // Set executed flag
        
        // Delete pending proposals if all flags are cleared
        delete pendingProposals[target];
        delete proposals[currentId];
        proposalCount -= 1;
        _removeFromRegistry(currentId);
        _updateActivityTimestamp();
        emit ProposalExecuted(currentId, currentProposal.proposalType, target);
        return true;
    }
}
