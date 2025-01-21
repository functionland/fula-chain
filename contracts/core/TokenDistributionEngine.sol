// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../governance/GovernanceModule.sol";

/// @title TokenDistributionEngine
/// @notice Handles token distribution with vesting and cliff periods
/// @dev Inherits governance functionality from GovernanceModule
contract TokenDistributionEngine is GovernanceModule {
    using SafeERC20 for IERC20;

    PackedVars private packedVars;

    // @notice Wallet details in the cap
    struct VestingWalletInfo {
        uint256 capId;
        bytes32 name; // Name of entity holding the wallet
        uint256 amount; // Amount allocated to this wallet
        uint256 claimed; // Amount that recipient has claimed
    }

    /// @notice Cap parameters struct
    struct VestingCap {
        uint256 totalAllocation;
        bytes32 name; //name for this cap
        uint256 cliff; // in days
        uint256 vestingTerm; // in months
        uint256 vestingPlan; // in months
        uint256 initialRelease; // percentage (e.g., 10% = 10)
        uint256 startDate; // TGE start date
        uint256 allocatedToWallets; //Amount allocated to wallets in this cap
        address[] wallets; //wallets in this cap
    }

    

    /// @notice Storage variables
    IERC20 public storageToken;
    mapping(uint256 => VestingCap) public vestingCaps; // vestingCaps[capId] = VestingCap
    mapping(address => mapping(uint256 => VestingWalletInfo)) public vestingWallets; // vestingWallets[walletAddress][capId] = VestingWalletInfo
    uint256[] public capIds;

    /// @notice Events
    event TokenDistributionInitialized(address indexed token);
    event TGEInitiated(uint256 totalAllocation, uint256 timestamp);
    event VestingCapAction(uint256 id, bytes32 name, uint8 action); //1: ADD, 2: REMOVE
    event TokensClaimed(address indexed beneficiary, uint256 amount);
    event ClaimProcessed(
        address indexed beneficiary, 
        uint256 indexed capId, 
        uint256 amount, 
        uint256 timestamp, 
        uint256 chainId
    );
    event DistributionWalletAdded(address indexed beneficiary, uint256 amount, uint256 startTime, uint256 cliffPeriod, uint256 vestingPeriod);
    event DistributionWalletRemoved(address indexed wallet, uint256 indexed capId);
    event TokensReturnedToStorage(uint256 amount);


    error TGENotInitiated();
    error NothingDue();
    error LowContractBalance(uint256 available, uint256 required);
    error TransferFailed();


    /// @notice Custom errors
    error InvalidAllocationParameters();
    error NothingToClaim();
    error CliffNotReached(uint256 currentTime, uint256 startDate, uint256 cliffEnd);
    error OperationFailed(uint8 stauts); //1: resetting max allowance failed, 2: approving allowance failed, 3: allowance is not set
    error TGEAlreadyInitiated();
    error AllocationTooHigh(address wallet, uint256 allocated, uint256 maximum, uint256 capId);
    error InsufficientContractBalance(uint256 required, uint256 available);
    error CapExists(uint256 capId);
    error InvalidAllocation();
    error InitialReleaseTooLarge();
    error OutOfRangeVestingPlan();
    error CapHasWallets();
    error ExceedsMaximumSupply(uint256 amount);
    error StartDateNotSet(uint256 capId);
    error WalletExistsInCap(address wallet, uint256 capId);
    error InvalidCapId(uint256 capId);
    error WalletNotInCap(address wallet, uint256 capId);

    /// @notice Initialize the contract
    /// @param _storageToken Address of the token to distribute
    /// @param initialOwner Address of the initial owner
    /// @param initialAdmin Address of the initial admin
    function initialize(
        address _storageToken,
        address initialOwner,
        address initialAdmin
    ) public reinitializer(1) {
        // Validate addresses
        if (_storageToken == address(0)) revert InvalidAddress();
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();
        
        // Initialize governance module (handles UUPSUpgradeable, Ownable, ReentrancyGuard, 
        // Pausable, AccessControlEnumerable, role grants, and timelocks)
        __GovernanceModule_init(initialOwner, initialAdmin);
        
        // Initialize distribution settings
        PackedVars storage vars = packedVars;
        if ((vars.flags & INITIATED) == 0) {
            storageToken = IERC20(_storageToken);

            // Use SafeERC20 for approvals
            try storageToken.approve(address(this), 0) {
                try storageToken.approve(address(this), type(uint256).max) {
                    uint256 newAllowance = storageToken.allowance(address(this), address(this));
                    if (newAllowance != type(uint256).max) revert OperationFailed(1);
                } catch {
                    revert OperationFailed(2);
                }
            } catch {
                revert OperationFailed(3);
            }

            proposalCount = 0;
            vars.flags |= INITIATED;
            emit TokenDistributionInitialized(_storageToken);
        }
    }

    /// @notice Initiate Token Generation Event to start Vesting and Distribution of pre-allocated tokens
    function initiateTGE() 
        external 
        nonReentrant 
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        PackedVars storage vars = packedVars;
        if ((vars.flags & TGE_INITIATED) != 0) revert TGEAlreadyInitiated();
        
        // Calculate total required tokens across all caps
        uint256 totalRequiredTokens = 0;
        
        // First pass: validate caps and calculate total required tokens
        for (uint256 i = 0; i < capIds.length; i++) {
            uint256 capId = capIds[i];
            VestingCap storage cap = vestingCaps[capId];
            
            if (cap.totalAllocation > 0) {
                // Ensure start date is properly set to tge date
                cap.startDate = block.timestamp;
                
                // Add to total required tokens
                totalRequiredTokens += cap.totalAllocation;
                
                // Verify cap allocation matches wallet allocations
                if (cap.totalAllocation < cap.allocatedToWallets) {
                    revert AllocationTooHigh(
                        address(0), 
                        cap.allocatedToWallets, 
                        cap.totalAllocation, 
                        capId
                    );
                }
            }
        }

        // Verify contract has sufficient tokens
        uint256 contractBalance = storageToken.balanceOf(address(this));
        if (contractBalance < totalRequiredTokens) {
            revert InsufficientContractBalance(totalRequiredTokens, contractBalance);
        }

        // Set TGE initiated flag
        vars.flags |= TGE_INITIATED;
        
        // Update activity timestamp
        _updateActivityTimestamp();
        
        emit TGEInitiated(totalRequiredTokens, block.timestamp);
    }

    /// @notice Create a new vesting cap
    /// @param capId a unique id
    /// @param name the name of this cap
    /// @param totalAllocation for this cap
    /// @param cliff in days
    /// @param vestingTerm linear vesting duration in months
    /// @param vestingPlan Intervals at which the user can claim in months. 1 means monthly and 3 means quarterly
    /// @param initialRelease percentage that is released after cliff
    function addVestingCap(
        uint256 capId,
        bytes32 name,
        uint256 totalAllocation,
        uint256 cliff, // cliff in days
        uint256 vestingTerm, // linear vesting duration in months
        uint256 vestingPlan, // Intervals at which the user can claim in months. 1 means monthly and 3 means quarterly
        uint256 initialRelease // percentage that is released after cliff
    ) 
        external 
        nonReentrant 
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        if(vestingCaps[capId].totalAllocation != 0) revert CapExists(capId);
        if(totalAllocation <= 0) revert InvalidAllocation();
        if(initialRelease > 100) revert InitialReleaseTooLarge();
        if(vestingPlan >= vestingTerm) revert OutOfRangeVestingPlan();
        
        uint256 defaultStartDate = block.timestamp + (30 * 365 days);

        vestingCaps[capId] = VestingCap({
            totalAllocation: totalAllocation,
            name: name,
            cliff: cliff * 1 days,
            vestingTerm: vestingTerm * 30 days,
            vestingPlan: vestingPlan * 30 days,
            initialRelease: initialRelease,
            startDate: defaultStartDate,
            allocatedToWallets: 0,
            wallets: new address[](0)
        });

        // Check if TGE is initiated
        PackedVars storage vars = packedVars;
        if ((vars.flags & TGE_INITIATED) != 0) {
            if (!_checkAllocatedTokensToContract(totalAllocation)) {
                revert InsufficientContractBalance(
                    totalAllocation,
                    storageToken.balanceOf(address(this))
                );
            }
        }

        capIds.push(capId);
        _updateActivityTimestamp();
        emit VestingCapAction(capId, name, 1);
    }

    /// @notice Removes an empty vesting cap
    /// @param capId the unique id
    function removeVestingCap(uint256 capId) 
        external 
        nonReentrant 
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        VestingCap storage cap = vestingCaps[capId];
        bytes32 capName = cap.name;
        if(cap.totalAllocation <= 0) revert InvalidCapId(capId);
        if(cap.allocatedToWallets > 0 || cap.wallets.length > 0) revert CapHasWallets();

        // Clean up all role assignments and permissions for this cap
        delete vestingCaps[capId];
        address[] storage wallets = cap.wallets;
        for (uint i = 0; i < wallets.length; i++) {
            delete pendingProposals[wallets[i]];
        }
        
        // Remove from capIds array
        for (uint i = 0; i < capIds.length; i++) {
            if (capIds[i] == capId) {
                capIds[i] = capIds[capIds.length - 1];
                capIds.pop();
                break;
            }
        }
        
        _updateActivityTimestamp();
        emit VestingCapAction(capId, capName, 2);
    }

    /// @notice Removes a wallet from the vesting cap and any pending proposal
    /// @param capId the unique id
    /// @param wallet the wallet address to be removed from cap
    function _removeWallet(uint256 capId, address wallet) internal whenNotPaused  onlyRole(ProposalTypes.ADMIN_ROLE) {
        VestingCap storage cap = vestingCaps[capId];
        address[] storage wallets = cap.wallets;
        for (uint i = 0; i < wallets.length; i++) {
            if(wallet == wallets[i]) {
                wallets[i] = wallets[capIds.length - 1];
                wallets.pop();
                break;
            }
        }
        delete vestingWallets[wallet][capId];
    }

    function _checkAllocatedTokensToContract(uint256 amount) internal view returns (bool) {
        uint256 totalSupply = storageToken.totalSupply();
        uint256 totalAllocated = 0;
        
        // Calculate total allocated across all caps
        for (uint256 i = 0; i < capIds.length; i++) {
            VestingCap storage cap = vestingCaps[capIds[i]];
            totalAllocated += cap.allocatedToWallets;
        }
        
        if (amount + totalAllocated > totalSupply) {
            revert ExceedsMaximumSupply(amount + totalAllocated);
        }
        
        uint256 availableBalance = storageToken.balanceOf(address(this));
        uint256 requiredBalance = amount + totalAllocated;

        if (availableBalance < requiredBalance) {
            revert InsufficientContractBalance(requiredBalance, availableBalance);
        }

        return true;
    }

    /// @notice Calculate claimable amount for an address
    /// @param wallet Address to check claimable amount for
    /// @param capId capId which the beneficiary is claiming tokens from
    /// @return Amount of tokens claimable
    function calculateDueTokens(address wallet, uint256 capId) public view returns (uint256) {
        VestingCap storage cap = vestingCaps[capId];
        VestingWalletInfo storage walletInfo = vestingWallets[wallet][capId];
        if(cap.vestingPlan == 0) revert InvalidAllocationParameters();

        uint256 allocation = walletInfo.amount;
        if(allocation <= 0) revert NothingToClaim();
        
        // Initial validations
        if (cap.startDate == 0 || block.timestamp < cap.startDate + cap.cliff) {
            revert CliffNotReached(block.timestamp, cap.startDate, cap.startDate + cap.cliff);
        }

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

        // Handle claimed tokens - now part of VestingWalletInfo
        uint256 claimed = vestingWallets[wallet][capId].claimed;
        if (totalClaimable <= claimed) {
            return 0;
        }

        return totalClaimable - claimed;
    }

    /// @notice Claim vested tokens. Automatically calculates based on vesting schedule and transfers if anything is due
    function claimTokens(uint256 capId, uint256 chainId) 
        external 
        nonReentrant 
        whenNotPaused 
    {
        // Check if TGE is initiated using packed vars
        PackedVars storage vars = packedVars;
        if ((vars.flags & TGE_INITIATED) == 0) revert TGENotInitiated();

        // Calculate due tokens
        uint256 dueTokens = calculateDueTokens(msg.sender, capId);
        if (dueTokens <= 0) revert NothingDue();

        // Update claimed tokens in the wallet info
        VestingWalletInfo storage walletInfo = vestingWallets[msg.sender][capId];
        walletInfo.claimed += dueTokens;

        // Check contract balance and transfer tokens
        uint256 contractBalance = storageToken.balanceOf(address(this));
        if (contractBalance < dueTokens) {
            revert LowContractBalance(contractBalance, dueTokens);
        }

        // Use SafeERC20 for transfer
        try storageToken.transfer(msg.sender, dueTokens) {
            _updateActivityTimestamp();
            emit TokensClaimed(msg.sender, dueTokens);
            emit ClaimProcessed(msg.sender, capId, dueTokens, block.timestamp, chainId);
        } catch {
            revert TransferFailed();
        }
    }


    /// @notice Handles proposal creation for adding a wallet to a vesting cap
    /// @param proposalType from the ProposalTypes.sol
    /// @param target the wallet that intends to receive the tokens
    /// @param role This stores the name of the recipient
    /// @param amount this is the total amount allocated to the recipient
    function _createCustomProposal(
        uint8 proposalType,
        uint40 id,
        address target,
        bytes32 role,
        uint96 amount,
        address
    ) internal virtual override returns (bytes32) {
        // For adding wallet to cap
        if (proposalType == uint8(ProposalTypes.ProposalType.AddDistributionWallets)) {
            // amount parameter is used as capId
            uint40 capId = id;
            
            // Validate cap exists and has space
            VestingCap storage cap = vestingCaps[capId];
            if (cap.totalAllocation == 0) revert InvalidCapId(capId);
            if (cap.allocatedToWallets + amount > cap.totalAllocation) {
                revert AllocationTooHigh(target, amount, cap.totalAllocation - cap.allocatedToWallets, capId);
            }

            // Check if wallet already exists in cap
            if (vestingWallets[target][capId].amount > 0) {
                revert WalletExistsInCap(target, capId);
            }

            // Check for existing proposals
            if (pendingProposals[target].proposalType != 0) {
                revert ExistingActiveProposal(target);
            }

            bytes32 proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(target, capId, role))
            );

            ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
            _initializeProposal(
                proposal,
                target
            );

            // Store proposal data
            proposal.proposalType = proposalType;
            proposal.role = role; // Used to store wallet name
            proposal.amount = amount; // Amount to allocate
            proposal.id = capId; // Store capId
            
            // Mark pending proposal
            pendingProposals[target].proposalType = proposalType;

            return proposalId;
        }
        // For removing wallet from cap
        else if (proposalType == uint8(ProposalTypes.ProposalType.RemoveDistributionWallet)) {
            uint40 capId = id;
            
            // Validate wallet exists in cap
            if (vestingWallets[target][capId].amount == 0) {
                revert WalletNotInCap(target, capId);
            }

            // Check for existing proposals
            if (pendingProposals[target].proposalType != 0) {
                revert ExistingActiveProposal(target);
            }

            bytes32 proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(target, capId))
            );

            ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
            _initializeProposal(
                proposal,
                target
            );

            // Store proposal data
            proposal.proposalType = proposalType;
            proposal.id = capId; // Store capId
            
            // Mark pending proposal
            pendingProposals[target].proposalType = proposalType;

            return proposalId;
        }
        
        revert InvalidProposalType(proposalType);
    }

    function _handleCustomProposalExpiry(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        if (proposal.proposalType == uint8(ProposalTypes.ProposalType.AddDistributionWallets)) {
            // Clean up pending proposal for the target wallet
            delete pendingProposals[proposal.target];
        }
        else if (proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveDistributionWallet)) {
            // Clean up pending proposal for the target wallet
            delete pendingProposals[proposal.target];
        }
    }

    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        if (proposal.proposalType == uint8(ProposalTypes.ProposalType.AddDistributionWallets)) {
            // Decode capId from proposal data
            uint256 capId = proposal.id;
            
            // Validate vesting cap exists and has start date
            VestingCap storage cap = vestingCaps[capId];
            if (cap.startDate == 0) revert StartDateNotSet(capId);

            // Get wallet details from proposal
            address wallet = proposal.target;
            bytes32 name = proposal.role != bytes32(0) ? proposal.role : bytes32("Unnamed Wallet");
            uint256 allocationAmount = proposal.amount;

            // Validate allocation
            if (allocationAmount <= 0) revert InvalidAllocation();
            if (vestingWallets[wallet][capId].amount != 0) revert WalletExistsInCap(wallet, capId);
            
            // Check total supply limits
            if (allocationAmount > storageToken.totalSupply()) {
                revert ExceedsMaximumSupply(allocationAmount);
            }

            // Check cap allocation limits
            uint256 maxAllocation = cap.totalAllocation - cap.allocatedToWallets;
            if (allocationAmount > maxAllocation) {
                revert AllocationTooHigh(wallet, allocationAmount, maxAllocation, capId);
            }

            // Check contract balance if TGE initiated
            PackedVars storage vars = packedVars;
            if ((vars.flags & TGE_INITIATED) != 0) {
                uint256 contractBalance = storageToken.balanceOf(address(this));
                if (contractBalance < allocationAmount) {
                    revert InsufficientContractBalance(allocationAmount, contractBalance);
                }
            }

            // Create wallet info
            vestingWallets[wallet][capId] = VestingWalletInfo({
                capId: capId,
                name: name,
                amount: allocationAmount,
                claimed: 0
            });

            // Update cap
            cap.allocatedToWallets += allocationAmount;
            cap.wallets.push(wallet);

            emit DistributionWalletAdded(
                wallet, 
                allocationAmount, 
                cap.startDate, 
                cap.cliff, 
                cap.vestingTerm
            );
        } 
        else if (proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveDistributionWallet)) {
            // Decode capId from proposal data
            uint256 capId = proposal.id;
            address wallet = proposal.target;
            
            // Get wallet and cap info
            VestingWalletInfo storage walletInfo = vestingWallets[wallet][capId];
            VestingCap storage cap = vestingCaps[capId];
            
            // Validate wallet exists in cap
            if (walletInfo.amount == 0) revert WalletNotInCap(wallet, capId);
            
            // Update cap allocation
            cap.allocatedToWallets -= walletInfo.amount;
            
            // Remove from cap wallets array
            address[] storage wallets = cap.wallets;
            for (uint i = 0; i < wallets.length; i++) {
                if (wallets[i] == wallet) {
                    wallets[i] = wallets[wallets.length - 1];
                    wallets.pop();
                    break;
                }
            }
            
            // Delete wallet info
            delete vestingWallets[wallet][capId];
            
            emit DistributionWalletRemoved(wallet, capId);
        }
        
        // Clean up pending proposal
        delete pendingProposals[proposal.target];
        
        _updateActivityTimestamp();
    }

    /// @notice Transfers tokens back to the StorageToken contract
    /// @param amount Amount of tokens to transfer back
    function transferBackToStorage(uint256 amount) 
        external 
        nonReentrant 
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        if (amount == 0) revert AmountMustBePositive();
        
        uint256 contractBalance = storageToken.balanceOf(address(this));
        if (contractBalance < amount) {
            revert LowContractBalance(contractBalance, amount);
        }

        // Use SafeERC20 for transfer
        try storageToken.transfer(address(storageToken), amount) {
            _updateActivityTimestamp();
            emit TokensReturnedToStorage(amount);
        } catch {
            revert TransferFailed();
        }
    }

    function _authorizeUpgrade(address newImplementation) 
        internal 
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
        override 
    {
        // Delegate the authorization to the governance module
        if (! _checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");

    }
}
