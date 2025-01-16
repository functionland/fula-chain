// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

contract StorageToken is Initializable, ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, PausableUpgradeable, AccessControlEnumerableUpgradeable, ReentrancyGuardUpgradeable {
    // Constants for flags
    uint8 constant WHITELIST_FLAG = 1;
    uint8 constant ROLE_CHANGE_FLAG = 2;
    uint8 constant RECOVERY_FLAG = 4;
    uint8 constant UPGRADE_FLAG = 8;
    
    uint8 constant ISADD_FLAG = 1;
    uint8 constant EXECUTED_FLAG = 2;
    uint8 constant ISREMOVED_FLAG = 4;

    uint8 constant INITIATED = 1;
    uint8 constant PENDING_OWNERSHIP = 2;

    // Enums packed as uint8
    enum ContractType { Pool, Proof, Staking, Distribution, Reward }
    enum ProposalType { RoleChange, Upgrade, Recovery, Whitelist }

    // Core storage variables
    address private _pendingOwner;
    uint256 private constant TOKEN_UNIT = 10**18;
    uint256 private constant TOTAL_SUPPLY = 2_000_000_000 * TOKEN_UNIT;
    uint256 private constant ROLE_CHANGE_DELAY = 1 days;
    uint256 private constant WHITELIST_LOCK_DURATION = 1 days;

    // Packed time-related constants
    uint32 public constant MIN_PROPOSAL_EXECUTION_DELAY = 24 hours;
    uint32 public constant INACTIVITY_THRESHOLD = 365 days;
    uint32 private constant EMERGENCY_COOLDOWN = 30 minutes;
    uint8 public constant EMERGENCY_THRESHOLD = 3;

    // Packed storage structs
    struct PackedVars {
        uint248 lastEmergencyAction;
        uint8 flags;  // includes _initializedMint
    }
    PackedVars private packedVars;

    struct TimeConfig {
        uint64 lastActivityTime;
        uint64 roleChangeTimeLock;
        uint64 whitelistLockTime;
    }

    struct RoleConfig {
        uint32 quorum;
        uint256 transactionLimit;
    }

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

    // Core storage mappings
    mapping(uint256 => mapping(uint256 => bool)) private _usedNonces;
    mapping(address => bytes32) private upgradeProposals;
    mapping(bytes32 => UnifiedProposal) public proposals;
    mapping(address => PendingProposals) public pendingProposals;
    mapping(address => TimeConfig) public timeConfigs;
    mapping(bytes32 => RoleConfig) public roleConfigs;
    mapping(uint256 => bool) public supportedChains;
    mapping(address => uint256) public emergencyVotes;
    mapping(uint256 => bytes32) private proposalRegistry;

    // Proposal-related storage
    uint256 public proposalTimeout;
    uint256 private proposalCount;

    // Role constants
    bytes32 public constant BRIDGE_OPERATOR_ROLE = bytes32(uint256(keccak256("BRIDGE_OPERATOR_ROLE")) - 1);
    bytes32 public constant ADMIN_ROLE = bytes32(uint256(keccak256("ADMIN_ROLE")) - 1);
    bytes32 public constant CONTRACT_OPERATOR_ROLE = bytes32(uint256(keccak256("CONTRACT_OPERATOR_ROLE")) - 1);

    // Events
    event RoleUpdated(address target, address caller, bytes32 role, bool status);
    event EmergencyAction(string action, uint256 timestamp, address caller);
    event BridgeOperationDetails(address indexed operator, string operation, uint256 amount, uint256 chainId, uint256 timestamp);
    event WalletWhitelistedWithLock(address indexed wallet, uint256 lockUntil, address caller);
    event WalletRemovedFromWhitelist(address indexed wallet, address caller);
    event TransferFromContract(address indexed from, address indexed to, uint256 amount, address caller);
    event TokensMinted(address to, uint256 amount);
    event SupportedChainChanged(uint256 indexed chainId, bool supported, address caller);
    event ProposalCreated(bytes32 indexed proposalId, uint32 version, ProposalType indexed proposalType, address indexed target, bytes32 role, uint256 amount, address tokenAddress, bool isAdd, address proposer);
    event ProposalApproved(bytes32 indexed proposalId, ProposalType indexed proposalType, address indexed approver);
    event ProposalReadyForExecution(bytes32 indexed proposalId, ProposalType indexed proposalType);
    event ProposalExecuted(bytes32 indexed proposalId, ProposalType indexed proposalType, address indexed target);
    event ProposalExpired(bytes32 indexed proposalId, ProposalType indexed proposalType, address indexed target);
    event QuorumUpdated(bytes32 indexed role, uint256 newQuorum);
    event TransactionLimitUpdated(bytes32 indexed role, uint256 newLimit);

    // Errors
    error ExceedsMaximumSupply(uint256 requested, uint256 maxSupply);
    error ExceedsAvailableSupply(uint256 requested, uint256 supply);
    error AmountMustBePositive();
    error UnsupportedChain(uint256 chain);
    error TokenPaused();
    error InsufficientAllowance(address spender, uint256 amount);
    error UnauthorizedTransfer(address sender);
    error TimeLockActive(address operator);
    error ProposalNotFoundErr();
    error ProposalExpiredErr();
    error ProposalAlreadyExecutedErr();
    error ProposalAlreadyApprovedErr();
    error InsufficientApprovalsErr(uint32 requiredApprovals, uint32 approvals);
    error InvalidProposalTypeErr(ProposalType proposalType);
    error DuplicateProposalErr(ProposalType proposalType, address target);
    error ProposalExecutionDelayNotMetErr(uint256 allowedTime);
    error UnauthorizedProposalApproverErr();
    error InvalidQuorumErr(bytes32 role, uint32 quorum);
    error NotWhitelisted(address to);
    error ExistingActiveProposal(address target);
    error RecipientLocked(address to);
    error InvalidAddress(address wallet);
    error LowAllowance(uint256 allowance, uint256 limit);
    error LowBalance(uint256 walletBalance, uint256 requiredBalance);
    error CoolDownActive(uint256 waitUntil);
    error AlreadyWhitelisted(address target);
    error AlreadyOwnsRole(address target);
    error INVALIDFLAG(uint8 flags);
    error InvalidChainId(uint256 chainId);
    error UsedNonce(uint256 nonce);
    error MinimumRoleNoRequired();
    error CannotRemoveSelf();
    error Failed();
    error AlreadyUpgraded();
    error InvalidRole(bytes32 role);
    error UseTransferFromContractInstead();
    error LimitTooHigh();

    // Ensures address is not zero
    modifier validateAddress(address _address) {
        if (_address == address(0)) revert InvalidAddress(_address);
        _;
    }

    // onlyWhitelisted checks to ensure only white-listed recipients and only after time lock period are allowed
    modifier onlyWhitelisted(address to) {
        // Use TimeConfig struct for whitelist lock time
        TimeConfig storage timeConfig = timeConfigs[to];
        uint64 lockTime = timeConfig.whitelistLockTime;
        
        if (lockTime == 0) revert NotWhitelisted(to);
        if (block.timestamp < lockTime) revert RecipientLocked(to);
        _;
    }

    // Update the last activity that an address has done
    modifier updateActivityTimestamp() {
        // Use TimeConfig struct for activity timestamp
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        timeConfig.lastActivityTime = uint64(block.timestamp);
        _;
    }

    function initialize(
        address initialOwner, 
        address initialAdmin, 
        uint256 initialMintedTokens
    ) public reinitializer(1) {
        // Combine validation checks
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress(address(0));
        if (initialAdmin == address(0)) revert InvalidAddress(initialAdmin);
        if (initialMintedTokens > TOTAL_SUPPLY) revert("Exceeds maximum supply");
        
        // Initialize contracts
        __ERC20_init("Placeholder Token", "PLACEHOLDER");
        __UUPSUpgradeable_init();
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControlEnumerable_init();
        
        // Grant roles
        _grantRole(ADMIN_ROLE, initialOwner);
        _grantRole(ADMIN_ROLE, initialAdmin);

        // Set timelocks using packed TimeConfig struct
        uint256 lockTime = block.timestamp + ROLE_CHANGE_DELAY;
        
        TimeConfig storage ownerTimeConfig = timeConfigs[initialOwner];
        ownerTimeConfig.roleChangeTimeLock = uint64(lockTime);
        
        TimeConfig storage adminTimeConfig = timeConfigs[initialAdmin];
        adminTimeConfig.roleChangeTimeLock = uint64(lockTime);
        
        // Initialize mint if not already done
        PackedVars storage vars = packedVars;
        if ((vars.flags & INITIATED) == 0) {  // Check initialization flag
            _mint(address(this), initialMintedTokens);
            proposalCount = 0;
            proposalTimeout = 48 hours;
            emit TokensMinted(address(this), initialMintedTokens);
            vars.flags |= INITIATED;  // Set initialization flag
        }
    }

    function version() public pure returns (uint32) {
        return 1;
    }

    function tokenUnit() public pure returns (uint256) {
        unchecked {
            return TOKEN_UNIT;  // Use the constant directly instead of calculation
        }
    }

    function maxSupply() public pure returns (uint256) {
        unchecked {
            return TOTAL_SUPPLY;
        }
    }

    function transferOwnership(address newOwner) 
        public 
        virtual 
        override 
        whenNotPaused 
        nonReentrant 
        onlyOwner 
    {
        if (newOwner == address(0)) revert InvalidAddress(newOwner);
        
        // Use packed storage for pending owner
        PackedVars storage vars = packedVars;
        vars.flags |= PENDING_OWNERSHIP;  // Set pending owner flag
        _pendingOwner = newOwner;
    }

    function acceptOwnership() 
        public 
        virtual 
        whenNotPaused 
        nonReentrant
    {
        // Cache storage reads
        address pendingOwner = _pendingOwner;
        if (msg.sender != pendingOwner) revert("Not pending owner");
        
        // Clear pending owner flag and storage
        PackedVars storage vars = packedVars;
        vars.flags &= PENDING_OWNERSHIP;
        
        delete _pendingOwner;
        
        _transferOwnership(msg.sender);
    }

    function createProposal(
        ProposalType proposalType,
        address target,
        bytes32 role,
        uint256 amount,
        address tokenAddress,
        bool isAdd
    ) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
        returns (bytes32)
    {
        if (target == address(0)) revert InvalidAddress(target);
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        RoleConfig storage adminConfig = roleConfigs[ADMIN_ROLE];
        if (adminConfig.quorum < 2) revert InvalidQuorumErr(ADMIN_ROLE, adminConfig.quorum);
        
        // Validate based on proposal type also ensure no duplicate proposal is created
        if (proposalType == ProposalType.Whitelist) {
            TimeConfig storage targetTimeConfig = timeConfigs[target];
            if (targetTimeConfig.whitelistLockTime != 0) revert AlreadyWhitelisted(target);
            if (pendingProposals[target].flags & WHITELIST_FLAG != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.RoleChange) {
            TimeConfig storage targetTimeConfig = timeConfigs[target];
            if (targetTimeConfig.roleChangeTimeLock != 0) revert AlreadyOwnsRole(target);
            if (role != ADMIN_ROLE && role != CONTRACT_OPERATOR_ROLE && role != BRIDGE_OPERATOR_ROLE) revert InvalidRole(role);
            if (pendingProposals[target].flags & ROLE_CHANGE_FLAG != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.Recovery) {
            if(tokenAddress == address(this)) revert UseTransferFromContractInstead();
            if (amount <= 0) revert AmountMustBePositive();
            if (pendingProposals[target].flags & RECOVERY_FLAG != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.Upgrade) {
            if (target == address(this)) revert AlreadyUpgraded();
            if (pendingProposals[target].flags & UPGRADE_FLAG != 0) revert ExistingActiveProposal(target);
        } else {
            revert InvalidProposalTypeErr(proposalType);
        }

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
        if (proposal.executionTime != 0) revert DuplicateProposalErr(proposalType, target);

        // Pack the proposal data
        proposal.target = target;
        proposal.tokenAddress = tokenAddress;
        proposal.role = role;
        proposal.amount = amount;
        proposal.expiryTime = block.timestamp + proposalTimeout;
        proposal.executionTime = block.timestamp + MIN_PROPOSAL_EXECUTION_DELAY;
        proposal.approvals = 1;
        proposal.proposalType = uint8(proposalType);  // Convert enum to uint8
        proposal.flags = isAdd ? ISADD_FLAG : ISREMOVED_FLAG;  // Pack bool into flags
        proposal.hasApproved[msg.sender] = true;

        // Update pending proposals flags
        uint8 flag;
        if (proposalType == ProposalType.Whitelist) {
            flag = WHITELIST_FLAG;
        } else if(proposalType == ProposalType.RoleChange) {
            flag = ROLE_CHANGE_FLAG;
        } else if (proposalType == ProposalType.Recovery) {
            flag = RECOVERY_FLAG;
        } else {
            flag = UPGRADE_FLAG;
            upgradeProposals[target] = proposalId;
        }
        pendingProposals[target].flags |= flag;

        proposalRegistry[proposalCount] = proposalId;
        proposalCount += 1;

        emit ProposalCreated(proposalId, version(), proposalType, target, role, amount, tokenAddress, isAdd, msg.sender);
        return proposalId;
    }

    function approveProposal(bytes32 proposalId)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp
    {
        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalNotFoundErr();
        if ((proposal.flags & EXECUTED_FLAG) != 0) revert ProposalAlreadyExecutedErr();
        if (proposal.hasApproved[msg.sender]) revert ProposalAlreadyApprovedErr();
        
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        RoleConfig storage adminConfig = roleConfigs[ADMIN_ROLE];
        if (adminConfig.quorum < 2) {
            revert InvalidQuorumErr(ADMIN_ROLE, adminConfig.quorum);
        }
        
        if (block.timestamp >= proposal.expiryTime) {
            // Delete the proposal if the expiry is passed
            PendingProposals storage pending = pendingProposals[proposal.target];
            uint8 proposalFlag;
            
            // Determine which flag to clear based on proposal type
            if (uint8(proposal.proposalType) == uint8(ProposalType.Whitelist)) {
                proposalFlag = WHITELIST_FLAG;
            } else if (uint8(proposal.proposalType) == uint8(ProposalType.RoleChange)) {
                proposalFlag = ROLE_CHANGE_FLAG;
            } else if (uint8(proposal.proposalType) == uint8(ProposalType.Recovery)) {
                proposalFlag = RECOVERY_FLAG;
            } else {
                proposalFlag = UPGRADE_FLAG;
                delete upgradeProposals[proposal.target];
            }
            
            pending.flags &= ~proposalFlag;

            // Delete entire record if all flags are cleared
            if (pending.flags == 0) {
                delete pendingProposals[proposal.target];
            }
            
            delete proposals[proposalId];
            proposalCount -= 1;
            emit ProposalExpired(proposalId, ProposalType(proposal.proposalType), proposal.target);
            revert ProposalExpiredErr();
        }
        
        proposal.hasApproved[msg.sender] = true;
        proposal.approvals++;
        
        emit ProposalApproved(proposalId, ProposalType(proposal.proposalType), msg.sender);
        
        if (proposal.approvals >= adminConfig.quorum && 
            block.timestamp >= proposal.executionTime) {
            emit ProposalReadyForExecution(proposalId, ProposalType(proposal.proposalType));
            _executeProposal(proposalId);
        }
    }

    function executeProposal(bytes32 proposalId) 
        external
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp
    {
        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalNotFoundErr();
        
        // Cache storage reads
        RoleConfig storage adminConfig = roleConfigs[ADMIN_ROLE];
        if (adminConfig.quorum < 2) revert InvalidQuorumErr(ADMIN_ROLE, adminConfig.quorum);
        
        // Check approvals first
        uint32 currentApprovals = proposal.approvals;
        uint32 requiredQuorum = adminConfig.quorum;
        if (currentApprovals < requiredQuorum) {
            revert InsufficientApprovalsErr(currentApprovals, requiredQuorum);
        }
        
        // Then check execution status
        if ((proposal.flags & EXECUTED_FLAG) != 0) {
            revert ProposalAlreadyExecutedErr();
        }
        
        // Finally check execution time
        if (block.timestamp < proposal.executionTime) {
            revert ProposalExecutionDelayNotMetErr(proposal.executionTime);
        }
        
        // All checks passed, execute the proposal
        _executeProposal(proposalId);
    }


    function _executeProposal(bytes32 proposalId) internal {
        UnifiedProposal storage proposal = proposals[proposalId];
        PendingProposals storage pending = pendingProposals[proposal.target];
        
        // Cache commonly used values
        address target = proposal.target;
        uint8 proposalTypeVal = uint8(proposal.proposalType);
        
        if (proposalTypeVal == uint8(ProposalType.Whitelist)) {
            // Pack time configurations into TimeConfig struct
            TimeConfig storage timeConfig = timeConfigs[target];
            timeConfig.whitelistLockTime = uint64(block.timestamp + WHITELIST_LOCK_DURATION);
            pending.flags &= ~WHITELIST_FLAG;
        } 
        else if (proposalTypeVal == uint8(ProposalType.RoleChange)) {
            if ((proposal.flags & ISADD_FLAG) != 0) {  // Check isAdd from packed flags
                _grantRole(proposal.role, target);
                // Pack time configurations
                TimeConfig storage timeConfig = timeConfigs[target];
                timeConfig.roleChangeTimeLock = uint64(block.timestamp + ROLE_CHANGE_DELAY);
            } else if ((proposal.flags & ISREMOVED_FLAG) != 0) {
                _revokeRole(proposal.role, target);
                TimeConfig storage timeConfig = timeConfigs[target];
                if (timeConfig.roleChangeTimeLock > 0) {
                    timeConfig.roleChangeTimeLock = 0;
                }
            } else {
                revert INVALIDFLAG(proposal.flags);
            }
            pending.flags &= ~ROLE_CHANGE_FLAG;
        }
        else if (proposalTypeVal == uint8(ProposalType.Recovery)) {
            IERC20 token = IERC20(proposal.tokenAddress);
            bool success = token.transfer(target, proposal.amount);
            if ( !success ) revert Failed();
            pending.flags &= ~RECOVERY_FLAG;
        }

        // Optimize flag checking by using single uint8 comparison
        if (pending.flags == 0) {
            delete pendingProposals[target];
        }
        
        // Check upgrade flag using bitwise operation
        if ((pending.flags & UPGRADE_FLAG) == 0) {
            // Set executed flag in packed flags
            proposal.flags |= EXECUTED_FLAG;  // Set executed bit
            emit ProposalExecuted(proposalId, ProposalType(proposalTypeVal), target);
        }
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
        bool isAddFlg = false;
        if (isAdded) {isAddFlg = true;}
        else if (isRemoved)  {isAddFlg = false;}

        return (
            proposal.proposalType,
            proposal.target,
            proposal.role,
            proposal.amount,
            proposal.tokenAddress,
            isAddFlg,  // isAdd flag
            proposal.approvals,
            proposal.expiryTime,
            proposal.executionTime,
            (proposal.flags & EXECUTED_FLAG) != 0,  // executed flag
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
        // Cap the maximum number of proposals that can be returned
        if (limit > 20) revert LimitTooHigh();
        
        // Initialize arrays with the smaller of limit or remaining proposals
        uint256 remaining = proposalCount > offset ? proposalCount - offset : 0;
        uint256 size = remaining < limit ? remaining : limit;
        
        proposalIds = new bytes32[](size);
        types = new uint8[](size);
        targets = new address[](size);
        expiryTimes = new uint256[](size);
        executed = new bool[](size);

        uint256 validCount = 0;
        uint256 skipped = 0;

        // Only iterate through the specified window
        for (uint256 i = 0; i < proposalCount && validCount < size; i++) {
            bytes32 proposalId = proposalRegistry[i];
            UnifiedProposal storage proposal = proposals[proposalId];
            
            bool isExecuted = (proposal.flags & EXECUTED_FLAG) != 0;
            
            if (proposal.target != address(0) && 
                !isExecuted && 
                proposal.expiryTime > block.timestamp) {
                
                // Skip proposals until we reach the offset
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

        // Resize arrays
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

    // Remove a wallet from the whitelist to remove the permission of receiving tokens from contract
    function removeFromWhitelist(address wallet) external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        // Cache storage reads
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        if (wallet == address(0)) revert InvalidAddress(wallet);
        
        // Update packed time configurations
        TimeConfig storage walletTimeConfig = timeConfigs[wallet];
        walletTimeConfig.whitelistLockTime = 0;
        
        emit WalletRemovedFromWhitelist(wallet, msg.sender);
    }

    // Role quorum management
    function setRoleQuorum(bytes32 role, uint32 quorum) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        if (quorum <= 1) revert InvalidQuorumErr(role, quorum);
        
        // Use the packed RoleConfig struct
        RoleConfig storage roleConfig = roleConfigs[role];
        roleConfig.quorum = quorum;
        
        emit QuorumUpdated(role, quorum);
    }

    // Transaction limit management
    function setRoleTransactionLimit(bytes32 role, uint256 limit) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        // Use the packed RoleConfig struct
        RoleConfig storage roleConfig = roleConfigs[role];
        roleConfig.transactionLimit = limit;
        
        emit TransactionLimitUpdated(role, limit);
    }

    // Pausing contract actions in emergency
    function emergencyPauseToken() 
        external 
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        // Cache storage reads
        PackedVars storage vars = packedVars;
        uint256 lastAction = vars.lastEmergencyAction;
        
        if (block.timestamp < lastAction + EMERGENCY_COOLDOWN) revert CoolDownActive(lastAction + EMERGENCY_COOLDOWN);
        
        // Use TimeConfig struct for time-related values
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        _pause();
        vars.lastEmergencyAction = uint248(block.timestamp);
        
        emit EmergencyAction("Contract paused", block.timestamp, msg.sender);
    }

    function emergencyUnpauseToken() 
        external 
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        // Cache storage reads
        PackedVars storage vars = packedVars;
        uint256 lastAction = vars.lastEmergencyAction;
        
        if (block.timestamp < lastAction + EMERGENCY_COOLDOWN) revert CoolDownActive(lastAction + EMERGENCY_COOLDOWN);
        
        // Use TimeConfig struct for time-related values
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        _unpause();
        
        // Update packed emergency action time
        vars.lastEmergencyAction = uint248(block.timestamp);
        
        emit EmergencyAction("Contract unpaused", block.timestamp, msg.sender);
    }

    /**
     * @dev Removes an admin after ensuring the time lock has expired.
     * Uses `_revokeRole` because additional custom logic (time lock) is implemented. It also requires at least one admin and the last admin cannot be removed
    */
    function removeAdmin(address admin) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        if (admin == msg.sender) revert CannotRemoveSelf();
        if (admin == address(0)) revert InvalidAddress(admin);
        
        // Check timelock
        TimeConfig storage senderTimeConfig = timeConfigs[msg.sender];
        if (block.timestamp < senderTimeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        // Count active admins
        uint256 adminCount = getRoleMemberCount(ADMIN_ROLE);
        uint256 activeAdminCount = 0;
        
        for (uint256 i = 0; i < adminCount; i++) {
            address currentAdmin = getRoleMember(ADMIN_ROLE, i);
            if (currentAdmin != admin && // Don't count the admin being removed
                block.timestamp - timeConfigs[currentAdmin].lastActivityTime <= INACTIVITY_THRESHOLD) {
                activeAdminCount++;
            }
        }
        
        // Calculate minimum required active admins (floor(total_admins/2) + 1)
        uint256 minRequiredActiveAdmins = (adminCount - 1) / 2 + 1;
        
        // Ensure we maintain minimum active admins after removal
        if (activeAdminCount < minRequiredActiveAdmins) {
            revert MinimumRoleNoRequired();
        }
        
        _revokeRole(ADMIN_ROLE, admin);
        
        // Update admin's time config
        TimeConfig storage adminTimeConfig = timeConfigs[admin];
        if (adminTimeConfig.roleChangeTimeLock > 0) {
            adminTimeConfig.roleChangeTimeLock = 0;
        }
        
        emit RoleUpdated(admin, msg.sender, ADMIN_ROLE, false);
    }

    // Transfers tokens from contract to a whitelisted address (after the lock time has passed)
    function transferFromContract(address to, uint256 amount) 
        external 
        virtual 
        whenNotPaused 
        nonReentrant 
        onlyRole(CONTRACT_OPERATOR_ROLE) 
        onlyWhitelisted(to)
        updateActivityTimestamp 
        returns (bool) 
    {
        // Use TimeConfig struct for time-related values
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        if (amount <= 0) revert AmountMustBePositive();
        
        // Cache balance check
        uint256 contractBalance = balanceOf(address(this));
        if (amount > contractBalance) revert ExceedsAvailableSupply(amount, contractBalance);
        
        // Use RoleConfig struct for role-related values
        RoleConfig storage roleConfig = roleConfigs[CONTRACT_OPERATOR_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);
        
        _transfer(address(this), to, amount);
        emit TransferFromContract(address(this), to, amount, msg.sender);
        return true;
    }

    // Transfer from caller to an address if contract is not paused
    function transfer(address to, uint256 amount) 
        public 
        virtual 
        override 
        whenNotPaused 
        nonReentrant
        updateActivityTimestamp 
        returns (bool) 
    {
        // Combine validation checks into a single require to save gas
        if (to == address(0)) revert InvalidAddress(to);
        if (amount <= 0) revert AmountMustBePositive();
        
        // Update activity timestamp in TimeConfig struct
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        timeConfig.lastActivityTime = uint64(block.timestamp);
        
        return super.transfer(to, amount);
    }

    // Mint Tokens to this address if it does not exceed total supply (Tokens should have been burnt on source chain before calling this method). This is for cross-chain transfer of tokens
    function bridgeMint(uint256 amount, uint256 sourceChain, uint256 nonce) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(BRIDGE_OPERATOR_ROLE)
        updateActivityTimestamp 
    {
        // Cache storage reads
        if (_usedNonces[sourceChain][nonce]) revert UsedNonce(nonce);
        if (!supportedChains[sourceChain]) revert UnsupportedChain(sourceChain);
        
        // Use TimeConfig struct for time-related values
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        if (amount == 0) revert AmountMustBePositive();
        
        // Cache total supply
        uint256 currentSupply = totalSupply();
        if (currentSupply + amount > TOTAL_SUPPLY) {
            revert ExceedsMaximumSupply(amount, TOTAL_SUPPLY);
        }

        // Use RoleConfig struct for role-related values
        RoleConfig storage roleConfig = roleConfigs[BRIDGE_OPERATOR_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);

        // Update state
        _mint(address(this), amount);
        _usedNonces[sourceChain][nonce] = true;
        
        emit BridgeOperationDetails(msg.sender, "MINT", amount, sourceChain, block.timestamp);
    }

    // burn tokens on this chain so that mint be called on the target chain and tokens be minted on target chain. This is for cross-chain transfer of tokens
    function bridgeBurn(uint256 amount, uint256 targetChain, uint256 nonce) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(BRIDGE_OPERATOR_ROLE)
        updateActivityTimestamp 
    {
        if (_usedNonces[targetChain][nonce]) revert UsedNonce(nonce);
        if (!supportedChains[targetChain]) revert UnsupportedChain(targetChain);
        
        // Use TimeConfig struct for time-related values
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        if (amount == 0) revert AmountMustBePositive();
        
        // Cache balance check
        uint256 contractBalance = balanceOf(address(this));
        if (contractBalance < amount) revert LowBalance(contractBalance, amount);

        // Use RoleConfig struct for role-related values
        RoleConfig storage roleConfig = roleConfigs[BRIDGE_OPERATOR_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);

        _burn(address(this), amount);
        _usedNonces[targetChain][nonce] = true;
        
        emit BridgeOperationDetails(msg.sender, "BURN", amount, targetChain, block.timestamp);
    }

    // Add function to manage supported chains for cross-chain mint and burn
    function setSupportedChain(uint256 chainId, bool supported) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        // Use TimeConfig struct for time-related values
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        if (chainId <= 0) revert InvalidChainId(chainId);
        
        // Update supported chains mapping
        supportedChains[chainId] = supported;
        
        emit SupportedChainChanged(chainId, supported, msg.sender);
    }

    // Activity monitoring functions
    function checkRoleActivity(address account) 
        external 
        view 
        returns (bool) 
    {
        // Use TimeConfig struct for activity time
        TimeConfig storage timeConfig = timeConfigs[account];
        return block.timestamp - timeConfig.lastActivityTime <= INACTIVITY_THRESHOLD;
    }

    function getRoleActivity(address account) 
        external 
        view 
        returns (uint64) 
    {
        // Use TimeConfig struct for activity time
        TimeConfig storage timeConfig = timeConfigs[account];
        return timeConfig.lastActivityTime;
    }

    // Role transaction limit getter
    function getRoleTransactionLimit(bytes32 role) 
        external 
        view 
        returns (uint256) 
    {
        // Use RoleConfig struct for transaction limit
        RoleConfig storage roleConfig = roleConfigs[role];
        return roleConfig.transactionLimit;
    }

    // Role quorum getter
    function getRoleQuorum(bytes32 role) 
        external 
        view 
        returns (uint32) // Changed return type to uint32
    {
        // Use RoleConfig struct for quorum
        RoleConfig storage roleConfig = roleConfigs[role];
        return roleConfig.quorum;
    }

    function _authorizeUpgrade(address newImplementation) 
        internal 
        override 
        nonReentrant
        whenNotPaused
        onlyRole(ADMIN_ROLE) 
        updateActivityTimestamp 
    {
        if (newImplementation == address(0)) revert InvalidAddress(newImplementation);
        
        // Use RoleConfig struct for role-related values
        RoleConfig storage operatorConfig = roleConfigs[CONTRACT_OPERATOR_ROLE];
        if (operatorConfig.quorum < 2) {
            revert InvalidQuorumErr(CONTRACT_OPERATOR_ROLE, operatorConfig.quorum);
        }
        
        // Cache current timestamp
        uint256 currentTime = block.timestamp;
        
        // Find the active upgrade proposal
        bytes32 currentId = upgradeProposals[newImplementation];
        if (currentId == 0) revert ProposalNotFoundErr();
        
        // Cache proposal storage
        UnifiedProposal storage currentProposal = proposals[currentId];
        
        // Check if proposal is valid
        if (currentProposal.proposalType != uint8(ProposalType.Upgrade) || 
            currentProposal.target != newImplementation ||
            (currentProposal.flags & EXECUTED_FLAG) != 0 ||  // Check executed flag
            currentProposal.expiryTime <= currentTime) {
            revert ProposalNotFoundErr();
        }
        
        // Cache target address
        address target = currentProposal.target;
        if (target == address(0)) revert InvalidAddress(target);
        
        // Cache required approvals
        uint32 requiredApprovals = operatorConfig.quorum;
        if (currentProposal.approvals < requiredApprovals) {
            revert InsufficientApprovalsErr(requiredApprovals, currentProposal.approvals);
        }
        
        if (currentTime < currentProposal.executionTime) {
            revert ProposalExecutionDelayNotMetErr(currentProposal.executionTime);
        }
        
        // Update state
        delete upgradeProposals[newImplementation];
        currentProposal.flags |= EXECUTED_FLAG;  // Set executed flag
        
        // Update pending proposals
        PendingProposals storage pending = pendingProposals[target];
        pending.flags &= ~UPGRADE_FLAG;
        
        // Delete pending proposals if all flags are cleared
        if (pending.flags == 0) {
            delete pendingProposals[target];
        }
        
        emit ProposalExecuted(currentId, ProposalType(currentProposal.proposalType), target);
    }

    uint256[45] private __gap; // Reduced gap size to accommodate new storage variables
}