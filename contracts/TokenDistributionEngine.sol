// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "hardhat/console.sol";

import "./StorageToken.sol";

contract TokenDistributionEngine is ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint8 PROPOSED_ADD = 1;
    uint8 PROPOSED_REMOVE = 2;
    uint256 private constant ROLE_CHANGE_DELAY = 1 days;


    StorageToken public storageToken;
    // multi -sig variable definitions
    enum ProposalType { AddWallets, RemoveWallet }
    struct UnifiedProposal {
        address target;
        uint256 capId;
        uint256[] allocations;
        string[] names;
        address[] wallets;
        uint32 approvals;
        uint256 expiryTime;
        uint256 executionTime;
        uint8 proposalType;
        mapping(address => bool) hasApproved;
    }
    uint256 private constant MIN_PROPOSAL_EXECUTION_DELAY = 1 days;
    uint256 public proposalTimeout = 7 days;
    mapping(bytes32 => UnifiedProposal) public proposals;
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
    mapping(uint256 => uint256) public allocatedTokensPerCap; // Allocated tokens per cap
    mapping(address => mapping(uint256 => string)) public walletNames; // tag the wallet of each receiver
    bool public tgeInitiated;
    uint256[] public capIds;
    uint256 public totalTransferredTokens;
    uint256 public totalAllocatedToWallets;

    struct TimeConfig {
        uint64 lastActivityTime;
        uint64 roleChangeTimeLock;
        uint64 whitelistLockTime;
    }
    mapping(address => TimeConfig) public timeConfigs;
    struct RoleConfig {
        uint32 quorum;
        uint256 transactionLimit;
    }
    mapping(bytes32 => RoleConfig) public roleConfigs;


    event TGEInitiated(uint256 startTime);
    event VestingCapAdded(uint256 id, string name);
    event WalletsAddedToCap(uint256 capId, address[] wallets);
    event TokensClaimed(address indexed receiver, uint256 capId, uint256 dueTokens, uint256 chainId);
    event EmergencyAction(string action, uint256 timestamp);
    event TokensAllocatedToContract(uint256 indexed capId, uint256 amount, string tag);
    //multi-sign events
    event ProposalCreated(
        bytes32 indexed proposalId, 
        ProposalType indexed proposalType, 
        address indexed proposer,
        uint256 capId
    );
    event ProposalApproved(bytes32 indexed proposalId, address indexed approver);
    event ProposalExecuted(bytes32 indexed proposalId);
    event ProposalExpired(bytes32 indexed proposalId);
    event WalletRemoved(address indexed wallet, uint256 indexed capId);
    event CapRemoved(uint256 indexed capId);
    event QuorumUpdated(bytes32 indexed role, uint256 newQuorum);

    error InsufficientContractBalance(address contractAddr, uint256 available, uint256 required);
    error CliffNotReached(uint256 currentTime, uint256 startDate, uint256 cliffEnd);
    error AllocationTooHigh(address walletAddr, uint256 walletAllocation, uint256 maxAllocation, uint256 capId);
    // multi-sig errors
    error ProposalNotFound();
    error ProposalExpiredErr();
    error ProposalAlreadyExecuted();
    error ProposalAlreadyApproved();
    error InsufficientApprovals(uint32 required, uint32 current);
    error ProposalExecutionDelayNotMet(uint256 allowedTime);
    error CapHasWallets();
    error TimeLockActive(address operator);
    error InvalidQuorumErr(bytes32 role, uint32 quorum);

    function initialize(
        address _storageToken,
        address initialOwner,
        address initialAdmin
    ) public reinitializer(1) {
        require(initialOwner != address(0), "Invalid owner address");
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __Pausable_init();
        require(_storageToken != address(0), "Invalid StorageToken address");

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
       // Set timelocks using packed TimeConfig struct
        uint256 lockTime = block.timestamp + ROLE_CHANGE_DELAY;
        
        TimeConfig storage ownerTimeConfig = timeConfigs[initialOwner];
        ownerTimeConfig.roleChangeTimeLock = uint64(lockTime);
        
        TimeConfig storage adminTimeConfig = timeConfigs[initialAdmin];
        adminTimeConfig.roleChangeTimeLock = uint64(lockTime);

        storageToken = StorageToken(_storageToken);

        // Approve distribution contract to spend tokens
        require(
            storageToken.approve(address(this), type(uint256).max),
            "Initial approval failed"
        );
    }

    // Update the last activity that an address has done
    modifier updateActivityTimestamp() {
        // Use TimeConfig struct for activity timestamp
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        timeConfig.lastActivityTime = uint64(block.timestamp);
        _;
    }

    function emergencyPauseDistribution() external onlyRole(ADMIN_ROLE) {
        _pause();
        emit EmergencyAction("Distribution paused", block.timestamp);
    }

    function emergencyUnpauseDistribution() external onlyRole(ADMIN_ROLE) {
        _unpause();
        emit EmergencyAction("Distribution unpaused", block.timestamp);
    }

    function getCapWallets(uint256 capId) external view returns (address[] memory) {
        return capWallets[capId];
    }

    function InitiateTGE() external onlyRole(ADMIN_ROLE) {
        require(!tgeInitiated, "TGE already initiated");
        uint256 allocatedToCaps = 0;
        tgeInitiated = true;

        for (uint256 i = 0; i < capIds.length; i++) {
            uint256 capId = capIds[i];
            if (vestingCaps[capId].totalAllocation > 0) {
                allocatedToCaps += vestingCaps[capId].totalAllocation;
            }
            vestingCaps[capId].startDate = block.timestamp;
        }
        require(allocatedToCaps >= totalAllocatedToWallets, "Total tokens allocated ot wallets exceed the allocation caps");
        require(_checkAllocatedTokensToContract(0), "Not enough tokens are transferred to the token");
        emit TGEInitiated(block.timestamp);
    }

    function addVestingCap(
        uint256 capId,
        string memory name,
        uint256 totalAllocation,
        uint256 cliff, // cliff in days
        uint256 vestingTerm, // linear vesting duration in months
        uint256 vestingPlan, // Intervals at which the user can claim in months. 1 means monthly and 3 means quarterly
        uint256 initialRelease // percentage that is released after cliff
    ) external onlyRole(DISTRIBUTOR_ROLE) {
        require(vestingCaps[capId].totalAllocation == 0, "Cap already exists");
        require(totalAllocation > 0, "Allocation to this cap should be greater than 0");
        require(initialRelease <= 100, "Invalid initial release percentage");
        require(vestingPlan < vestingTerm, "Vesting plan cannot be longer than vesting term");
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
            require(_checkAllocatedTokensToContract(totalAllocation), "Not enough tokens are transferred to the token");
        }

        capIds.push(capId);

        emit VestingCapAdded(capId, name);
    }

    function _checkAllocatedTokensToContract(uint256 amount) internal view returns (bool) {
        require(amount+totalAllocatedToWallets <= storageToken.totalSupply(), "Allocated tokens for distribution is larger than total token cap");
        uint256 availableBalance = storageToken.balanceOf(address(this));
        uint256 requiredBalance = amount + totalAllocatedToWallets;

        if (availableBalance < requiredBalance) {
            revert InsufficientContractBalance(address(this), availableBalance, requiredBalance);
        }

        return true;
    }


    function proposeAddWalletsToCap(
        uint256 capId,
        address[] memory wallets,
        string[] memory names,
        uint256[] memory totalAllocationToWallet
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) returns (bytes32) {
        require(vestingCaps[capId].totalAllocation > 0, "Invalid cap ID");
        require(wallets.length == names.length, "Names Length mismatch");
        require(wallets.length == totalAllocationToWallet.length, "Wallets Length mismatch");
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        RoleConfig storage roleConfig = roleConfigs[ADMIN_ROLE];
        if (roleConfig.quorum < 2) revert InvalidQuorumErr(ADMIN_ROLE, roleConfig.quorum);

        for (uint256 i = 0; i < wallets.length; i++) {
            address wallet = wallets[i];
            uint256 allocationForWallet = totalAllocationToWallet[i];
            require(totalAllocatedToWallets + allocationForWallet <= storageToken.totalSupply(), "Not enough balance in the token contract to cover the cap");
            uint256 maxAllocation = vestingCaps[capId].totalAllocation - allocatedTokensPerCap[capId];
            if (allocationForWallet > maxAllocation) {
                revert AllocationTooHigh(wallet, allocationForWallet, maxAllocation, capId);
            }
            console.log("allocatedTokensPerCap[capId]", allocatedTokensPerCap[capId]);
            console.log("vestingCaps[capId].totalAllocation", vestingCaps[capId].totalAllocation);
            console.log("allocationForWallet", allocationForWallet);
            require(allocatedTokens[wallet][capId] == 0, "Wallet already added");
            require(allocationForWallet > 0, "Allocation must be greater than zero");
            if (tgeInitiated) {
                require(storageToken.balanceOf(address(this)) >= allocationForWallet, "Insufficient contract balance");
            }

            require(allocatedTokens[wallet][capId] == 0, "Wallet already added");
            require(proposedWallets[wallet][capId] == 0, "Wallet already proposed");
            proposedWallets[wallet][capId] |= PROPOSED_ADD;
        }

        bytes32 proposalId = keccak256(abi.encodePacked(
            uint8(ProposalType.AddWallets),
            capId,
            block.timestamp
        ));

        UnifiedProposal storage proposal = proposals[proposalId];
        proposal.capId = capId;
        proposal.wallets = wallets;
        proposal.names = names;
        proposal.allocations = totalAllocationToWallet;
        proposal.expiryTime = block.timestamp + proposalTimeout;
        proposal.executionTime = block.timestamp + MIN_PROPOSAL_EXECUTION_DELAY;
        proposal.approvals = 1;
        proposal.proposalType = uint8(ProposalType.AddWallets);
        proposal.hasApproved[msg.sender] = true;

        proposalRegistry[proposalCount++] = proposalId;

        emit ProposalCreated(proposalId, ProposalType.AddWallets, msg.sender, capId);
        return proposalId;
    }

    function proposeRemoveWallet(
        address wallet,
        uint256 capId
    ) external whenNotPaused onlyRole(DISTRIBUTOR_ROLE) returns (bytes32) {
        require(allocatedTokens[wallet][capId] > 0, "Wallet not in cap");
        require(proposedWallets[wallet][capId] == 0, "Wallet already proposed");
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        RoleConfig storage roleConfig = roleConfigs[DISTRIBUTOR_ROLE];
        if (roleConfig.quorum < 2) revert InvalidQuorumErr(DISTRIBUTOR_ROLE, roleConfig.quorum);

        proposedWallets[wallet][capId] |= PROPOSED_REMOVE;
        
        bytes32 proposalId = keccak256(abi.encodePacked(
            uint8(ProposalType.RemoveWallet),
            wallet,
            capId,
            block.timestamp
        ));

        UnifiedProposal storage proposal = proposals[proposalId];
        proposal.target = wallet;
        proposal.capId = capId;
        proposal.expiryTime = block.timestamp + proposalTimeout;
        proposal.executionTime = block.timestamp + MIN_PROPOSAL_EXECUTION_DELAY;
        proposal.approvals = 1;
        proposal.proposalType = uint8(ProposalType.RemoveWallet);
        proposal.hasApproved[msg.sender] = true;

        proposalRegistry[proposalCount++] = proposalId;

        emit ProposalCreated(proposalId, ProposalType.RemoveWallet, msg.sender, capId);
        return proposalId;
    }

    function approveProposal(bytes32 proposalId) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(DISTRIBUTOR_ROLE) 
    {
        UnifiedProposal storage proposal = proposals[proposalId];
        if (proposal.expiryTime == 0) revert ProposalNotFound();
        if (proposal.hasApproved[msg.sender]) revert ProposalAlreadyApproved();
        if (block.timestamp >= proposal.expiryTime) {
            delete proposals[proposalId];
            revert ProposalExpiredErr();
        }
        TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);
        
        RoleConfig storage roleConfig = roleConfigs[DISTRIBUTOR_ROLE];
        if (quorum < 2) {
            revert InvalidQuorumErr(DISTRIBUTOR_ROLE, roleConfig.quorum);
        }
        
        proposal.hasApproved[msg.sender] = true;
        proposal.approvals++;
        
        emit ProposalApproved(proposalId, msg.sender);
        
        if (proposal.approvals >= roleConfig.quorum && 
            block.timestamp >= proposal.executionTime) {
            _executeProposal(proposalId);
        }
    }

    function removeCap(uint256 capId) external onlyRole(ADMIN_ROLE) {
        require(vestingCaps[capId].totalAllocation > 0, "Cap doesn't exist");
        if (capWallets[capId].length > 0) revert CapHasWallets();
        
        delete vestingCaps[capId];
        delete allocatedTokensPerCap[capId];
        
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

    function _executeProposal(bytes32 proposalId) internal {
        UnifiedProposal storage proposal = proposals[proposalId];
        
        if (uint8(ProposalType.AddWallets) == proposal.proposalType) {
            for (uint256 i = 0; i < proposal.wallets.length; i++) {
                address wallet = proposal.wallets[i];
                string memory name = bytes(proposal.names[i]).length > 0 ? proposal.names[i] : "Unnamed Wallet"; // Default name if empty
                // Check if the contract has enough token balance for this cap
                uint256 allocationForWallet = proposal.allocations[i];
                require(totalAllocatedToWallets + allocationForWallet <= storageToken.totalSupply(), "Not enough balance in the token contract to cover the cap");
                uint256 maxAllocation = vestingCaps[proposal.capId].totalAllocation - allocatedTokensPerCap[proposal.capId];
                if (allocationForWallet > maxAllocation) {
                    revert AllocationTooHigh(wallet, allocationForWallet, maxAllocation, proposal.capId);
                }
                
                require(allocatedTokens[wallet][proposal.capId] == 0, "Wallet already added");
                require(allocationForWallet > 0, "Invalid allocation");
                if (tgeInitiated) {
                    require(storageToken.balanceOf(address(this)) >= allocationForWallet, "Insufficient contract balance");
                }
                
                allocatedTokens[wallet][proposal.capId] = allocationForWallet;
                capWallets[proposal.capId].push(wallet);
                walletNames[wallet][proposal.capId] = name;
                totalAllocatedToWallets += allocationForWallet;
                allocatedTokensPerCap[proposal.capId] += allocationForWallet;
                console.log("Wallet added", proposal.wallets[i]);
            }
            emit WalletsAddedToCap(proposal.capId, proposal.wallets);
        } 
        else if (uint8(ProposalType.RemoveWallet) == proposal.proposalType) {
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
        }
        
        emit ProposalExecuted(proposalId);
        delete proposals[proposalId];
    }


    function calculateDueTokens(address wallet, uint256 capId) public view returns (uint256) {
        VestingCap memory cap = vestingCaps[capId];

        // Ensure cliff has been reached
        if (cap.startDate == 0 || block.timestamp < cap.startDate + cap.cliff) {
            revert CliffNotReached(block.timestamp, cap.startDate, cap.startDate + cap.cliff);
        }

        // Ensure allocation exists
        uint256 allocation = allocatedTokens[wallet][capId];
        require(allocation > 0, "No allocation for wallet");

        // Calculate elapsed time since cliff
        uint256 elapsedTime = block.timestamp - (cap.startDate + cap.cliff);

        // Calculate vested months based on discrete intervals
        uint256 vestedIntervals = elapsedTime / cap.vestingPlan;
        uint256 vestedMonths = vestedIntervals * cap.vestingPlan / (30 days);
        if (vestedMonths > cap.vestingTerm) {
            vestedMonths = cap.vestingTerm; // Cap at total vesting term
        }

        // Calculate total claimable tokens
        uint256 intialRelease = (allocation * cap.initialRelease) / 100;
        uint256 totalClaimable = intialRelease + ((allocation - intialRelease) * vestedMonths * 30 days) / cap.vestingTerm;

        console.log("Start Date:", cap.startDate);
        console.log("Block Timestamp:", block.timestamp);
        console.log("allocation:", allocation);
        console.log("cap.initialRelease:", cap.initialRelease);
        console.log("vestedMonths:", vestedMonths);
        console.log("cap.vestingTerm:", cap.vestingTerm);
        console.log("cap.cliff:", cap.cliff);
        console.log("totalClaimable:", totalClaimable);
        console.log("cap.vestingPlan:", cap.vestingPlan);
        console.log("vestedIntervals:", vestedIntervals);
        console.log("claimedTokens[wallet][capId]:", claimedTokens[wallet][capId]);

        // Subtract already claimed tokens
        uint256 dueTokens = totalClaimable - claimedTokens[wallet][capId];

        // Ensure due tokens are non-negative
        if (dueTokens < 0) {
            dueTokens = 0;
        }

        return dueTokens;
    }

    function claimTokens(uint256 capId, uint256 chainId) external whenNotPaused nonReentrant {
        require(tgeInitiated, "TGE has not happened and claiming is disabled");
        uint256 dueTokens = calculateDueTokens(msg.sender, capId);

        require(dueTokens > 0, "No tokens due");

        // Update claimed tokens for the user
        console.log("Paused state:", paused());
        console.log("claimedTokens updated +dueTokens", dueTokens);
        claimedTokens[msg.sender][capId] += dueTokens;

        // Transfer tokens from this contract's balance to the receiver
        require(storageToken.balanceOf(address(this)) >= dueTokens, "Insufficient contract balance");
        require(storageToken.transfer(msg.sender, dueTokens), "Token transfer failed");

        emit TokensClaimed(msg.sender, capId, dueTokens, chainId);
    }

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


    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
