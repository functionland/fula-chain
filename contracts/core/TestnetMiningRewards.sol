// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../governance/GovernanceModule.sol";
import "../libraries/VestingTypes.sol";
import "../libraries/VestingCalculator.sol";
import "../libraries/VestingManager.sol";
import "./SubstrateAddressMapper.sol";

contract TestnetMiningRewards is 
    GovernanceModule {
    using SafeERC20 for ERC20Upgradeable;
    using VestingCalculator for VestingTypes.VestingCap;
    using VestingManager for mapping(uint256 => VestingTypes.VestingCap);
    using VestingManager for mapping(address => mapping(uint256 => VestingTypes.VestingWalletInfo));

    PackedVars private packedVars;
    
    ERC20Upgradeable public storageToken;
    SubstrateAddressMapper public addressMapper;
    uint256 public tgeTimestamp;
    uint256 public totalAllocation;
    uint256 public lastActivityTimestamp;
    uint256 public nextCapId;
    uint256 public vestingCapsCount;

    mapping(uint256 => VestingTypes.VestingCap) public vestingCaps;
    mapping(address => mapping(uint256 => VestingTypes.VestingWalletInfo)) public vestingWallets;
    mapping(address => VestingTypes.SubstrateRewards) public substrateRewardInfo;

    /// @notice Events
    event TokenDistributionInitialized(address indexed token);
    event TGEInitiated(uint256 totalAllocation, uint256 timestamp);
    event TokensClaimed(address indexed beneficiary, uint256 amount);
    event ClaimProcessed(address indexed beneficiary, uint256 indexed capId, uint256 amount);
    event SubstrateRewardsUpdated(address indexed wallet, uint256 amount);
    event VestingCapAction(uint256 id, bytes32 name, uint8 action);

    /// @notice Custom errors with error codes
    error InvalidOperation(uint8 code); // Codes: 1=TGE not initiated, 2=Nothing due, 3=Low balance
    error InvalidState(uint8 code);     // Codes: 1=Already initialized, 2=Cap not found, 3=Wallet not found
    error InvalidParameter(uint8 code); // Codes: 1=Invalid amount, 2=Invalid ratio, 3=Invalid cap, 4=Invalid initial release, 5=Invalid vesting plan

    /// @notice Initialize the contract
    /// @param _storageToken Address of the token to distribute
    /// @param _addressMapper Address of the SubstrateAddressMapper contract
    /// @param _admin Address of the admin
    function initialize(
        address _storageToken,
        address _addressMapper,
        address _admin
    ) public initializer {
        require(_storageToken != address(0) && _addressMapper != address(0) && _admin != address(0), "Invalid address");

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __GovernanceModule_init(_admin, _admin);

        storageToken = ERC20Upgradeable(_storageToken);
        addressMapper = SubstrateAddressMapper(_addressMapper);
        nextCapId = 1;
    }

    /// @notice Initiate Token Generation Event to start Vesting and Distribution of pre-allocated tokens
    function initiateTGE() 
        external 
        nonReentrant 
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        PackedVars storage vars = packedVars;
        if ((vars.flags & TGE_INITIATED) != 0) revert InvalidState(1);
        
        // Calculate total required tokens across all caps
        uint256 totalRequiredTokens = 0;
        
        // First pass: validate caps and calculate total required tokens
        for (uint256 i = 0; i < vestingCapsCount; i++) {
            uint256 capId = i;
            VestingTypes.VestingCap storage cap = vestingCaps[capId];
            
            if (cap.totalAllocation > 0) {
                // Ensure start date is properly set to tge date
                cap.startDate = block.timestamp;
                
                // Add to total required tokens
                totalRequiredTokens += cap.totalAllocation;
                
                // Verify cap allocation matches wallet allocations
                if (cap.totalAllocation < cap.allocatedToWallets) {
                    revert InvalidParameter(1);
                }
            }
        }

        // Verify contract has sufficient tokens
        uint256 contractBalance = storageToken.balanceOf(address(this));
        if (contractBalance < totalRequiredTokens) {
            revert InvalidOperation(3);
        }

        // Set TGE initiated flag
        vars.flags |= TGE_INITIATED;
        
        // Update activity timestamp
        _updateActivityTimestamp();
        
        tgeTimestamp = block.timestamp;
        totalAllocation = totalRequiredTokens;
        emit TGEInitiated(totalRequiredTokens, block.timestamp);
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
        string memory substrateWallet,
        uint256 capId
    ) public view returns (uint256) {
        VestingTypes.VestingCap storage cap = vestingCaps[capId];
        if(cap.startDate == 0) revert InvalidState(2);

        if (!addressMapper.verifySubstrateAddress(wallet, bytes(substrateWallet))) {
            revert InvalidOperation(2);
        }

        VestingTypes.VestingWalletInfo storage walletInfo = vestingWallets[wallet][capId];
        if(walletInfo.amount == 0) revert InvalidState(3);

        VestingTypes.SubstrateRewards storage rewards = substrateRewardInfo[wallet];
        return VestingCalculator.calculateDueTokens(cap, rewards, walletInfo, block.timestamp);
    }

    /// @notice Claim vested tokens. Automatically calculates based on vesting schedule and transfers if anything is due
    function claimTokens(string memory substrateWallet, uint256 capId) external nonReentrant whenNotPaused {
        if(tgeTimestamp == 0) revert InvalidOperation(1);

        uint256 dueTokens = calculateDueTokens(msg.sender, substrateWallet, capId);
        if(dueTokens == 0) revert InvalidOperation(2);

        VestingManager.claimTokens(
            vestingCaps,
            vestingWallets,
            substrateRewardInfo,
            storageToken,
            msg.sender,
            capId,
            dueTokens
        );

        emit TokensClaimed(msg.sender, dueTokens);
        emit ClaimProcessed(msg.sender, capId, dueTokens);
        lastActivityTimestamp = block.timestamp;
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
            addressMapper.addAddress(ethereumAddrs[i], substrateAddrs[i]);
        }
    }

    // Remove single mapping
    function removeAddress(address ethereumAddr) external nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) {
        bytes memory substrateAddr = addressMapper.ethereumToSubstrate(ethereumAddr);
        require(substrateAddr.length != 0, "Address not mapped");
        addressMapper.removeAddress(ethereumAddr);
    }
    
    // Batch remove function
    function batchRemoveAddresses(address[] calldata ethereumAddrs) external nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) {
        require(ethereumAddrs.length <= 1000, "Batch too large");
        
        for(uint256 i = 0; i < ethereumAddrs.length; i++) {
            if(addressMapper.ethereumToSubstrate(ethereumAddrs[i]).length != 0) {
                addressMapper.removeAddress(ethereumAddrs[i]);
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
            uint40 capId = id;
            
            // Validate cap exists and has space
            VestingTypes.VestingCap storage cap = vestingCaps[capId];
            if (cap.totalAllocation == 0) revert InvalidParameter(3);
            if (cap.allocatedToWallets + amount > cap.totalAllocation) {
                revert InvalidParameter(1);
            }

            // Check if wallet already exists in cap
            if (vestingWallets[target][capId].amount > 0) {
                revert InvalidState(3);
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
                revert InvalidState(4);
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
            address wallet = proposal.target;
            uint256 capId = uint256(proposal.id);
            bytes32 name = proposal.role;
            uint256 amount = proposal.amount;
            
            VestingManager.addWalletToCap(
                vestingCaps,
                vestingWallets,
                capId,
                wallet,
                name,
                amount
            );
        } else if (proposal.proposalType == uint8(ProposalTypes.ProposalType.RemoveDistributionWallet)) {
            address wallet = proposal.target;
            uint256 capId = uint256(proposal.id);
            
            VestingCalculator.removeWalletFromCap(
                vestingCaps[capId],
                vestingWallets[wallet][capId],
                wallet
            );
            delete vestingWallets[wallet][capId];
        }
        
        lastActivityTimestamp = block.timestamp;
    }

    function _authorizeUpgrade(address) internal override onlyRole(ProposalTypes.ADMIN_ROLE) {}

    function getWalletsInCap(uint256 capId) public view returns (address[] memory) {
        VestingTypes.VestingCap storage cap = vestingCaps[capId];
        return cap.wallets;
    }
}
