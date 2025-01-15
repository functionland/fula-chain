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
    address private _pendingOwner;
    enum ContractType { Pool, Proof, Staking, Distribution, Reward } // related contracts
    enum ProposalType { RoleChange, Upgrade, Recovery, Whitelist } // multi-sig proposals
    uint8 constant WHITELIST_FLAG = 1;
    uint8 constant ROLE_CHANGE_FLAG = 2;
    uint8 constant RECOVERY_FLAG = 4;
    uint8 constant UPGRADE_FLAG = 8;

    uint256 private constant TOKEN_UNIT = 10**18; //Smallest unit for the token
    uint256 private constant TOTAL_SUPPLY = 2_000_000_000 * TOKEN_UNIT; // Maximum number of fixed cap token to be issued
    uint256 private lastEmergencyAction; // holds hte time of last emergency action (pause, unpause)
    uint256 private constant EMERGENCY_COOLDOWN = 30 minutes; // how much should we wait before allowing the next emergency action
    uint256 public constant MIN_PROPOSAL_EXECUTION_DELAY = 24 hours;
    uint256 public constant EMERGENCY_THRESHOLD = 3;
    uint256 public constant INACTIVITY_THRESHOLD = 365 days;
    mapping(uint256 => mapping(uint256 => bool)) private _usedNonces;
    mapping(address => bytes32) private upgradeProposals;

    bytes32 public constant BRIDGE_OPERATOR_ROLE = bytes32(uint256(keccak256("BRIDGE_OPERATOR_ROLE")) - 1); // role
    bytes32 public constant ADMIN_ROLE = bytes32(uint256(keccak256("ADMIN_ROLE")) - 1); // role
    bytes32 public constant CONTRACT_OPERATOR_ROLE = bytes32(uint256(keccak256("CONTRACT_OPERATOR_ROLE")) - 1); // role

    // Multi-sig related structures
    struct UnifiedProposal {
        bytes32 role;        // for role changes
        uint256 amount;      // for recoveries
        uint256 expiryTime;
        uint256 executionTime;

        address target;
        address tokenAddress;

        uint32 approvals;

        ProposalType proposalType;
        bool isAdd;          // for role changes/whitelist
        mapping(address => bool) hasApproved;
        bool executed;
    }
    uint256 public proposalTimeout;
    uint256 private proposalCount;
    mapping(bytes32 => UnifiedProposal) public proposals;

    struct PendingProposals {
        uint8 flags; // Pack all bools into single uint8 for struct PendingProposals {bool whitelist;bool roleChange;bool recovery;bool upgrade;}
    }

    mapping(address => PendingProposals) public pendingProposals;
    mapping(bytes32 => uint32) public roleQuorum;
    mapping(bytes32 => uint256) public roleTransactionLimit;
    mapping(address => uint256) public lastActivityTime;
    mapping(address => uint256) public emergencyVotes;
    mapping(uint256 => bytes32) private proposalRegistry;
    
    mapping(uint256 => bool) public supportedChains; // Storage for chains that are supported by the contract
    mapping(address => uint256) private roleChangeTimeLock; // Time holder of a role assignment
    uint256 private constant ROLE_CHANGE_DELAY = 1 days; // How much we should wait after a role is assigned to allow actions by that role
    mapping(address => uint256) private whitelistLockTime; // Lock time for whitelisted addresses to hold the time when an address is whitelisted
    uint256 private constant WHITELIST_LOCK_DURATION = 1 days; // Lock duration after adding to whitelist which should be passed before they can receive the transfer
    bool private _initializedMint; // Storage to indicate initial minting is done

    event RoleUpdated(address target, address caller, bytes32 role, bool status); //status true: added, status false: removed
    event EmergencyAction(string action, uint256 timestamp, address caller);
    event BridgeOperationDetails(address indexed operator, string operation, uint256 amount, uint256 chainId, uint256 timestamp);
    event WalletWhitelistedWithLock(address indexed wallet, uint256 lockUntil, address caller);
    event WalletRemovedFromWhitelist(address indexed wallet, address caller);
    event TransferFromContract(address indexed from, address indexed to, uint256 amount, address caller);
    event TokensMinted(address to, uint256 amount);
    event SupportedChainChanged(uint256 indexed chainId, bool supported, address caller);

    // Multi-sig related events
    // Core proposal events
    event ProposalCreated(
        bytes32 indexed proposalId,
        uint32 version,
        ProposalType indexed proposalType,
        address indexed target,
        bytes32 role, // for role changes
        uint256 amount, // for recoveries/amounts
        address tokenAddress, // for recoveries/token address
        bool isAdd, // for role changes/whitelist
        address proposer
    );

    event ProposalApproved(
        bytes32 indexed proposalId,
        ProposalType indexed proposalType,
        address indexed approver
    );

    event ProposalExecuted(
        bytes32 indexed proposalId,
        ProposalType indexed proposalType,
        address indexed target
    );

    event ProposalExpired(
        bytes32 indexed proposalId,
        ProposalType indexed proposalType,
        address indexed target
    );

    // System configuration events
    event QuorumUpdated(bytes32 indexed role, uint256 newQuorum);
    event TransactionLimitUpdated(bytes32 indexed role, uint256 newLimit);

    error ExceedsMaximumSupply(uint256 requested, uint256 maxSupply);
    error ExceedsAvailableSupply(uint256 requested, uint256 supply);
    error AmountMustBePositive();
    error UnsupportedChain(uint256 chain);
    error TokenPaused();
    error InsufficientAllowance(address spender, uint256 amount);
    error UnauthorizedTransfer(address sender);
    error TimeLockActive(address operator);

    // Multi-Sig related errors
    error ProposalNotFoundErr();
    error ProposalExpiredErr();
    error ProposalAlreadyExecutedErr();
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

    // Ensures address is not zero
    modifier validateAddress(address _address) {
        if (_address == address(0)) revert InvalidAddress(_address);
        _;
    }

    // onlyWhitelisted checks to ensure only white-listed recipients and only after time lock period are allowed
    modifier onlyWhitelisted(address to) {
        if (whitelistLockTime[to] <= 0) revert NotWhitelisted(to);
        if (block.timestamp < whitelistLockTime[to]) revert RecipientLocked(to);
        _;
    }

    // Update the last activity that an address has done
    modifier updateActivityTimestamp() {
        lastActivityTime[msg.sender] = block.timestamp;
        _;
    }

    function initialize(address initialOwner, address initialAdmin, uint256 initialMintedTokens) public reinitializer(1) { // Increment version number for each upgrade
        if (initialOwner == address(0)) revert InvalidAddress(initialOwner); // check to ensure there is a valid initial owner address
        if (initialAdmin == address(0)) revert InvalidAddress(initialAdmin); // check to ensure there is a valid initial admin address
        require(initialMintedTokens <= TOTAL_SUPPLY, "Exceeds maximum supply"); // initial minted tokens should not exceed maximum fixed cap supply
        
        __ERC20_init("Placeholder Token", "PLACEHOLDER"); // Placeholder will be changed to actual token name
        __UUPSUpgradeable_init();
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControlEnumerable_init();
        
        _grantRole(ADMIN_ROLE, initialOwner); // Assign admin role to deployer
        _grantRole(ADMIN_ROLE, initialAdmin); // Assign admin role to initial Admin

        // Set timelocks for initial admins
        roleChangeTimeLock[initialOwner] = block.timestamp + ROLE_CHANGE_DELAY;
        roleChangeTimeLock[initialAdmin] = block.timestamp + ROLE_CHANGE_DELAY;
        
        // Mint the initial tokens to the contract address
        if (!_initializedMint) {
            _mint(address(this), initialMintedTokens);
            proposalCount = 0;
            proposalTimeout = 48 hours;
            emit TokensMinted(address(this), initialMintedTokens);
            _initializedMint = true; // Mark minting as initialized. This could be redundant but still placed for guarantee
        }
    }

    function version() public pure returns (uint32) {
        return 1;
    }

    function tokenUnit() public pure returns (uint256) {
        unchecked {
            return 10**18; // This calculation cannot overflow
        }
    }

    function maxSupply() public pure returns (uint256) {
        unchecked {
            return TOTAL_SUPPLY; // This calculation cannot overflow
        }
    }

    function transferOwnership(address newOwner) public virtual override whenNotPaused nonReentrant onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress(newOwner);
        _pendingOwner = newOwner;
    }
    // Two step ownership transfer
    function acceptOwnership() public virtual whenNotPaused nonReentrant{
        require(msg.sender == _pendingOwner, "Not pending owner");
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
        require(target != address(0), "Invalid target address");
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        if (roleQuorum[ADMIN_ROLE] < 2) {
            revert InvalidQuorumErr(ADMIN_ROLE, roleQuorum[ADMIN_ROLE]);
        }
        
        // Validate based on proposal type also ensure no duplicate proposal is created for a property if needed
        if (proposalType == ProposalType.Whitelist) {
            require(whitelistLockTime[target] == 0, "Already whitelisted");
            if ((pendingProposals[target].flags & WHITELIST_FLAG) != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.RoleChange) {
            require(roleChangeTimeLock[target] == 0, "Already owns a role");
            require(role == ADMIN_ROLE || role == CONTRACT_OPERATOR_ROLE || role == BRIDGE_OPERATOR_ROLE, "Invalid role");
            if ((pendingProposals[target].flags & ROLE_CHANGE_FLAG) != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.Recovery) {
            require(tokenAddress != address(this), "Cannot recover native tokens");
            require(amount > 0, "Invalid amount");
            if ((pendingProposals[target].flags & RECOVERY_FLAG) != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == ProposalType.Upgrade) {
            require(target != address(this), "Already upgraded");
            if ((pendingProposals[target].flags & UPGRADE_FLAG) != 0) revert ExistingActiveProposal(target);
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
        require(proposal.executionTime == 0, "Proposal already exists");
        if (proposal.executionTime > 0) revert DuplicateProposalErr(proposalType, target);

        proposal.proposalType = proposalType;
        proposal.target = target;
        proposal.role = role;
        proposal.amount = amount;
        proposal.tokenAddress = tokenAddress;
        proposal.isAdd = isAdd;
        proposal.expiryTime = block.timestamp + proposalTimeout;
        proposal.executionTime = block.timestamp + MIN_PROPOSAL_EXECUTION_DELAY;
        proposal.hasApproved[msg.sender] = true;
        proposal.approvals = 1;

        if (proposalType == ProposalType.Whitelist) {
            pendingProposals[target].flags |= WHITELIST_FLAG;
        } else if(proposalType == ProposalType.RoleChange) {
            pendingProposals[target].flags |= ROLE_CHANGE_FLAG;
        } else if (proposalType == ProposalType.Recovery) {
            pendingProposals[target].flags |= RECOVERY_FLAG;
        } else if (proposalType == ProposalType.Upgrade) {
            pendingProposals[target].flags |= UPGRADE_FLAG;
            upgradeProposals[target] = proposalId;
        }

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
        if (proposal.executed) revert ProposalAlreadyExecutedErr();
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        if (roleQuorum[ADMIN_ROLE] < 2) {
            revert InvalidQuorumErr(ADMIN_ROLE, roleQuorum[ADMIN_ROLE]);
        }
        
        if (block.timestamp >= proposal.expiryTime) {
            // Delete the proposal if the expiry is passed
            PendingProposals storage pending = pendingProposals[proposal.target];
    
            if (proposal.proposalType == ProposalType.Whitelist) {
                pending.flags &= ~WHITELIST_FLAG;
            } else if (proposal.proposalType == ProposalType.RoleChange) {
                pending.flags &= ~ROLE_CHANGE_FLAG;
            } else if (proposal.proposalType == ProposalType.Recovery) {
                pending.flags &= ~RECOVERY_FLAG;
            } else if (proposal.proposalType == ProposalType.Upgrade) {
                pending.flags &= ~UPGRADE_FLAG;
                delete upgradeProposals[proposal.target];
            }

            // Delete entire record if all flags are false
            bool isWhitelisted = (pending.flags & WHITELIST_FLAG) != 0;
            bool isRoleChange = (pending.flags & ROLE_CHANGE_FLAG) != 0;
            bool isRecovery = (pending.flags & RECOVERY_FLAG) != 0;
            bool isUpgrade = (pending.flags & UPGRADE_FLAG) != 0;
            if (!isWhitelisted && !isRoleChange && 
                !isRecovery && !isUpgrade) {
                delete pendingProposals[proposal.target];
            }
            delete proposals[proposalId];
            proposalCount -= 1;
            emit ProposalExpired(proposalId, proposal.proposalType, proposal.target);
            revert ProposalExpiredErr();
        }

        require(!proposal.hasApproved[msg.sender], "Already approved");
        
        proposal.hasApproved[msg.sender] = true;
        proposal.approvals++;
        
        emit ProposalApproved(proposalId, proposal.proposalType, msg.sender);
        
        if (proposal.approvals >= roleQuorum[ADMIN_ROLE] && 
            block.timestamp >= proposal.executionTime) {
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
        if (proposal.executed) revert ProposalAlreadyExecutedErr();
        if (roleQuorum[ADMIN_ROLE] < 2) revert InvalidQuorumErr(ADMIN_ROLE, roleQuorum[ADMIN_ROLE]);
        
        if (proposal.approvals >= roleQuorum[ADMIN_ROLE] && 
            block.timestamp >= proposal.executionTime) {
            _executeProposal(proposalId);
        } else {
            if (proposal.approvals < roleQuorum[ADMIN_ROLE]) {
                revert InsufficientApprovalsErr(proposal.approvals, roleQuorum[ADMIN_ROLE]);
            }
            if (block.timestamp < proposal.executionTime) {
                revert ProposalExecutionDelayNotMetErr(proposal.executionTime);
            }
        }
    }

    function _executeProposal(bytes32 proposalId) internal {
        UnifiedProposal storage proposal = proposals[proposalId];
        PendingProposals storage pending = pendingProposals[proposal.target];
        
        if (proposal.proposalType == ProposalType.Whitelist) {
            whitelistLockTime[proposal.target] = block.timestamp + WHITELIST_LOCK_DURATION;
            pending.flags &= ~WHITELIST_FLAG;
        } 
        else if (proposal.proposalType == ProposalType.RoleChange) {
            if (proposal.isAdd) {
                _grantRole(proposal.role, proposal.target);
                roleChangeTimeLock[proposal.target] = block.timestamp + ROLE_CHANGE_DELAY;
            } else {
                _revokeRole(proposal.role, proposal.target);
                if (roleChangeTimeLock[proposal.target] > 0) delete roleChangeTimeLock[proposal.target];
            }
            pending.flags &= ~ROLE_CHANGE_FLAG;
        }
        else if (proposal.proposalType == ProposalType.Recovery) {
            IERC20 token = IERC20(proposal.tokenAddress);
            require(token.transfer(proposal.target, proposal.amount), "Transfer failed");
            pending.flags &= ~RECOVERY_FLAG;
        }

        // Delete entire record if all flags are false
        bool isWhitelisted = (pending.flags & WHITELIST_FLAG) != 0;
        bool isRoleChange = (pending.flags & ROLE_CHANGE_FLAG) != 0;
        bool isRecovery = (pending.flags & RECOVERY_FLAG) != 0;
        bool isUpgrade = (pending.flags & UPGRADE_FLAG) != 0;
        if (!isWhitelisted && !isRoleChange && 
            !isRecovery && !isUpgrade) {
            delete pendingProposals[proposal.target];
        }
        if (!isUpgrade) {
            proposal.executed = true;
            emit ProposalExecuted(proposalId, proposal.proposalType, proposal.target);
        }
    }

    function getProposalDetails(bytes32 proposalId) 
        external 
        view 
        returns (
            ProposalType proposalType,
            address target,
            bytes32 role,
            uint256 amount,
            address tokenAddress,
            bool isAdd,
            uint256 approvals,
            uint256 expiryTime,
            uint256 executionTime,
            bool executed,
            bool hasApproved
        ) 
    {
        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.target == address(0)) revert ProposalNotFoundErr();
        
        return (
            proposal.proposalType,
            proposal.target,
            proposal.role,
            proposal.amount,
            proposal.tokenAddress,
            proposal.isAdd,
            proposal.approvals,
            proposal.expiryTime,
            proposal.executionTime,
            proposal.executed,
            proposal.hasApproved[msg.sender]
        );
    }

    function getPendingProposals() 
        external 
        view 
        returns (
            bytes32[] memory proposalIds,
            ProposalType[] memory types,
            address[] memory targets,
            uint256[] memory expiryTimes,
            bool[] memory executed
        ) 
    {
        // Create arrays with maximum possible size
        proposalIds = new bytes32[](proposalCount);
        types = new ProposalType[](proposalCount);
        targets = new address[](proposalCount);
        expiryTimes = new uint256[](proposalCount);
        executed = new bool[](proposalCount);

        // Track valid proposals
        uint256 validCount = 0;

        // Iterate through all addresses with pending proposals
        for (uint256 i = 0; i < proposalCount; i++) {
            // Get proposal from storage
            bytes32 proposalId = proposalRegistry[i];
            UnifiedProposal storage proposal = proposals[proposalId];
            
            if (proposal.target != address(0) && 
                !proposal.executed && 
                proposal.expiryTime > block.timestamp) {
                proposalIds[validCount] = proposalId;
                types[validCount] = proposal.proposalType;
                targets[validCount] = proposal.target;
                expiryTimes[validCount] = proposal.expiryTime;
                executed[validCount] = proposal.executed;
                validCount++;
            }
        }

        // Resize arrays to actual count
        assembly {
            mstore(proposalIds, validCount)
            mstore(types, validCount)
            mstore(targets, validCount)
            mstore(expiryTimes, validCount)
            mstore(executed, validCount)
        }

        return (proposalIds, types, targets, expiryTimes, executed);
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
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        if (wallet == address(0)) revert InvalidAddress(wallet);
        delete whitelistLockTime[wallet];
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
        require(quorum > 1, "Invalid quorum");
        roleQuorum[role] = quorum;
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
        roleTransactionLimit[role] = limit;
        emit TransactionLimitUpdated(role, limit);
    }

    // Pausing contract actions in emergency
    function emergencyPauseToken() 
        external 
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        require(block.timestamp >= lastEmergencyAction + EMERGENCY_COOLDOWN, "Cooldown active");
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        _pause();
        lastEmergencyAction = block.timestamp;
        emit EmergencyAction("Contract paused", block.timestamp, msg.sender);
    }

    // UnPausing contract actions after emergency to return to normal
    function emergencyUnpauseToken() 
        external 
        nonReentrant
        onlyRole(ADMIN_ROLE)
        updateActivityTimestamp 
    {
        require(block.timestamp >= lastEmergencyAction + EMERGENCY_COOLDOWN, "Cooldown active");
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        _unpause();
        lastEmergencyAction = block.timestamp;
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
        require(admin != msg.sender, "Cannot remove self");
        if (admin == address(0)) revert InvalidAddress(admin);
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        
        uint256 adminCount = getRoleMemberCount(ADMIN_ROLE);
        require(adminCount > 2, "Cannot remove last two admins");
        
        _revokeRole(ADMIN_ROLE, admin);
        if (roleChangeTimeLock[admin] > 0) delete roleChangeTimeLock[admin];
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
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        if (amount <= 0) revert AmountMustBePositive();
        if (amount > balanceOf(address(this))) revert ExceedsAvailableSupply(amount, balanceOf(address(this)));
        
        // Check transaction limit
        require(amount <= roleTransactionLimit[CONTRACT_OPERATOR_ROLE], "Exceeds role transaction limit");
        
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
        if (amount <= 0) revert AmountMustBePositive();
        if (to == address(0)) revert InvalidAddress(to);
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
        require(!_usedNonces[sourceChain][nonce], "Used nonce");
        if (!supportedChains[sourceChain]) revert UnsupportedChain(sourceChain);
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        if (amount <= 0) revert AmountMustBePositive();
        if (totalSupply() + amount > TOTAL_SUPPLY) {
            revert ExceedsMaximumSupply(amount, TOTAL_SUPPLY);
        }

        // Check transaction limit for bridge operations
        if (amount > roleTransactionLimit[BRIDGE_OPERATOR_ROLE]) revert LowAllowance(roleTransactionLimit[BRIDGE_OPERATOR_ROLE], amount);

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
        require(!_usedNonces[targetChain][nonce], "Used nonce");
        if (!supportedChains[targetChain]) revert UnsupportedChain(targetChain);
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        if (amount <= 0) revert AmountMustBePositive();
        if (balanceOf(address(this)) < amount) revert LowBalance(balanceOf(address(this)), amount);

        // Check transaction limit for bridge operations
        if (amount > roleTransactionLimit[BRIDGE_OPERATOR_ROLE]) revert LowAllowance(roleTransactionLimit[BRIDGE_OPERATOR_ROLE], amount);

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
        if (block.timestamp < roleChangeTimeLock[msg.sender] || roleChangeTimeLock[msg.sender] == 0) revert TimeLockActive(msg.sender);
        require(chainId > 0, "Invalid chain ID");
        supportedChains[chainId] = supported;
        emit SupportedChainChanged(chainId, supported, msg.sender);
    }

    // Activity monitoring functions
    function checkRoleActivity(address account) 
        external 
        view 
        returns (bool) 
    {
        return block.timestamp - lastActivityTime[account] <= INACTIVITY_THRESHOLD;
    }

    // Role transaction limit getter
    function getRoleTransactionLimit(bytes32 role) 
        external 
        view 
        returns (uint256) 
    {
        return roleTransactionLimit[role];
    }

    // Role quorum getter
    function getRoleQuorum(bytes32 role) 
        external 
        view 
        returns (uint256) 
    {
        return roleQuorum[role];
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
        
        // Check quorum requirements
        if (roleQuorum[CONTRACT_OPERATOR_ROLE] < 2) {
            revert InvalidQuorumErr(CONTRACT_OPERATOR_ROLE, roleQuorum[CONTRACT_OPERATOR_ROLE]);
        }
        
        // Find the active upgrade proposal for this implementation
        bytes32 proposalId;
        bytes32 currentId = upgradeProposals[newImplementation];
        
        if (currentId == 0) revert ProposalNotFoundErr();
        UnifiedProposal storage currentProposal = proposals[currentId];
        if (currentProposal.proposalType == ProposalType.Upgrade && 
            currentProposal.target == newImplementation &&
            ! currentProposal.executed &&
            currentProposal.expiryTime > block.timestamp) {
            proposalId = currentId;
        } else {
            revert ProposalNotFoundErr();
        }
        
        UnifiedProposal storage proposal = proposals[proposalId];
        PendingProposals storage pending = pendingProposals[proposal.target];
        if (proposal.target == address(0)) revert InvalidAddress(proposal.target);
        if (proposal.executed) revert ProposalAlreadyExecutedErr();
        if (proposal.proposalType != ProposalType.Upgrade) revert InvalidProposalTypeErr(proposal.proposalType);
        
        if (proposal.approvals < roleQuorum[CONTRACT_OPERATOR_ROLE]) revert InsufficientApprovalsErr(roleQuorum[CONTRACT_OPERATOR_ROLE], proposal.approvals);
        if (block.timestamp < proposal.executionTime) revert ProposalExecutionDelayNotMetErr(proposal.executionTime);
        delete upgradeProposals[newImplementation];
        currentProposal.executed = true;
        pending.flags &= ~UPGRADE_FLAG;
        bool isWhitelisted = (pending.flags & WHITELIST_FLAG) != 0;
        bool isRoleChange = (pending.flags & ROLE_CHANGE_FLAG) != 0;
        bool isRecovery = (pending.flags & RECOVERY_FLAG) != 0;
        bool isUPgrade = (pending.flags & UPGRADE_FLAG) != 0;
        if (!isWhitelisted && !isRoleChange && 
            !isRecovery && !isUPgrade) {
            delete pendingProposals[proposal.target];
        }
        emit ProposalExecuted(proposalId, proposal.proposalType, proposal.target);
    }

    uint256[45] private __gap; // Reduced gap size to accommodate new storage variables
}