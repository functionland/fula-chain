// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/MulticallUpgradeable.sol";
import "../governance/Treasury.sol";
import "../governance/GovernanceModule.sol";

/// @title StorageToken
/// @notice ERC20 token with governance capabilities
/// @dev Inherits governance functionality from GovernanceModule
contract StorageToken is 
    GovernanceModule,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20BurnableUpgradeable,
    MulticallUpgradeable
{

    /// @notice Token constants
    uint256 private constant TOKEN_UNIT = 10**18;
    uint256 private constant TOTAL_SUPPLY = 2_000_000_000 * TOKEN_UNIT;
    uint256 private constant WHITELIST_LOCK_DURATION = 1 days;

    /// @notice Bridge-related storage
    mapping(uint256 => mapping(uint256 => bool)) private _usedNonces;
    mapping(uint256 => bool) public supportedChains;
    mapping(address => bool) public blacklisted;

    // @notice fee collection related storage
    Treasury public treasury;
    uint128 private constant MAX_BPS = 500; // 5%
    uint128 private platformFeeBps;

    uint256 private proposalCount;
    PackedVars private packedVars;

    /// @notice Events specific to token operations
    event BridgeOperationDetails(address indexed operator, string operation, uint256 amount, uint256 chainId, uint256 timestamp);
    event TokensAllocatedToContract(uint256 indexed amount, string tag);
    event SupportedChainChanged(uint256 indexed chainId, bool supported, address caller);
    event TransferFromContract(address indexed from, address indexed to, uint256 amount, address caller);
    event TokensMinted(address to, uint256 amount);
    event WalletWhitelistedWithLock(address indexed wallet, uint256 lockUntil, address caller);
    event WalletRemovedFromWhitelist(address indexed wallet, address caller);
    event AddedToBlacklist(address indexed account, address indexed by);
    event RemovedFromBlacklist(address indexed account, address indexed by);
    event TreasuryDeployed(address indexed treasury);
    event PlatformFeeUpdated(uint256 newFee);
    
    error NotWhitelisted(address to);
    error LocktimeActive(address to);
    error ExceedsSupply(uint256 requested, uint256 supply);
    error LowAllowance(uint256 allowance, uint256 limit);
    error UsedNonce(uint256 nonce);
    error Unsupported(uint256 chain);
    error ExceedsMaximumSupply(uint256 requested, uint256 maxSupply);
    error AccountWhitelisted(address target);
    error InvalidChain(uint256 chainId);
    error BlacklistedAddress(address account);
    error AccountBlacklisted(address target);
    error AccountNotBlacklisted(address target);
    error FeeExceedsMax(uint256 fee);

    /// @notice Initialize the token contract
    /// @param initialOwner Address of the initial owner
    /// @param initialAdmin Address of the initial admin
    /// @param initialMintedTokens Initial token supply to mint
    function initialize(
        address initialOwner, 
        address initialAdmin, 
        uint256 initialMintedTokens
    ) public reinitializer(1) {
        // Validate addresses
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress(address(0));
        if (initialMintedTokens > TOTAL_SUPPLY) revert ExceedsSupply(initialMintedTokens, TOTAL_SUPPLY);
        
        // Initialize ERC20 and Permit
        __ERC20_init("Placeholder Token", "PLACEHOLDER");
        __ERC20Permit_init("Placeholder Token");
        
        // Initialize governance module (handles UUPSUpgradeable, Ownable, ReentrancyGuard, 
        // Pausable, AccessControlEnumerable, role grants, and timelocks)
        __GovernanceModule_init(initialOwner, initialAdmin);

        // Deploy Treasury
        treasury = new Treasury(address(this), initialAdmin);
        platformFeeBps = uint128(0);
        
        // Initialize mint and proposal settings
        PackedVars storage vars = packedVars;
        if ((vars.flags & INITIATED) == 0) {
            _mint(address(this), initialMintedTokens);
            proposalCount = 0;
            emit TokensAllocatedToContract(initialMintedTokens, "INITIAL_MINT");
            emit TokensMinted(address(this), initialMintedTokens);
            emit TreasuryDeployed(address(treasury));
            vars.flags |= INITIATED;
        }
    }

    /// @notice Returns the maximum token supply
    function maxSupply() public pure returns (uint256) {
        unchecked {
            return TOTAL_SUPPLY;
        }
    }

    // _checkWhitelisted checks to ensure only white-listed recipients and only after time lock period are allowed
    function _checkWhitelisted(address to) internal view {
        // Use TimeConfig struct for whitelist lock time
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[to];
        uint64 lockTime = timeConfig.whitelistLockTime;
        
        if (lockTime == 0) revert NotWhitelisted(to);
        if (block.timestamp < lockTime) revert LocktimeActive(to);
    }

    /// @notice blocking transfers from/to blacklisted wallets and transfer the platform to treasury from the transaction 
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override(ERC20Upgradeable) {
        if (blacklisted[from]) revert BlacklistedAddress(from);
        if (blacklisted[to]) revert BlacklistedAddress(to);
        if (platformFeeBps > 0) {
            uint256 fee = (amount * platformFeeBps) / MAX_BPS;
            super._update(from, address(treasury), fee);
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }

    function _setPlatformFee(uint256 _platformFeeBps) 
        internal 
        whenNotPaused
    {
        require(_platformFeeBps <= MAX_BPS, "Fee exceeds maximum");
        platformFeeBps = uint128(_platformFeeBps);
        emit PlatformFeeUpdated(_platformFeeBps);
    }

    // Add these functions to manage the blacklist
    function _addToBlacklist(address account) 
        internal
        whenNotPaused 
        onlyRole(ADMIN_ROLE) 
    {
        if(account == address(0)) revert InvalidAddress(account);
        blacklisted[account] = true;
        emit AddedToBlacklist(account, msg.sender);
    }

    function _removeFromBlacklist(address account) 
        internal 
        whenNotPaused 
        onlyRole(ADMIN_ROLE) 
    {
        if(account == address(0)) revert InvalidAddress(account);
        blacklisted[account] = false;
        emit RemovedFromBlacklist(account, msg.sender);
    }

    /// @notice Transfer tokens from contract to whitelisted address
    function transferFromContract(address to, uint256 amount) 
        external 
        virtual 
        whenNotPaused 
        nonReentrant 
        onlyRole(ADMIN_ROLE) 
        returns (bool) 
    {
        if (amount <= 0) revert AmountMustBePositive();
        _checkWhitelisted(to);
        
        uint256 contractBalance = balanceOf(address(this));
        if (amount > contractBalance) revert ExceedsSupply(amount, contractBalance);
        
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[ADMIN_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);
        
        _transfer(address(this), to, amount);
        emit TransferFromContract(address(this), to, amount, msg.sender);
        _updateActivityTimestamp();
        return true;
    }

    /// @notice Override of ERC20 transfer
    function transfer(address to, uint256 amount) 
        public 
        virtual 
        override
        whenNotPaused 
        nonReentrant
        returns (bool) 
    {
        if (to == address(0)) revert InvalidAddress(to);
        if (amount <= 0) revert AmountMustBePositive();
        _updateActivityTimestamp();
        return super.transfer(to, amount);
    }

    /// @notice Bridge mint function for cross-chain transfers
    function bridgeMint(uint256 amount, uint256 sourceChain, uint256 nonce) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.BRIDGE_OPERATOR_ROLE)
    {
        if (_usedNonces[sourceChain][nonce]) revert UsedNonce(nonce);
        if (!supportedChains[sourceChain]) revert Unsupported(sourceChain);
        if (amount == 0) revert AmountMustBePositive();
        
        uint256 currentSupply = totalSupply();
        if (currentSupply + amount > TOTAL_SUPPLY) {
            revert ExceedsMaximumSupply(amount, TOTAL_SUPPLY);
        }

        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[ProposalTypes.BRIDGE_OPERATOR_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);

        _mint(address(this), amount);
        _usedNonces[sourceChain][nonce] = true;
        _updateActivityTimestamp();
        emit BridgeOperationDetails(msg.sender, "MINT", amount, sourceChain, block.timestamp);
    }


    /// @notice Bridge burn function for cross-chain transfers
    function bridgeBurn(uint256 amount, uint256 targetChain, uint256 nonce) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.BRIDGE_OPERATOR_ROLE)
    {
        if (_usedNonces[targetChain][nonce]) revert UsedNonce(nonce);
        if (!supportedChains[targetChain]) revert Unsupported(targetChain);
        if (amount == 0) revert AmountMustBePositive();
        
        uint256 contractBalance = balanceOf(address(this));
        if (contractBalance < amount) revert LowBalance(contractBalance, amount);

        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[BRIDGE_OPERATOR_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);

        _burn(address(this), amount);
        _usedNonces[targetChain][nonce] = true;
        _updateActivityTimestamp();
        emit BridgeOperationDetails(msg.sender, "BURN", amount, targetChain, block.timestamp);
    }

    function _createCustomProposal(
        uint8 proposalType,
        uint256 id,
        address target,
        bytes32 role,
        uint256 amount,
        address tokenAddress
    ) internal virtual override returns (bytes32) {
        if (proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist) || proposalType == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
            ProposalTypes.TimeConfig storage targetTimeConfig = timeConfigs[target];
            if (proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
                if (targetTimeConfig.whitelistLockTime != 0) revert AccountWhitelisted(target);
            } else if (proposalType == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
                if (targetTimeConfig.whitelistLockTime == 0) revert NotWhitelisted(target);
            }
            if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == uint8(ProposalTypes.ProposalType.AddToBlacklist) || 
             proposalType == uint8(ProposalTypes.ProposalType.RemoveFromBlacklist)) {
            if (target == address(0)) revert InvalidAddress(target);
            if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);

            // Check current blacklist status
            if (proposalType == uint8(ProposalTypes.ProposalType.AddToBlacklist)) {
                if (blacklisted[target]) revert AccountBlacklisted(target);
            } else {
                if (!blacklisted[target]) revert AccountNotBlacklisted(target);
            }
        } else if (proposalType == uint8(ProposalTypes.ProposalType.ChangeTreasuryFee)) {
            if (amount > MAX_BPS) revert FeeExceedsMax(amount);
        }

        if (proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist) || 
            proposalType == uint8(ProposalTypes.ProposalType.RemoveWhitelist) || 
            proposalType == uint8(ProposalTypes.ProposalType.AddToBlacklist) || 
            proposalType == uint8(ProposalTypes.ProposalType.RemoveFromBlacklist) || 
            proposalType == uint8(ProposalTypes.ProposalType.ChangeTreasuryFee)
        ) {
            bytes32 proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(target, block.timestamp))
            );

            ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
            _initializeProposal(
                proposal,
                target
            );
            
            proposal.proposalType = proposalType;
            pendingProposals[target].proposalType = proposalType;
            
            return proposalId;
        }
        
        revert InvalidProposalType(proposalType);
    }

    function _handleCustomProposalExpiry(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        if (proposal.proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
            ProposalTypes.TimeConfig storage timeConfig = timeConfigs[proposal.target];
            delete timeConfig.whitelistLockTime;
        }
        else if (proposal.proposalType == uint8(ProposalTypes.ProposalType.Recovery)) {
            // No additional cleanup needed for recovery proposals
        }
    }

    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        // Cache commonly used values
        address target = proposal.target;
        uint8 proposalTypeVal = uint8(proposal.proposalType);
        
        if (proposalTypeVal == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
            // Pack time configurations into TimeConfig struct
            ProposalTypes.TimeConfig storage timeConfig = timeConfigs[target];
            timeConfig.whitelistLockTime = uint64(block.timestamp + WHITELIST_LOCK_DURATION);
            emit WalletWhitelistedWithLock(target, timeConfig.whitelistLockTime, msg.sender);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
            delete timeConfigs[target].whitelistLockTime;
            emit WalletRemovedFromWhitelist(target, msg.sender);
        }  
        else {
            revert InvalidProposalType(proposalTypeVal);
        }
    }

    /// @notice Set supported chains for cross-chain operations
    function setSupportedChain(uint256 chainId, bool supported) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ADMIN_ROLE)
    {
        if (chainId <= 0) revert InvalidChain(chainId);
        supportedChains[chainId] = supported;
        _updateActivityTimestamp();
        emit SupportedChainChanged(chainId, supported, msg.sender);
    }

    function _authorizeUpgrade(address newImplementation) 
        internal 
        nonReentrant
        whenNotPaused
        onlyRole(ADMIN_ROLE) 
        override 
    {
        // Delegate the authorization to the governance module
        if (! _checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");

    }

    uint256[45] private __gap;  // gap size to accommodate new storage variables
}
