// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../governance/GovernanceModule.sol";
import "../libraries/VestingTypes.sol";
import "../libraries/VestingCalculator.sol";

contract TestnetMiningRewards is 
    GovernanceModule {
    using SafeERC20 for ERC20Upgradeable;
    using VestingCalculator for VestingTypes.VestingCap;

    PackedVars private packedVars;
    
    ERC20Upgradeable public storageToken;
    uint256 public tgeTimestamp;
    uint256 public totalAllocation;
    uint256 public lastActivityTimestamp;
    uint256 public nextCapId;
    uint256 public vestingCapsCount;

    mapping(uint256 => VestingTypes.VestingCap) public vestingCaps;
    mapping(address => mapping(uint256 => VestingTypes.VestingWalletInfo)) public vestingWallets;
    mapping(address => VestingTypes.SubstrateRewards) public substrateRewardInfo;
    mapping(address => bytes) public ethereumToSubstrate;

    /// @notice Events
    event TokenDistributionInitialized(address indexed token);
    event TGEInitiated(uint256 totalAllocation, uint256 timestamp);
    event TokensClaimed(address indexed beneficiary, uint256 amount);
    event ClaimProcessed(address indexed beneficiary, uint256 indexed capId, uint256 amount);
    event SubstrateRewardsUpdated(address indexed wallet, uint256 amount);
    event AddressesAdded(uint256 count);
    event AddressRemoved(address indexed ethereumAddr);
    event VestingCapAction(uint256 id, bytes32 name, uint8 action);
    event DistributionWalletAdded(address indexed beneficiary, uint256 amount, uint256 startTime, uint256 cliffPeriod, uint256 vestingPeriod);
    event DistributionWalletRemoved(address indexed wallet, uint256 indexed capId);

    /// @notice Custom errors with error codes
    error InvalidOperation(uint8 code); // Codes: 1=TGE not initiated, 2=Nothing due, 3=Low balance
    error InvalidState(uint8 code);     // Codes: 1=Already initialized, 2=Cap not found, 3=Wallet not found, 4=Wallet Exists
    error InvalidParameter(uint8 code); // Codes: 1=Invalid amount, 2=Invalid ratio, 3=Invalid cap, 4=Invalid initial release, 5=Invalid vesting plan
    error InvalidAddressLength();
    error NothingToClaim();
    error WalletMismatch();

    /// @notice Initialize the contract
    /// @param _storageToken Address of the token to distribute
    /// @param initialOwner Address of the owner
    /// @param initialAdmin Address of the admin
    function initialize(
        address _storageToken,
        address initialOwner,
        address initialAdmin
    ) public initializer {
        require(
            _storageToken != address(0) && 
            initialOwner != address(0) && 
            initialAdmin != address(0), 
            "Invalid address"
        );

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __GovernanceModule_init(initialOwner, initialAdmin);

        storageToken = ERC20Upgradeable(_storageToken);
        vestingCapsCount = 0;
    }

    /// @notice Initiate Token Generation Event to start Vesting and Distribution of pre-allocated tokens
    function initiateTGE() 
        external 
        nonReentrant 
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        if(tgeTimestamp != 0) revert InvalidState(1);
        
        // Set TGE timestamp
        tgeTimestamp = block.timestamp;
        
        // Update start date for all vesting caps
        for (uint256 i = 1; i <= nextCapId; i++) {
            VestingTypes.VestingCap storage cap = vestingCaps[i];
            
            if (cap.totalAllocation > 0) {
                // Ensure start date is properly set to tge date
                cap.startDate = tgeTimestamp;
            }
        }
        
        emit TGEInitiated(totalAllocation, tgeTimestamp);
        lastActivityTimestamp = block.timestamp;
    }

    /// @notice Create a new vesting cap
    /// @param capId a unique id
    /// @param name the name of this cap
    /// @param allocationAmount for this cap
    /// @param cliff in days
    /// @param vestingTerm linear vesting duration in months
    /// @param vestingPlan Intervals at which the user can claim in months. 1 means monthly and 3 means quarterly
    /// @param initialRelease percentage that is released after cliff
    function addVestingCap(
        uint256 capId,
        bytes32 name,
        uint256 allocationAmount,
        uint256 cliff, // cliff in days
        uint256 vestingTerm, // linear vesting duration in months
        uint256 vestingPlan, // Intervals at which the user can claim in months. 1 means monthly and 3 means quarterly
        uint256 initialRelease, // percentage that is released after cliff
        uint256 maxRewardsPerMonth, // maximum rewards per month
        uint256 ratio
    ) 
        external 
        nonReentrant 
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        if(vestingCaps[capId].totalAllocation != 0) revert InvalidParameter(3);
        if(allocationAmount <= 0) revert InvalidParameter(1);
        if(initialRelease > 100) revert InvalidParameter(4);
        if(vestingPlan >= vestingTerm) revert InvalidParameter(5);
        if (ratio == 0) revert InvalidParameter(2);
        
        uint256 defaultStartDate = block.timestamp + (30 * 365 days);

        vestingCaps[capId] = VestingTypes.VestingCap({
            totalAllocation: allocationAmount,
            name: name,
            cliff: cliff * 1 days,
            vestingTerm: vestingTerm * 30 days,
            vestingPlan: vestingPlan * 30 days,
            initialRelease: initialRelease,
            startDate: defaultStartDate,
            allocatedToWallets: 0,
            wallets: new address[](0),
            maxRewardsPerMonth: maxRewardsPerMonth,
            ratio: ratio

        });

        nextCapId = capId + 1;
        vestingCapsCount++;
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
        VestingTypes.VestingCap storage cap = vestingCaps[capId];
        bytes32 capName = cap.name;
        if(cap.totalAllocation <= 0) revert InvalidParameter(3);
        if(cap.allocatedToWallets > 0 || cap.wallets.length > 0) revert InvalidState(2);

        // Clean up all role assignments and permissions for this cap
        delete vestingCaps[capId];
        
        _updateActivityTimestamp();
        vestingCapsCount--;
        emit VestingCapAction(capId, capName, 2);
    }

    /// @notice Calculate claimable amount for an address
    /// @param wallet Address to check claimable amount for
    /// @param substrateWallet Substrate wallet address
    /// @param capId capId which the beneficiary is claiming tokens from
   function calculateDueTokens(
        address wallet,
        string calldata substrateWallet,
        uint256 capId
    ) public view returns (uint256) {
        VestingTypes.VestingCap memory cap = vestingCaps[capId];
        if (cap.startDate == 0) revert InvalidParameter(3);

        VestingTypes.VestingWalletInfo memory walletInfo = vestingWallets[wallet][capId];
        if (walletInfo.amount == 0) revert NothingToClaim();

        VestingTypes.SubstrateRewards memory rewards = substrateRewardInfo[wallet];
        if (!isSubstrateWalletMapped(wallet, substrateWallet)) revert WalletMismatch();

        return VestingCalculator.calculateDueTokens(cap, rewards, walletInfo, block.timestamp);
    }

    function _claimTokens(
        address wallet,
        uint256 capId,
        uint256 dueTokens
    ) internal {
        VestingTypes.VestingWalletInfo storage walletInfo = vestingWallets[wallet][capId];
        VestingTypes.VestingCap storage cap = vestingCaps[capId];
        
        uint256 currentMonth = (block.timestamp - cap.startDate) / 30 days;
        
        // Reset monthly claimed rewards if we're in a new month
        if (currentMonth > walletInfo.lastClaimMonth) {
            walletInfo.monthlyClaimedRewards = 0;
        }
        
        // Calculate remaining rewards that can be claimed this month
        uint256 remainingMonthlyAllowance = cap.maxRewardsPerMonth - walletInfo.monthlyClaimedRewards;
        
        // Limit the due tokens to the remaining monthly allowance
        uint256 tokensToTransfer = dueTokens;
        if (tokensToTransfer > remainingMonthlyAllowance) {
            tokensToTransfer = remainingMonthlyAllowance;
        }
        
        walletInfo.claimed += tokensToTransfer;
        walletInfo.monthlyClaimedRewards += tokensToTransfer;
        walletInfo.lastClaimMonth = currentMonth;

        storageToken.safeTransfer(wallet, tokensToTransfer);
    }

    /// @notice Claim vested tokens. Automatically calculates based on vesting schedule and transfers if anything is due
    function claimTokens(string calldata substrateWallet, uint256 capId) external nonReentrant whenNotPaused {
        if(tgeTimestamp == 0) revert InvalidOperation(1);

        uint256 dueTokens = calculateDueTokens(msg.sender, substrateWallet, capId);
        if(dueTokens == 0) revert InvalidOperation(2);

        _claimTokens(
            msg.sender,
            capId,
            dueTokens
        );

        emit TokensClaimed(msg.sender, dueTokens);
        emit ClaimProcessed(msg.sender, capId, dueTokens);
        lastActivityTimestamp = block.timestamp;
    }
    
    // Batch remove function
    function batchRemoveAddresses(address[] calldata ethereumAddrs) external nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) {
        require(ethereumAddrs.length <= 1000, "Batch too large");
        
        for(uint256 i = 0; i < ethereumAddrs.length; i++) {
            if(ethereumToSubstrate[ethereumAddrs[i]].length != 0) {
                removeAddress(ethereumAddrs[i]);
            }
        }
    }

    /// @notice Update substrate rewards for a wallet
    /// @param wallet The ethereum wallet address
    /// @param amount The new substrate rewards amount
    function updateSubstrateRewards(address wallet, uint256 amount) 
        external 
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        VestingTypes.SubstrateRewards storage rewards = substrateRewardInfo[wallet];
        rewards.amount = amount;
        rewards.lastUpdate = block.timestamp;
        
        emit SubstrateRewardsUpdated(wallet, amount);
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
            uint40 vestingCapId = id;
            
            // Validate cap exists and has space
            VestingTypes.VestingCap storage cap = vestingCaps[vestingCapId];
            if (cap.totalAllocation == 0) revert InvalidParameter(3);
            if (cap.allocatedToWallets + amount > cap.totalAllocation) {
                revert InvalidParameter(1);
            }

            // Check if wallet already exists in cap
            if (vestingWallets[target][vestingCapId].amount > 0) {
                revert InvalidState(4);
            }

            // Check for existing proposals
            if (pendingProposals[target].proposalType != 0) {
                revert ExistingActiveProposal(target);
            }

            bytes32 proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(target, vestingCapId, role))
            );

            ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
            _initializeProposal(
                proposal,
                target
            );

            // Store proposal data
            proposal.proposalType = proposalType;
            proposal.id = vestingCapId;
            proposal.role = role;
            proposal.amount = amount;

            // Track pending proposal
            pendingProposals[target].proposalType = proposal.proposalType;

            return proposalId;
        } else if (proposalType == uint8(ProposalTypes.ProposalType.RemoveDistributionWallet)) {
            // Check if wallet exists in cap
            if (vestingWallets[target][id].amount == 0) {
                revert InvalidState(3);
            }

            // Check for existing proposals
            if (pendingProposals[target].proposalType != 0) {
                revert ExistingActiveProposal(target);
            }

            bytes32 proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(target, id))
            );

            ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
            _initializeProposal(
                proposal,
                target
            );

            // Store proposal data
            proposal.proposalType = proposalType;
            proposal.id = id;

            // Track pending proposal
            pendingProposals[target].proposalType = proposal.proposalType;

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
            address wallet = proposal.target;
            uint256 vestingCapId = uint256(proposal.id);
            bytes32 name = proposal.role;
            uint256 amount = proposal.amount;
            
            _addWalletToCap(
                vestingCapId,
                wallet,
                name,
                amount
            );
        } else if (proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveDistributionWallet)) {
            address wallet = proposal.target;
            uint256 capId = uint256(proposal.id);
            
            (VestingTypes.VestingCap memory updatedCap, ) = VestingCalculator.removeWalletFromCap(
                vestingCaps[capId],
                wallet
            );
            vestingCaps[capId] = updatedCap;
            delete vestingWallets[wallet][capId];
        }
        
        lastActivityTimestamp = block.timestamp;
    }

    function getWalletsInCap(uint256 capId) public view returns (address[] memory) {
        VestingTypes.VestingCap storage cap = vestingCaps[capId];
        return cap.wallets;
    }

    function addAddress(
        address ethereumAddr,
        bytes calldata substrateAddr
    ) external nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) {
        require(ethereumAddr != address(0), "Invalid ethereum address");
        require(substrateAddr.length <= 50, "Invalid substrate address length");
        ethereumToSubstrate[ethereumAddr] = substrateAddr;
        emit AddressesAdded(1);
    }

    function batchAddAddresses(
        address[] calldata ethereumAddrs, 
        bytes[] calldata substrateAddrs
    ) external nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) {
        require(ethereumAddrs.length == substrateAddrs.length, "Arrays length mismatch");
        require(ethereumAddrs.length <= 1000, "Batch too large");
        
        for(uint256 i = 0; i < ethereumAddrs.length; i++) {
            require(ethereumAddrs[i] != address(0), "Invalid ethereum address");
            require(substrateAddrs[i].length <= 50, "Invalid substrate address length");
            ethereumToSubstrate[ethereumAddrs[i]] = substrateAddrs[i];
        }

        emit AddressesAdded(ethereumAddrs.length);
    }

    function removeAddress(address ethereumAddr) internal nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) {
        require(ethereumToSubstrate[ethereumAddr].length != 0, "Address not mapped");
        delete ethereumToSubstrate[ethereumAddr];
        emit AddressRemoved(ethereumAddr);
    }

    function verifySubstrateAddress(address wallet, bytes calldata substrateAddr) internal view returns (bool) {
        bytes memory mappedAddr = ethereumToSubstrate[wallet];
        return mappedAddr.length > 0 && keccak256(mappedAddr) == keccak256(substrateAddr);
    }

    function isSubstrateWalletMapped(address wallet, string calldata substrateWallet) internal view returns (bool) {
        bytes memory mappedAddr = ethereumToSubstrate[wallet];
        return mappedAddr.length > 0 && keccak256(mappedAddr) == keccak256(bytes(substrateWallet));
    }

    function createCap(
        uint256 capId,
        bytes32 name,
        uint256 startDate,
        uint256 cliff,
        uint256 vestingTerm,
        uint256 maxRewardsPerMonth,
        uint256 ratio
    ) external {
        require(startDate > 0, "Invalid date");
        require(cliff > 0 && vestingTerm > 0, "Invalid period");
        require(maxRewardsPerMonth > 0, "Invalid rewards");
        require(ratio > 0, "Invalid ratio");

        vestingCaps[capId] = VestingTypes.VestingCap({
            totalAllocation: 0, // Initial total allocation
            name: name,
            cliff: cliff,
            vestingTerm: vestingTerm,
            vestingPlan: 0, // Default vesting plan
            initialRelease: 0, // Default initial release
            startDate: startDate,
            allocatedToWallets: 0,
            wallets: new address[](0),
            maxRewardsPerMonth: maxRewardsPerMonth,
            ratio: ratio
        });

        emit VestingCapAction(capId, name, 1); // 1 = Created
    }

    function _addWalletToCap(
        uint256 capId,
        address wallet,
        bytes32 name,
        uint256 amount
    ) internal {
        require(wallet != address(0), "Invalid wallet");
        require(amount > 0, "Invalid amount");

        VestingTypes.VestingCap storage cap = vestingCaps[capId];
        require(cap.startDate > 0, "Cap not found");

        vestingWallets[wallet][capId] = VestingTypes.VestingWalletInfo({
            capId: capId,
            name: name,
            amount: amount,
            claimed: 0,
            monthlyClaimedRewards: 0,
            lastClaimMonth: 0
        });

        cap.wallets.push(wallet);
        cap.allocatedToWallets += amount;

        emit DistributionWalletAdded(
            wallet,
            amount,
            cap.startDate,
            cap.cliff,
            cap.vestingTerm
        );
    }

    function processRewards(
        address wallet,
        uint256 amount
    ) external {
        require(amount > 0, "Invalid amount");
        
        VestingTypes.SubstrateRewards storage rewards = substrateRewardInfo[wallet];
        rewards.amount = amount;
        rewards.lastUpdate = block.timestamp;
    }

    function removeWalletFromCap(
        uint256 capId,
        address wallet
    ) internal {
        VestingTypes.VestingCap storage cap = vestingCaps[capId];
        VestingTypes.VestingWalletInfo storage walletInfo = vestingWallets[wallet][capId];
        
        if (cap.allocatedToWallets >= walletInfo.amount) {
            cap.allocatedToWallets -= walletInfo.amount;
        }

        (VestingTypes.VestingCap memory updatedCap, ) = VestingCalculator.removeWalletFromCap(
            vestingCaps[capId],
            wallet
        );
        
        vestingCaps[capId] = updatedCap;
        delete vestingWallets[wallet][capId];
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
