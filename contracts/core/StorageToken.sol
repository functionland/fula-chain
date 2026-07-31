// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "../governance/Treasury.sol";
import "../governance/GovernanceModule.sol";
import "../governance/interfaces/IStorageToken.sol";

/// @title StorageToken
/// @notice ERC20 token with governance capabilities
/// @dev Inherits governance functionality from GovernanceModule
/// @dev Uses treasury/fee collection functionality from Treasury
/// @dev This is the main token contract
contract StorageToken is 
    GovernanceModule,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    IStorageToken
{

    /// @notice Token constants
    uint256 private constant TOKEN_UNIT = 10**18;
    uint256 private constant TOTAL_SUPPLY = 2_000_000_000 * TOKEN_UNIT;
    uint256 private constant WHITELIST_LOCK_DURATION = 1 days;

    mapping(uint256 => mapping(uint256 => uint8)) private _usedNonces;
    mapping(address => bool) public blacklisted;

    // @notice fee collection related storage
    Treasury public treasury;
    uint256 private constant MAX_BPS = 500; // 5%
    uint256 private platformFeeBps;

    PackedVars private packedVars;

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
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();
        if (initialMintedTokens > TOTAL_SUPPLY) revert ExceedsSupply(initialMintedTokens, TOTAL_SUPPLY);
        
        // Initialize ERC20 and Permit
        __ERC20_init("Functionland Fula", "FULA");
        
        // Initialize governance module (handles UUPSUpgradeable, Ownable, ReentrancyGuard, 
        // Pausable, AccessControlEnumerable, role grants, and timelocks)
        __GovernanceModule_init(initialOwner, initialAdmin);

        // Deploy Treasury
        treasury = new Treasury(address(this), initialAdmin);
        platformFeeBps = 0;
        
        // Initialize mint and proposal settings
        PackedVars storage vars = packedVars;
        if ((vars.flags & INITIATED) == 0) {
            _mint(address(this), initialMintedTokens);
            proposalCount = 0;
            emit TokensAllocatedToContract(initialMintedTokens);
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

    /// @notice _checkWhitelisted checks to ensure only white-listed recipients and only after time lock period are allowed to receive tokens from contract
    /// @param to the address that is the receiver of tokens from contract
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
            uint256 fee = (amount * platformFeeBps) / 10000;
            super._update(from, address(treasury), fee);
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }

    /// @notice sets the fee in percentage, that is taken from transactions and stored in treasury for burning, development, growth
    /// @param _platformFeeBps is the percentage fee
    function _setPlatformFee(uint256 _platformFeeBps) 
        internal 
        whenNotPaused
    {
        if(_platformFeeBps > MAX_BPS) revert FeeExceedsMax(_platformFeeBps);
        platformFeeBps = _platformFeeBps;
        emit PlatformFeeUpdated(_platformFeeBps);
    }

    /// @notice Manages the blacklist to block wallets from transferring tokens both receive and send
    /// @param account is hte wallet to blacklist
    /// @param status 1 adds to blacklist and 0 removes
    function _blacklistOp(address account, uint8 status) 
        internal
        whenNotPaused 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        if(account == address(0)) revert InvalidAddress();
        blacklisted[account] = (status == 1 ? true : false);
        emit BlackListOp(account, msg.sender, status);
    }

    /// @notice Transfer from caller to an address if contract is not paused
    function transfer(address to, uint256 amount) 
        public 
        virtual 
        override 
        whenNotPaused 
        nonReentrant
        returns (bool) 
    {
        // Combine validation checks into a single require to save gas
        if (to == address(0)) revert InvalidAddress();
        if (amount <= 0) revert AmountMustBePositive();
        
        return super.transfer(to, amount);
    }

    /// @notice Transfer tokens from contract to whitelisted address
    function transferFromContract(address to, uint256 amount) 
        external 
        virtual 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
        returns (bool) 
    {
        if (amount <= 0) revert AmountMustBePositive();
        _checkWhitelisted(to);
        
        uint256 contractBalance = balanceOf(address(this));
        if (amount > contractBalance) revert ExceedsSupply(amount, contractBalance);
        
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[ProposalTypes.ADMIN_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);
        
        _transfer(address(this), to, amount);
        emit TransferFromContract(address(this), to, amount, msg.sender);
        _updateActivityTimestamp();
        return true;
    }

    /// @notice Bridge mint function for cross-chain transfers for minting tokens or burning tokens to be minted on another chain
    /// @param amount is the amount ot burn or mint
    /// @param chain is the id of the chain to burn or mint tokens on
    /// @param nonce is the pre-defined one-time code for this operation on this chain
    /// @param op mint is 1 and burn is 2
    function bridgeOp(uint256 amount, uint256 chain, uint256 nonce, uint8 op) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.BRIDGE_OPERATOR_ROLE)
    {
        if (_usedNonces[chain][nonce] == 0) revert UsedNonce(nonce);
        if (amount == 0) revert AmountMustBePositive();
        
        uint256 currentSupply = totalSupply();
        if ((op == 1 && currentSupply + amount > TOTAL_SUPPLY) || (op ==2 && balanceOf(address(this)) < amount)) revert ExceedsMaximumSupply(amount, balanceOf(address(this)));

        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[ProposalTypes.BRIDGE_OPERATOR_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);

        if (op == uint8(1))  {
            _mint(address(this), amount);
            delete _usedNonces[chain][nonce];
        } else if (op == uint8(2)) {
            _burn(address(this), amount);
            delete _usedNonces[chain][nonce];
        } else 
            revert Unsupported(chain);

        _updateActivityTimestamp();
        emit BridgeOperationDetails(msg.sender, op, amount, chain, block.timestamp);
    }

    /// @notice override method to handle the proposals related to Token only, such as Adding and Removing from whitelist, Blacklist management, treasury management
    /// @param proposalType is defined in ProposalTypes.sol
    /// @param target is the wallet address for the operation
    /// @param amount is for treasury operation: the fee
    function _createCustomProposal(
        uint8 proposalType,
        uint40,
        address target,
        bytes32,
        uint96 amount,
        address
    ) internal virtual override returns (bytes32) {
        if (proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist) || 
            proposalType == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
            ProposalTypes.TimeConfig storage targetTimeConfig = timeConfigs[target];
            if (proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
                if (targetTimeConfig.whitelistLockTime != 0) revert AlreadyWhitelisted(target);
            } else if (proposalType == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
                if (targetTimeConfig.whitelistLockTime == 0) revert NotWhitelisted(target);
            }
            if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == uint8(ProposalTypes.ProposalType.AddToBlacklist) || 
             proposalType == uint8(ProposalTypes.ProposalType.RemoveFromBlacklist)) {
            if (target == address(0)) revert InvalidAddress();
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

    /// @notice removes the expired proposals and related storage variables
    function _handleCustomProposalExpiry(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        if (proposal.proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
            ProposalTypes.TimeConfig storage timeConfig = timeConfigs[proposal.target];
            delete timeConfig.whitelistLockTime;
        }
    }

    /// @notice executers the proposals that are related to this contract
    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        // Cache commonly used values
        address target = proposal.target;
        uint8 proposalTypeVal = uint8(proposal.proposalType);
        
        if (proposalTypeVal == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
            // Pack time configurations into TimeConfig struct
            ProposalTypes.TimeConfig storage timeConfig = timeConfigs[target];
            timeConfig.whitelistLockTime = uint64(block.timestamp + WHITELIST_LOCK_DURATION);
            emit WalletWhitelistedOp(target, msg.sender, timeConfig.whitelistLockTime, 1);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
            delete timeConfigs[target].whitelistLockTime;
            emit WalletWhitelistedOp(target, msg.sender, 0, 2);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.AddToBlacklist)) {
            _blacklistOp(target, 1);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.RemoveFromBlacklist)) {
            _blacklistOp(target, 2);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.ChangeTreasuryFee)) {
            _setPlatformFee(proposal.amount);
        }
        else {
            revert InvalidProposalType(proposalTypeVal);
        }
    }

    /// @notice Set supported chains for cross-chain operations. Nonce is a one-time code for mint or burn operation on the chain
    function setBridgeOpNonce(uint256 chainId, uint256 nonce) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (chainId <= 0) revert InvalidChain(chainId);
        _updateActivityTimestamp();
        _usedNonces[chainId][nonce] = 1;
        emit SupportedChainChanged(chainId, msg.sender);
    }

    /// @notice upgrade the contract that uses the Governance module and proposal system
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
