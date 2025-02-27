// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../governance/libraries/ProposalTypes.sol";
import "../governance/GovernanceModule.sol";

/**
 * @title TokenBridge
 * @notice Secure bridge for cross-chain token transfers
 * @dev Uses a custody model where tokens are kept in the bridge contract
 */
contract TokenBridge is GovernanceModule {
    // Token contract
    IERC20 public token;
    
    // Chain ID
    uint256 public LOCAL_CHAIN_ID;
    
    // Nonce management to prevent replay attacks
    mapping(uint256 => mapping(uint256 => bool)) public usedNonces;
    
    // Daily limits
    uint256 public dailyLimit;
    uint256 public dailyUsed;
    uint256 public dailyResetTime;
    
    // Access control
    mapping(address => bool) public whitelisted;
    mapping(address => bool) public blacklisted;
    bool public whitelistEnabled;
    
    // Large transfer management
    struct PendingTransfer {
        address recipient;
        uint256 amount;
        uint256 sourceChain;
        uint256 nonce;
        uint256 releaseTime;
        bool executed;
    }
    
    mapping(bytes32 => PendingTransfer) public pendingTransfers;
    uint256 public largeTransferThreshold;
    uint256 public largeTransferDelay;
    
    // Events
    event TokensLocked(address indexed sender, uint256 amount, uint256 targetChain, address targetAddress, uint256 nonce);
    event TokensReleased(address indexed receiver, uint256 amount, uint256 sourceChain, uint256 nonce, address operator);
    event BridgeOperatorUpdated(address indexed operator, bool status);
    event DailyLimitUpdated(uint256 newLimit);
    event WhitelistUpdated(address indexed account, bool status);
    event BlacklistUpdated(address indexed account, bool status);
    event WhitelistEnabledUpdated(bool enabled);
    event LargeTransferDelayed(bytes32 indexed transferId, address indexed recipient, uint256 amount, uint256 releaseTime);
    event LargeTransferExecuted(bytes32 indexed transferId, address indexed recipient, uint256 amount);
    event LargeTransferCancelled(bytes32 indexed transferId);
    event EmergencyWithdrawal(address tokenContract, uint256 amount, address indexed sender);
    event LargeTransferSettingsUpdated(uint256 threshold, uint256 delay);
    
    // Errors
    error InvalidTokenAmount();
    error InsufficientTokenBalance();
    error TransferFailed();
    error NonceAlreadyUsed(uint256 chainId, uint256 nonce);
    error BridgeOperatorRequired();
    error InvalidChainId();
    error DailyLimitExceeded(uint256 requested, uint256 remaining);
    error AccountBlacklisted(address account);
    error AccountNotWhitelisted(address account);
    error TransferDelayNotMet(uint256 releaseTime);
    error TransferAlreadyExecuted();
    error TransferNotPending();
    error LowAllowance(uint256 transactionLimit, uint256 amount);
    
    /**
     * @notice Initialize the bridge contract
     * @param _token Address of the token contract
     * @param _chainId ID of the current chain
     * @param _dailyLimit Maximum amount that can be transferred daily
     * @param _initialOwner Initial owner address
     * @param _initialAdmin Initial admin address
     * @param _initialOperators Array of initial bridge operators
     */
    function initialize(
        address _token,
        uint256 _chainId,
        uint256 _dailyLimit,
        address _initialOwner,
        address _initialAdmin,
        address[] memory _initialOperators
    ) public reinitializer(1) {
        // Validate parameters
        if (_token == address(0) || _initialOwner == address(0) || _initialAdmin == address(0)) 
            revert InvalidAddress();
        
        // Initialize governance module
        __GovernanceModule_init(_initialOwner, _initialAdmin);
        
        // Set token and chain ID
        token = IERC20(_token);
        LOCAL_CHAIN_ID = _chainId;
        
        // Set limits
        dailyLimit = _dailyLimit;
        dailyResetTime = block.timestamp + 1 days;
        largeTransferThreshold = _dailyLimit / 5; // 20% of daily limit
        largeTransferDelay = 30 minutes;
        
        // Grant bridge operator role to initial operators
        for (uint256 i = 0; i < _initialOperators.length; i++) {
            address operator = _initialOperators[i];
            if (operator == address(0)) revert InvalidAddress();
            _grantRole(ProposalTypes.BRIDGE_OPERATOR_ROLE, operator);
        }
    }
    
    /**
     * @notice Reset daily limit if needed
     */
    function _resetDailyLimitIfNeeded() internal {
        if (block.timestamp >= dailyResetTime) {
            dailyUsed = 0;
            dailyResetTime = block.timestamp + 1 days;
        }
    }
    
    /**
     * @notice Check if an account is allowed to use the bridge
     */
    function _checkAccountPermissions(address account) internal view {
        if (blacklisted[account]) revert AccountBlacklisted(account);
        if (whitelistEnabled && !whitelisted[account]) revert AccountNotWhitelisted(account);
    }
    
    /**
     * @notice Lock tokens on the source chain to be released on the target chain
     * @param amount Amount of tokens to lock
     * @param targetChain ID of the target chain
     * @param targetAddress Address to receive tokens on the target chain
     * @return nonce Unique nonce for this transfer
     */
    function lockTokens(
        uint256 amount,
        uint256 targetChain,
        address targetAddress
    ) external whenNotPaused nonReentrant returns (uint256) {
        // Validate parameters
        if (amount == 0) revert InvalidTokenAmount();
        if (targetChain == LOCAL_CHAIN_ID) revert InvalidChainId();
        if (targetAddress == address(0)) revert InvalidAddress();
        
        // Check account permissions
        _checkAccountPermissions(msg.sender);
        
        // Check daily limit
        _resetDailyLimitIfNeeded();
        if (dailyUsed + amount > dailyLimit) 
            revert DailyLimitExceeded(amount, dailyLimit - dailyUsed);
        
        // Generate nonce based on block data and sender
        uint256 nonce = uint256(keccak256(abi.encodePacked(
            block.number, block.timestamp, msg.sender, amount, targetChain
        ))) % 1000000000;
        
        // Ensure nonce is not already used
        if (usedNonces[targetChain][nonce]) revert NonceAlreadyUsed(targetChain, nonce);
        
        // Mark nonce as used
        usedNonces[targetChain][nonce] = true;
        
        // Update daily limit
        dailyUsed += amount;
        
        // Transfer tokens from sender to bridge
        bool success = token.transferFrom(msg.sender, address(this), amount);
        if (!success) revert TransferFailed();
        
        // Emit event
        emit TokensLocked(msg.sender, amount, targetChain, targetAddress, nonce);
        
        return nonce;
    }
    
    /**
     * @notice Release tokens on the target chain
     * @param recipient Address to receive tokens
     * @param amount Amount of tokens to release
     * @param sourceChain ID of the source chain
     * @param nonce Unique nonce for this transfer
     */
    function releaseTokens(
        address recipient,
        uint256 amount,
        uint256 sourceChain,
        uint256 nonce
    ) external whenNotPaused nonReentrant onlyRole(ProposalTypes.BRIDGE_OPERATOR_ROLE)  {
        // Check if caller is authorized using only the role system
        if (!hasRole(ProposalTypes.BRIDGE_OPERATOR_ROLE, msg.sender)) 
            revert BridgeOperatorRequired();
        
        // Validate parameters
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidTokenAmount();
        if (sourceChain == LOCAL_CHAIN_ID) revert InvalidChainId();
        
        // Check account permissions
        _checkAccountPermissions(recipient);
        
        // Ensure nonce is not already used
        if (usedNonces[sourceChain][nonce]) revert NonceAlreadyUsed(sourceChain, nonce);
        
        // Mark nonce as used
        usedNonces[sourceChain][nonce] = true;
        
        // Check daily limit
        _resetDailyLimitIfNeeded();
        if (dailyUsed + amount > dailyLimit) 
            revert DailyLimitExceeded(amount, dailyLimit - dailyUsed);
        
        // Update daily used amount
        dailyUsed += amount;
        
        // Check contract balance
        if (token.balanceOf(address(this)) < amount) revert InsufficientTokenBalance();
        
        // Check if this is a large transfer
        if (amount >= largeTransferThreshold) {
            // Create a delayed transfer
            bytes32 transferId = keccak256(abi.encodePacked(
                recipient, amount, sourceChain, nonce, block.timestamp
            ));
            
            pendingTransfers[transferId] = PendingTransfer({
                recipient: recipient,
                amount: amount,
                sourceChain: sourceChain,
                nonce: nonce,
                releaseTime: block.timestamp + largeTransferDelay,
                executed: false
            });
            
            emit LargeTransferDelayed(transferId, recipient, amount, block.timestamp + largeTransferDelay);
            _updateActivityTimestamp();
            return;
        }
        
        // Enforce transaction limit for BRIDGE_OPERATOR_ROLE
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[ProposalTypes.BRIDGE_OPERATOR_ROLE];
        if (amount > roleConfig.transactionLimit) 
            revert LowAllowance(roleConfig.transactionLimit, amount);
        
        // Transfer tokens to recipient
        bool success = token.transfer(recipient, amount);
        if (!success) revert TransferFailed();
        
        // Emit event
        emit TokensReleased(recipient, amount, sourceChain, nonce, msg.sender);
        
        // Update activity timestamp
        _updateActivityTimestamp();
    }
    
    /**
     * @notice Execute a pending large transfer after delay period
     * @param transferId ID of the pending transfer
     */
    function executeLargeTransfer(bytes32 transferId) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        PendingTransfer storage pendingTransfer = pendingTransfers[transferId];
        
        // Check if transfer exists and not executed
        if (pendingTransfer.recipient == address(0)) revert TransferNotPending();
        if (pendingTransfer.executed) revert TransferAlreadyExecuted();
        
        // Check if delay period has passed
        if (block.timestamp < pendingTransfer.releaseTime) 
            revert TransferDelayNotMet(pendingTransfer.releaseTime);
        
        // Mark as executed
        pendingTransfer.executed = true;
        
        // Transfer tokens
        bool success = token.transfer(pendingTransfer.recipient, pendingTransfer.amount);
        if (!success) revert TransferFailed();
        
        // Emit events
        emit LargeTransferExecuted(transferId, pendingTransfer.recipient, pendingTransfer.amount);
        emit TokensReleased(
            pendingTransfer.recipient, 
            pendingTransfer.amount, 
            pendingTransfer.sourceChain, 
            pendingTransfer.nonce, 
            msg.sender
        );
        
        _updateActivityTimestamp();
    }
    
    /**
     * @notice Cancel a pending large transfer
     * @param transferId ID of the pending transfer
     */
    function cancelLargeTransfer(bytes32 transferId) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        PendingTransfer storage pendingTransfer = pendingTransfers[transferId];
        
        // Check if transfer exists and not executed
        if (pendingTransfer.recipient == address(0)) revert TransferNotPending();
        if (pendingTransfer.executed) revert TransferAlreadyExecuted();
        
        // Mark nonce as unused to allow retrying
        usedNonces[pendingTransfer.sourceChain][pendingTransfer.nonce] = false;
        
        // Reduce daily used amount
        if (dailyUsed >= pendingTransfer.amount) {
            dailyUsed -= pendingTransfer.amount;
        } else {
            dailyUsed = 0;
        }
        
        // Delete the transfer
        delete pendingTransfers[transferId];
        
        emit LargeTransferCancelled(transferId);
        _updateActivityTimestamp();
    }
    
    /**
     * @notice Update the daily transfer limit
     * @param newLimit New daily limit
     */
    function updateDailyLimit(uint256 newLimit) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        dailyLimit = newLimit;
        
        // Adjust large transfer threshold (20% of daily limit)
        largeTransferThreshold = newLimit / 5;
        
        emit DailyLimitUpdated(newLimit);
        _updateActivityTimestamp();
    }
    
    /**
     * @notice Update whitelist status for an account
     * @param account Address to update
     * @param status New whitelist status
     */
    function updateWhitelist(address account, bool status) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        if (account == address(0)) revert InvalidAddress();
        
        whitelisted[account] = status;
        
        emit WhitelistUpdated(account, status);
        _updateActivityTimestamp();
    }
    
    /**
     * @notice Update blacklist status for an account
     * @param account Address to update
     * @param status New blacklist status
     */
    function updateBlacklist(address account, bool status) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        if (account == address(0)) revert InvalidAddress();
        
        blacklisted[account] = status;
        
        emit BlacklistUpdated(account, status);
        _updateActivityTimestamp();
    }
    
    /**
     * @notice Enable or disable whitelist requirement
     * @param enabled Whether whitelist should be required
     */
    function setWhitelistEnabled(bool enabled) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        whitelistEnabled = enabled;
        
        emit WhitelistEnabledUpdated(enabled);
        _updateActivityTimestamp();
    }
    
    /**
     * @notice Update large transfer settings
     * @param threshold Minimum amount to be considered a large transfer
     * @param delay Time delay in seconds for large transfers
     */
    function updateLargeTransferSettings(uint256 threshold, uint256 delay) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        largeTransferThreshold = threshold;
        largeTransferDelay = delay;
        
        emit LargeTransferSettingsUpdated(threshold, delay);
        _updateActivityTimestamp();
    }
    
    /**
     * @notice Check if an address is a bridge operator
     */
    function isBridgeOperator(address operator) external view returns (bool) {
        return hasRole(ProposalTypes.BRIDGE_OPERATOR_ROLE, operator);
    }
    
    /**
     * @notice Emergency withdrawal of tokens to the token contract
     * @param amount Amount to withdraw
    */
    function emergencyWithdraw(
        uint256 amount
    ) external whenPaused nonReentrant onlyRole(ProposalTypes.ADMIN_ROLE) {
        address tokenContract = address(token);
        
        if (amount == 0 || amount > token.balanceOf(address(this))) 
            revert InvalidTokenAmount();
        
        bool success = token.transfer(tokenContract, amount);
        if (!success) revert TransferFailed();
        
        emit EmergencyWithdrawal(tokenContract, amount, msg.sender);
        _updateActivityTimestamp();
    }
    
    // GovernanceModule abstract function implementations
    
    function _createCustomProposal(
        uint8 proposalType,
        uint40,
        address,
        bytes32,
        uint96,
        address
    ) internal override returns (bytes32) {
        // No custom proposal types yet
        revert InvalidProposalType(proposalType);
    }
    
    function _handleCustomProposalExpiry(bytes32 proposalId) internal override {
        // No custom handling needed
    }
    
    function _executeCustomProposal(bytes32 proposalId) internal override {
        // No custom execution logic
    }
    
    function _authorizeUpgrade(address newImplementation) 
        internal 
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
        override 
    {
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
    }
}