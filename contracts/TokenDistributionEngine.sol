// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "hardhat/console.sol";

contract TokenDistributionEngine is Initializable, IERC20Metadata, ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, PausableUpgradeable, AccessControlEnumerableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint256 private constant ROLE_CHANGE_DELAY = 1 days;
    uint256 public constant INACTIVITY_THRESHOLD = 365 days;
    uint256 private constant EMERGENCY_COOLDOWN = 30 minutes;


    IERC20 public storageToken;
    // multi -sig variable definitions

    uint8 constant UPGRADE_FLAG = 1;
    uint8 constant ADDWALLET_FLAG = 2;
    uint8 constant REMOVEWALLET_FLAG = 4;
    uint8 constant EXECUTED_FLAG = 8;
    uint8 constant ADDROLE_FLAG = 16;
    uint8 constant REMOVEROLE_FLAG = 32;
    uint8 constant PENDING_OWNERSHIP = 2;
    uint8 constant PROPOSED_ADD = 1;
    uint8 constant PROPOSED_REMOVE = 2;
    address private _pendingOwner;
    struct ProposalConfig {
        uint32 approvals;
        uint64 expiryTime;
        uint64 executionTime;
    }
    struct UnifiedProposal {
        uint8 flags;             // Packed flags
        bytes32 role;
        uint256 capId;                    // Cap ID for wallet operations
        uint256[] allocations;            // Token allocations for wallets
        address target;                    // Target address for upgrades/wallet operations
        bytes32[] names;                   // Names for wallets
        address[] wallets;                // Wallet addresses
        ProposalConfig config;            // Packed configuration
        mapping(address => bool) hasApproved;  // Approval tracking
    }
    struct PendingProposals {
        uint8 flags;
    }
    uint256 private constant MIN_PROPOSAL_EXECUTION_DELAY = 1 days;
    uint256 public constant PROPOSAL_TIMEOUT = 3 days;
    mapping(bytes32 => UnifiedProposal) public proposals;
    mapping(address => PendingProposals) public pendingProposals;
    uint256 private proposalCount;
    mapping(uint256 => bytes32) private proposalRegistry;

    struct VestingCap {
        uint256 totalAllocation;
        uint256 cliff; // in days
        uint256 vestingTerm; // in months
        uint256 vestingPlan; // in months
        uint256 initialRelease; // percentage (e.g., 10% = 10)
        uint256 startDate; // TGE start date
    }

    mapping(uint256 => VestingCap) public vestingCaps;
    mapping(uint256 => address[]) public capWallets;
    mapping(address => mapping(uint256 => uint256)) public claimedTokens;
    mapping(address => mapping(uint256 => uint256)) public allocatedTokens; // Allocated tokens per wallet per cap
    mapping(address => mapping(uint256 => uint8)) public proposedWallets; // Proposed allocation for tokens per wallet per cap
    mapping(address => bytes32) public upgradeProposals;
    mapping(uint256 => uint256) public allocatedTokensPerCap; // Allocated tokens per cap
    mapping(address => mapping(uint256 => bytes32)) public walletNames; // tag the wallet of each receiver
    mapping(address => mapping(uint256 => bytes32)) public activeProposals;
    bool public tgeInitiated;
    uint256[] public capIds;
    uint256 public totalTransferredTokens;
    uint256 public totalAllocatedToWallets;

    struct TimeConfig {
        uint32 roleChangeTimeLock;
        uint64 lastActivityTime;
    }
    mapping(address => TimeConfig) public timeConfigs;
    struct RoleConfig {
        uint8 quorum;
        uint248 transactionLimit;
    }
    mapping(bytes32 => RoleConfig) public roleConfigs;

    // Packed storage structs
    struct PackedVars {
        uint8 flags;  // includes _initializedMint
        uint248 lastEmergencyAction;
    }
    PackedVars private packedVars;


    event TGEInitiated(uint256 startTime, uint256 blockNumber);
    event VestingCapAdded(uint256 id, bytes32 name);
    event WalletsAddedToCap(uint256 capId, address[] wallets);
    event TokensClaimed(address indexed receiver, uint256 capId, uint256 dueTokens, uint256 time, uint256 chainId);
    event EmergencyAction(string action, uint256 timestamp, address caller);
    event TokensAllocatedToContract(uint256 indexed capId, uint256 amount, string tag);
    //multi-sign events
    event ProposalCreated(
        bytes32 indexed proposalId, 
        uint8 indexed flags, 
        address indexed proposer,
        uint256 capId
    );
    event ProposalApproved(bytes32 indexed proposalId, bool executionAttempted, address indexed approver);
    event ProposalExecuted(bytes32 indexed proposalId, uint8 indexed flags, address indexed target);
    event ProposalExpired(bytes32 indexed proposalId);
    event WalletRemoved(address indexed wallet, uint256 indexed capId);
    event CapRemoved(uint256 indexed capId);
    event QuorumUpdated(bytes32 indexed role, uint8 newQuorum);
    event AdminRemovalProposed(address indexed admin, address indexed proposer);
    event AdminRemovalExecuted(address indexed admin);
    event AdminTransferProposed(address indexed from, address indexed to);
    event AdminTransferAccepted(address indexed from, address indexed to);
    event RoleUpdated(address target, address caller, bytes32 role, bool status);

    error InsufficientContractBalance(address contractAddr, uint256 available, uint256 required);
    error CliffNotReached(uint256 currentTime, uint256 startDate, uint256 cliffEnd);
    error AllocationTooHigh(address walletAddr, uint256 walletAllocation, uint256 maxAllocation, uint256 capId);
    // multi-sig errors
    // Combine basic proposal errors into status codes
    error ProposalError(uint8 code);  // codes: 1=ProposalNotFound, 2=ProposalExpiredErr, 3=ProposalAlreadyExecuted, 4=ProposalAlreadyApproved, 

    // Combine execution delay errors
    error ProposalExecutionError(uint256 allowedTime, uint8 code); // codes: 1=ProposalExecutionDelayNotMet, 2=InsufficientApprovals, 3=OnlyApprovercanExecute, 0=uncheckedError

    error CapHasWallets();
    error TimeLockActive(address operator);
    error InvalidQuorumErr(bytes32 role, uint8 quorum);
    error InvalidAddress();
    error OperationFailed();
    error LowCapBalance(uint256 allocatedToCaps, uint256 totalAllocatedToWallets);
	error LowContractBalance();
	error ExceedsMaximumSupply(uint256 allocated);
	error CapNotFound(uint256 capId);
	error LengthMisMatch();
	error WalletExists();
	error InvalidAllocation();
	error DuplicateProposal();
	error WalletNotInCap(uint256 capId, address wallet);
	error TGENotHappened();
	error NothingDue();
    error ActiveProposalExists(address wallet, uint256 capId, bytes32 existingProposalId);
    error CannotRemoveSelf();
    error MinimumAdminsRequired();
    error AdminTransferNotAccepted();
    error MinimumRoleNoRequired();
    error InvalidRoleOperation();
    error RoleAssignment(address account, bytes32 role, uint8 status); //1: RoleAlreadyAssigned, 2: RoleNotAssigned
    error CoolDownActive(uint256 waitUntil);
    error StartDateNotSet(uint256 capId);
    error TGETInitiatedErr();
    error CapExists(uint256 capId);
	error InitialReleaseTooLarge();
	error OutOfRangeVestingPlan();

    function initialize(
        address _storageToken,
        address initialOwner,
        address initialAdmin
    ) public reinitializer(1) {
        if(initialOwner == address(0)) revert InvalidAddress();
        if (initialAdmin == address(0)) revert InvalidAddress();
        if (_storageToken == address(0)) revert InvalidAddress();
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ERC20Permit_init("TokenDistributionEngine");

        _grantRole(ADMIN_ROLE, initialAdmin);
        _grantRole(ADMIN_ROLE, initialOwner);
       // Set timelocks using packed TimeConfig struct
        uint256 lockTime = block.timestamp + ROLE_CHANGE_DELAY;
        
        TimeConfig storage ownerTimeConfig = timeConfigs[initialOwner];
        ownerTimeConfig.roleChangeTimeLock = uint32(lockTime);
        
        TimeConfig storage adminTimeConfig = timeConfigs[initialAdmin];
        adminTimeConfig.roleChangeTimeLock = uint32(lockTime);

        // Initialize storageToken as ERC20PausableUpgradeable
        storageToken = IERC20(_storageToken);

        // Use SafeERC20 for approval
        uint256 currentAllowance = storageToken.allowance(address(this), address(this));
        if (currentAllowance > 0) {
            bool resetSuccess = storageToken.approve(address(this), 0);
            if (!resetSuccess) revert OperationFailed();
        }

        bool approveSuccess = storageToken.approve(address(this), type(uint256).max);
        if (!approveSuccess) revert OperationFailed();

        uint256 newAllowance = storageToken.allowance(address(this), address(this));
        if (newAllowance != type(uint256).max) revert OperationFailed();
    }

    // Update the last activity that an address has done
    modifier updateActivityTimestamp() {
        // Use TimeConfig struct for activity timestamp
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        timeConfig.lastActivityTime = uint64(block.timestamp);
        _;
    }

    // Pausing contract actions in emergency
    function emergencyAction(bool pause) external nonReentrant onlyRole(ADMIN_ROLE) {
        PackedVars storage vars = packedVars;
        if (block.timestamp < vars.lastEmergencyAction + EMERGENCY_COOLDOWN) 
            revert CoolDownActive(vars.lastEmergencyAction + EMERGENCY_COOLDOWN);
        
        pause ? _pause() : _unpause();
        vars.lastEmergencyAction = uint248(block.timestamp);
        emit EmergencyAction(pause ? "paused" : "unpaused", block.timestamp, msg.sender);
    }

    function transferOwnership(address newOwner) 
        public 
        virtual 
        override 
        whenNotPaused 
        nonReentrant 
        onlyOwner 
    {
        if (newOwner == address(0)) revert InvalidAddress();
        
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

    function getCapWallets(uint256 capId) external view returns (address[] memory) {
        return capWallets[capId];
    }

    function InitiateTGE() external onlyRole(ADMIN_ROLE) {
        if(tgeInitiated) revert TGETInitiatedErr();
        
        // Calculate total required tokens across all caps
        uint256 totalRequiredTokens = 0;
        
        // First pass: validate caps and calculate total required tokens
        for (uint256 i = 0; i < capIds.length; i++) {
            uint256 capId = capIds[i];
            VestingCap storage cap = vestingCaps[capId];
            
            if (cap.totalAllocation > 0) {
                // Ensure start date is the default value
                if (cap.startDate < block.timestamp + (10 * 365 days)) {
                    revert StartDateNotSet(capId);
                }
                
                // Add to total required tokens
                totalRequiredTokens += cap.totalAllocation;
                
                // Verify cap allocation matches wallet allocations
                if (cap.totalAllocation < allocatedTokensPerCap[capId]) {
                    revert AllocationTooHigh(
                        address(0), 
                        allocatedTokensPerCap[capId], 
                        cap.totalAllocation, 
                        capId
                    );
                }
            }
        }

        // Verify contract has sufficient token balance
        uint256 contractBalance = storageToken.balanceOf(address(this));
        if (contractBalance < totalRequiredTokens) {
            revert InsufficientContractBalance(
                address(this), 
                contractBalance, 
                totalRequiredTokens
            );
        }

        // Verify total allocations
        if (totalRequiredTokens < totalAllocatedToWallets) {
            revert LowCapBalance(totalRequiredTokens, totalAllocatedToWallets);
        }

        // Second pass: set start dates after all validations pass
        for (uint256 i = 0; i < capIds.length; i++) {
            uint256 capId = capIds[i];
            VestingCap storage cap = vestingCaps[capId];
            if (cap.totalAllocation > 0) {
                cap.startDate = block.timestamp;
            }
        }
        
        tgeInitiated = true;
        emit TGEInitiated(block.timestamp, block.number);
    }

    function addVestingCap(
        uint256 capId,
        bytes32 name,
        uint256 totalAllocation,
        uint256 cliff, // cliff in days
        uint256 vestingTerm, // linear vesting duration in months
        uint256 vestingPlan, // Intervals at which the user can claim in months. 1 means monthly and 3 means quarterly
        uint256 initialRelease // percentage that is released after cliff
    ) external onlyRole(ADMIN_ROLE) {
        if(vestingCaps[capId].totalAllocation != 0) revert CapExists(capId);
        if(totalAllocation <= 0) revert InvalidAllocation();
        if(initialRelease > 100) revert InitialReleaseTooLarge();
        if(vestingPlan >= vestingTerm) revert OutOfRangeVestingPlan();
        uint256 defaultStartDate = block.timestamp + (30 * 365 days);

        vestingCaps[capId] = VestingCap({
            totalAllocation: totalAllocation,
            cliff: cliff * 1 days,
            vestingTerm: vestingTerm * 30 days,
            vestingPlan: vestingPlan * 30 days,
            initialRelease: initialRelease,
            startDate: defaultStartDate
        });
        if (tgeInitiated) { 
            if (! _checkAllocatedTokensToContract(totalAllocation)) revert LowContractBalance();
        }

        capIds.push(capId);

        emit VestingCapAdded(capId, name);
    }

    function removeVestingCap(uint256 capId) external onlyRole(ADMIN_ROLE) {
        if(vestingCaps[capId].totalAllocation <= 0) revert CapNotFound(capId);
        if (capWallets[capId].length > 0) revert CapHasWallets();

        // Clean up all role assignments and permissions for this cap
        address[] storage wallets = capWallets[capId];
        for (uint i = 0; i < wallets.length; i++) {
            address wallet = wallets[i];
            delete allocatedTokens[wallet][capId];
            delete walletNames[wallet][capId];
            delete proposedWallets[wallet][capId];
            delete activeProposals[wallet][capId];
        }
        
        delete vestingCaps[capId];
        delete allocatedTokensPerCap[capId];
        delete capWallets[capId];
        
        // Remove from capIds array
        for (uint i = 0; i < capIds.length; i++) {
            if (capIds[i] == capId) {
                capIds[i] = capIds[capIds.length - 1];
                capIds.pop();
                break;
            }
        }
        
        emit CapRemoved(capId);
    }


    function _checkAllocatedTokensToContract(uint256 amount) internal view returns (bool) {
        if (amount+totalAllocatedToWallets > storageToken.totalSupply()) revert ExceedsMaximumSupply(amount+totalAllocatedToWallets);
        uint256 availableBalance = storageToken.balanceOf(address(this));
        uint256 requiredBalance = amount + totalAllocatedToWallets;

        if (availableBalance < requiredBalance) {
            revert InsufficientContractBalance(address(this), availableBalance, requiredBalance);
        }

        return true;
    }

    function _validateTimelock(address account) internal view {
        TimeConfig storage timeConfig = timeConfigs[account];
        if (block.timestamp < timeConfig.roleChangeTimeLock) {
            revert TimeLockActive(account);
        }
    }

    function _validateQuorum(bytes32 role) internal view {
        RoleConfig storage roleConfig = roleConfigs[role];
        if (roleConfig.quorum < 2) {
            revert InvalidQuorumErr(role, roleConfig.quorum);
        }
    }

    function _createProposalId(uint8 flags, bytes32 data) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(
            flags,
            data,
            block.timestamp
        ));
    }

    function _initializeProposal(
        UnifiedProposal storage proposal,
        address target,
        uint256 capId,
        address[] memory wallets,
        bytes32[] memory names,
        uint256[] memory allocations,
        uint8 flags
    ) internal {
        proposal.target = target;
        proposal.capId = capId;
        proposal.wallets = wallets;
        proposal.names = names;
        proposal.allocations = allocations;
        proposal.config.expiryTime = uint64(block.timestamp + PROPOSAL_TIMEOUT);
        proposal.config.executionTime = uint64(block.timestamp + MIN_PROPOSAL_EXECUTION_DELAY);
        proposal.config.approvals = 1;
        proposal.flags |= flags;
        proposal.hasApproved[msg.sender] = true;
    }

    function _canExecute(UnifiedProposal storage proposal) internal view returns (bool) {
        RoleConfig storage roleConfig = roleConfigs[ADMIN_ROLE];

        return proposal.config.approvals >= roleConfig.quorum && 
            block.timestamp >= proposal.config.executionTime && 
            block.timestamp < proposal.config.expiryTime;
    }

    function proposeRole(
        address account,
        bytes32 role,
        uint8 flags
    ) external 
        whenNotPaused 
        onlyRole(ADMIN_ROLE) 
        returns (bytes32) 
    {
        if(account == address(0)) revert InvalidAddress();
        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);

        // Validate role assignment
        if ((flags & ADDROLE_FLAG) != 0) {
            if (hasRole(role, account)) revert RoleAssignment(account, role, 1);
        } else {
            if (!hasRole(role, account)) revert RoleAssignment(account, role, 2);
            // Prevent removing the last admin
            if (role == ADMIN_ROLE && getRoleMemberCount(ADMIN_ROLE) <= 2) {
                revert MinimumRoleNoRequired();
            }
        }

        // Create proposal ID
        bytes32 proposalId = _createProposalId(
            flags,
            keccak256(abi.encodePacked(account, role))
        );

        // Initialize proposal
        UnifiedProposal storage proposal = proposals[proposalId];
        _initializeProposal(
            proposal,
            account,
            0,
            new address[](0),
            new bytes32[](0),
            new uint256[](0),
            flags
        );

        // Store role in the proposal for execution
        proposal.role = role;
        proposal.flags |= flags;

        proposalRegistry[proposalCount++] = proposalId;
        
        emit ProposalCreated(
            proposalId, 
            flags, 
            msg.sender,
            0
        );
        return proposalId;
    }

    function proposeAddWalletsToCap(
        uint256 capId,
        address[] memory wallets,
        bytes32[] memory names,
        uint256[] memory totalAllocationToWallet
    ) external whenNotPaused onlyRole(ADMIN_ROLE) returns (bytes32) {
        // Initial validations
        if(vestingCaps[capId].totalAllocation <= 0) revert CapNotFound(capId);
        if(wallets.length != names.length) revert LengthMisMatch();
        if(wallets.length != totalAllocationToWallet.length) revert LengthMisMatch();
        
        // Timelock check
        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);

        // Create proposal ID
        bytes32 proposalId = _createProposalId(ADDWALLET_FLAG, bytes32(uint256(capId)));

        // Validate each wallet and allocation
        for (uint256 i = 0; i < wallets.length; i++) {
            address wallet = wallets[i];
            // Check for active proposals
            bytes32 existingProposal = activeProposals[wallet][capId];
            if (existingProposal != 0 && proposals[existingProposal].config.expiryTime > block.timestamp) {
                revert ActiveProposalExists(wallet, capId, existingProposal);
            }

            uint256 allocationForWallet = totalAllocationToWallet[i];
            
            // Check total supply
            if(totalAllocatedToWallets + allocationForWallet > storageToken.totalSupply()) revert ExceedsMaximumSupply(totalAllocatedToWallets + allocationForWallet);
            
            // Check max allocation
            uint256 maxAllocation = vestingCaps[capId].totalAllocation - allocatedTokensPerCap[capId];
            if (allocationForWallet > maxAllocation) revert AllocationTooHigh(wallet, allocationForWallet, maxAllocation, capId);
            
            // Wallet checks
            if(allocatedTokens[wallet][capId] != 0) revert WalletExists();
            if(allocationForWallet <= 0) revert InvalidAllocation();
            
            // TGE check
            if (tgeInitiated) {
                if(storageToken.balanceOf(address(this)) < allocationForWallet) revert ExceedsMaximumSupply(allocationForWallet);
            }
            
            // Proposal status check
            if(proposedWallets[wallet][capId] != 0) revert DuplicateProposal();
            proposedWallets[wallet][capId] |= PROPOSED_ADD;
             activeProposals[wallets[i]][capId] = proposalId;
        }

        // Initialize proposal with optimized struct
        UnifiedProposal storage proposal = proposals[proposalId];
        _initializeProposal(
            proposal,
            address(0),
            capId,
            wallets,
            names,
            totalAllocationToWallet,
            ADDWALLET_FLAG
        );
        proposal.hasApproved[msg.sender] = true;

        // Register proposal
        proposalRegistry[proposalCount++] = proposalId;

        emit ProposalCreated(proposalId, ADDWALLET_FLAG, msg.sender, capId);
        return proposalId;
    }

    function proposeUpgrade(address newImplementation) 
        external 
        whenNotPaused 
        onlyRole(ADMIN_ROLE) 
        returns (bytes32) 
    {
        if(newImplementation == address(0)) revert InvalidAddress();
        // Clear any expired proposal first
        bytes32 existingProposal = upgradeProposals[newImplementation];
        if(existingProposal != 0) {
            UnifiedProposal storage oldProposal = proposals[existingProposal];
            if(block.timestamp >= oldProposal.config.expiryTime) {
                delete upgradeProposals[newImplementation];
                delete proposals[existingProposal];
            } else {
                revert DuplicateProposal();
            }
        }
        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);

        bytes32 proposalId = _createProposalId(UPGRADE_FLAG, bytes32(bytes20(newImplementation)));
        UnifiedProposal storage proposal = proposals[proposalId];
        
        _initializeProposal(
            proposal,
            newImplementation,
            0,
            new address[](0),
            new bytes32[](0),
            new uint256[](0),
            UPGRADE_FLAG
        );

        upgradeProposals[newImplementation] = proposalId;
        proposalRegistry[proposalCount++] = proposalId;
        
        emit ProposalCreated(proposalId, UPGRADE_FLAG, msg.sender, 0);
        return proposalId;
    }
    

    function proposeRemoveWallet(
        address wallet,
        uint256 capId
    ) external whenNotPaused onlyRole(ADMIN_ROLE) returns (bytes32) {
        if(allocatedTokens[wallet][capId] <= 0) revert WalletNotInCap(capId, wallet);
        if(proposedWallets[wallet][capId] != 0) revert DuplicateProposal();
        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);
        // Check for active proposals
        bytes32 existingProposal = activeProposals[wallet][capId];
        if (existingProposal != 0 && proposals[existingProposal].config.expiryTime > block.timestamp) {
            revert ActiveProposalExists(wallet, capId, existingProposal);
        }

        proposedWallets[wallet][capId] |= PROPOSED_REMOVE;
        
        bytes32 proposalId = keccak256(abi.encodePacked(
            uint8(REMOVEWALLET_FLAG),
            wallet,
            capId,
            block.timestamp
        ));
        activeProposals[wallet][capId] = proposalId;

        UnifiedProposal storage proposal = proposals[proposalId];
        proposal.target = wallet;
        proposal.capId = capId;
        proposal.config.expiryTime = uint64(block.timestamp + PROPOSAL_TIMEOUT);
        proposal.config.executionTime = uint64(block.timestamp + MIN_PROPOSAL_EXECUTION_DELAY);
        proposal.config.approvals = 1;
        proposal.flags = REMOVEWALLET_FLAG;
        proposal.hasApproved[msg.sender] = true;

        proposalRegistry[proposalCount++] = proposalId;

        emit ProposalCreated(proposalId, REMOVEWALLET_FLAG, msg.sender, capId);
        return proposalId;
    }

    function approveProposal(bytes32 proposalId) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ADMIN_ROLE) 
    {
        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.config.expiryTime == 0) revert ProposalError(1);
        if (proposal.hasApproved[msg.sender]) revert ProposalError(4);
        if (block.timestamp >= proposal.config.expiryTime) {
            delete proposals[proposalId];
            revert ProposalError(2);
        }
        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);
        
        proposal.hasApproved[msg.sender] = true;
        proposal.config.approvals++;
        
        bool executionAttempted = false;
        if (_canExecute(proposal)) {
            executionAttempted = true;
            _executeProposal(proposalId);
        }
        emit ProposalApproved(proposalId, executionAttempted, msg.sender);
    }

    function executeProposal(bytes32 proposalId) 
        external
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp
    {
        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.flags == 0) revert ProposalError(1);
        if (block.timestamp >= proposal.config.expiryTime) {
            delete proposals[proposalId];
            revert ProposalError(2);
        }
        if (! proposal.hasApproved[msg.sender]) revert ProposalExecutionError(proposal.config.executionTime, 3);
        
        _validateTimelock(msg.sender);
        _validateQuorum(ADMIN_ROLE);
        
        if (_canExecute(proposal)) {
            _executeProposal(proposalId);
        } else {
            revert ProposalExecutionError(proposal.config.executionTime, 0);
        }
    }

    function _executeProposal(bytes32 proposalId) internal {
        UnifiedProposal storage proposal = proposals[proposalId];
        // Add validation for proposal status changes
        if (proposal.config.expiryTime == 0) revert ProposalError(1);
        if (block.timestamp >= proposal.config.expiryTime) revert ProposalError(2);
        if ((proposal.flags & EXECUTED_FLAG) != 0) revert ProposalError(3);

        // Revalidate quorum requirements
        RoleConfig storage roleConfig = roleConfigs[ADMIN_ROLE];
        if (proposal.config.approvals < roleConfig.quorum) {
            revert ProposalExecutionError(proposal.config.executionTime, 2);
        }
    
        if ((proposal.flags & ADDROLE_FLAG) != 0 || 
            (proposal.flags & REMOVEROLE_FLAG) != 0 
        )
        {
            address account = proposal.target;
            bytes32 role = proposal.role;  // Use proposedRole instead of role

            if ((proposal.flags & ADDROLE_FLAG) != 0) {
                // Additional validation for admin role
                if (role == ADMIN_ROLE) {
                    uint256 adminCount = getRoleMemberCount(ADMIN_ROLE);
                    if (adminCount <= 2) revert MinimumRoleNoRequired();
                }
                
                _grantRole(role, account);
                
                // Set timelock for new role
                TimeConfig storage timeConfig = timeConfigs[account];
                timeConfig.roleChangeTimeLock = uint32(block.timestamp + ROLE_CHANGE_DELAY);
                timeConfig.lastActivityTime = uint64(block.timestamp);
            } else {
                // Prevent removing the last admin
                if (role == ADMIN_ROLE) {
                    uint256 activeAdminCount = 0;
                    uint256 adminCount = getRoleMemberCount(ADMIN_ROLE);
                    
                    for (uint256 i = 0; i < adminCount; i++) {
                        address currentAdmin = getRoleMember(ADMIN_ROLE, i);
                        if (currentAdmin != account && 
                            block.timestamp - timeConfigs[currentAdmin].lastActivityTime <= INACTIVITY_THRESHOLD) {
                            activeAdminCount++;
                        }
                    }
                    
                    uint256 minRequiredActiveAdmins = (adminCount - 1) / 2 + 1;
                    if (activeAdminCount < minRequiredActiveAdmins) {
                        revert MinimumRoleNoRequired();
                    }
                }
                
                _revokeRole(role, account);
                
                // Clear timelock and activity time
                TimeConfig storage timeConfig = timeConfigs[account];
                timeConfig.roleChangeTimeLock = 0;
                timeConfig.lastActivityTime = 0;
            }

            emit ProposalExecuted(proposalId, proposal.flags, account);
            delete proposals[proposalId];
        }
        else if ((proposal.flags & ADDWALLET_FLAG) != 0) {
            for (uint256 i = 0; i < proposal.wallets.length; i++) {
                address wallet = proposal.wallets[i];
                bytes32 name = proposal.names[i] != bytes32(0) ? proposal.names[i] : bytes32("Unnamed Wallet");

                // Check if the contract has enough token balance for this cap
                uint256 allocationForWallet = proposal.allocations[i];
                if(totalAllocatedToWallets + allocationForWallet > storageToken.totalSupply()) revert ExceedsMaximumSupply(totalAllocatedToWallets + allocationForWallet);
                uint256 maxAllocation = vestingCaps[proposal.capId].totalAllocation - allocatedTokensPerCap[proposal.capId];
                if (allocationForWallet > maxAllocation) {
                    revert AllocationTooHigh(wallet, allocationForWallet, maxAllocation, proposal.capId);
                }
                
                if(allocatedTokens[wallet][proposal.capId] != 0) revert WalletExists();
                if(allocationForWallet <= 0) revert InvalidAllocation();
                if (tgeInitiated) {
                    if (storageToken.balanceOf(address(this)) < allocationForWallet) revert ExceedsMaximumSupply(allocationForWallet);
                }
                
                allocatedTokens[wallet][proposal.capId] = allocationForWallet;
                capWallets[proposal.capId].push(wallet);
                walletNames[wallet][proposal.capId] = name;
                totalAllocatedToWallets += allocationForWallet;
                allocatedTokensPerCap[proposal.capId] += allocationForWallet;

                // Clean up proposedWallets mapping
                delete proposedWallets[wallet][proposal.capId];
                delete activeProposals[wallet][proposal.capId];
            }
            emit WalletsAddedToCap(proposal.capId, proposal.wallets);
            emit ProposalExecuted(proposalId, proposal.flags, proposal.wallets[0]);
            delete proposals[proposalId];
        } 
        else if ((proposal.flags & REMOVEWALLET_FLAG) != 0) {
            address wallet = proposal.target;
            uint256 capId = proposal.capId;
            
            uint256 allocation = allocatedTokens[wallet][capId];
            delete allocatedTokens[wallet][capId];
            delete walletNames[wallet][capId];
            totalAllocatedToWallets -= allocation;
            allocatedTokensPerCap[capId] -= allocation;
            
            // Remove from capWallets array
            address[] storage wallets = capWallets[capId];
            for (uint i = 0; i < wallets.length; i++) {
                if (wallets[i] == wallet) {
                    wallets[i] = wallets[wallets.length - 1];
                    wallets.pop();
                    break;
                }
            }
            
            emit WalletRemoved(wallet, capId);
            emit ProposalExecuted(proposalId, proposal.flags, proposal.target);
            delete proposals[proposalId];
            delete proposedWallets[wallet][capId];
            delete activeProposals[wallet][proposal.capId];
        }
    }


    function calculateDueTokens(address wallet, uint256 capId) public view returns (uint256) {
        VestingCap memory cap = vestingCaps[capId];
        
        // Initial validations
        if (cap.startDate == 0 || block.timestamp < cap.startDate + cap.cliff) {
            revert CliffNotReached(block.timestamp, cap.startDate, cap.startDate + cap.cliff);
        }

        uint256 allocation = allocatedTokens[wallet][capId];
        if(allocation <= 0) revert LowCapBalance(allocation, 0);
        if(cap.vestingPlan == 0) revert InvalidAllocation();

        // Get token decimals and adjust precision
        uint8 tokenDecimals = IERC20Metadata(address(storageToken)).decimals();
        uint256 precisionFactor = 10 ** tokenDecimals;
        
        // Calculate elapsed time since cliff with safe math
        uint256 elapsedTime;
        unchecked {
            elapsedTime = block.timestamp - (cap.startDate + cap.cliff);
        }

        // Calculate vested intervals safely
        uint256 vestedIntervals = elapsedTime / cap.vestingPlan;
        
        // Calculate vested months with proper decimal handling
        uint256 vestedMonths;
        {
            uint256 monthlyFactor = 30 days;
            uint256 temp = (vestedIntervals * cap.vestingPlan * precisionFactor) / monthlyFactor;
            vestedMonths = temp / precisionFactor;
            
            // Cap at total vesting term
            uint256 maxMonths = cap.vestingTerm / monthlyFactor;
            if (vestedMonths > maxMonths) {
                vestedMonths = maxMonths;
            }
        }

        // Calculate initial release with decimal precision
        uint256 initialRelease;
        {
            uint256 scaledAllocation = allocation * precisionFactor;
            initialRelease = (scaledAllocation * cap.initialRelease) / (100 * precisionFactor);
        }

        // Calculate remaining allocation
        uint256 remainingAllocation = allocation - initialRelease;

        // Calculate vesting multiplier with safe precision
        uint256 vestingMultiplier;
        {
            uint256 scaledMonths = vestedMonths * 30 days * precisionFactor;
            vestingMultiplier = scaledMonths / cap.vestingTerm;
        }

        // Calculate total claimable amount
        uint256 vestedAmount = (remainingAllocation * vestingMultiplier) / precisionFactor;
        uint256 totalClaimable = initialRelease + vestedAmount;

        // Handle claimed tokens
        uint256 claimed = claimedTokens[wallet][capId];
        if (totalClaimable <= claimed) {
            return 0;
        }

        return totalClaimable - claimed;
    }

    function claimTokens(uint256 capId, uint256 chainId) external whenNotPaused nonReentrant {
        if(! tgeInitiated) revert TGENotHappened();
        uint256 dueTokens = calculateDueTokens(msg.sender, capId);

        if(dueTokens <= 0) revert NothingDue();

        // Update claimed tokens for the user
        claimedTokens[msg.sender][capId] += dueTokens;

        // Transfer tokens from this contract's balance to the receiver
        if(storageToken.balanceOf(address(this)) < dueTokens) revert LowContractBalance();
        bool success = storageToken.transfer(msg.sender, dueTokens);
        if(! success) revert OperationFailed();

        emit TokensClaimed(msg.sender, capId, dueTokens, block.timestamp, chainId);
    }

    function setRoleQuorum(bytes32 role, uint8 quorum) 
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


    function _authorizeUpgrade(address newImplementation) 
        internal 
        override 
        nonReentrant
        whenNotPaused
        onlyRole(ADMIN_ROLE) 
        updateActivityTimestamp 
    {
        if (newImplementation == address(0)) revert InvalidAddress();
        
        // Use RoleConfig struct for role-related values
        RoleConfig storage operatorConfig = roleConfigs[ADMIN_ROLE];
        if (operatorConfig.quorum < 2) {
            revert InvalidQuorumErr(ADMIN_ROLE, operatorConfig.quorum);
        }
        
        // Cache current timestamp
        uint256 currentTime = block.timestamp;
        
        // Find the active upgrade proposal
        bytes32 currentId = upgradeProposals[newImplementation];
        if (currentId == 0) revert ProposalError(1);
        
        // Cache proposal storage
        UnifiedProposal storage currentProposal = proposals[currentId];
        
        // Check if proposal is valid
        if ((currentProposal.flags & UPGRADE_FLAG) == 0 || 
            currentProposal.target != newImplementation ||
            (currentProposal.flags & EXECUTED_FLAG) == 0 || 
            currentProposal.config.expiryTime <= currentTime ) {
                revert ProposalError(1);
        }
        
        // Cache target address
        address target = currentProposal.target;
        if (target == address(0)) revert InvalidAddress();
        
        // Cache required approvals
        uint32 requiredApprovals = operatorConfig.quorum;
        if (currentProposal.config.approvals < requiredApprovals) {
            revert ProposalExecutionError(currentProposal.config.approvals, 2);
        }
        
        if (currentTime < currentProposal.config.executionTime) {
            revert ProposalExecutionError(currentProposal.config.executionTime, 1);
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
        
        emit ProposalExecuted(currentId, currentProposal.flags, target);
    }
}
