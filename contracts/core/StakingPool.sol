// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../governance/GovernanceModule.sol";
import "../governance/libraries/ProposalTypes.sol";

/// @title StakingPool
/// @notice Secure pool for holding tokens used in staking operations
/// @dev Inherits governance functionality from GovernanceModule
/// @dev Uses upgradeable pattern to allow for future improvements
contract StakingPool is
    Initializable,
    GovernanceModule
{
    using SafeERC20 for IERC20;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Events
    event TokensReceived(address indexed from, uint256 amount);
    event TokensTransferred(address indexed to, uint256 amount);
    event TokenAddressSet(address indexed tokenAddress);
    event StakingEngineAddressSet(address indexed stakingEngine);

    // Errors
    error OnlyStakingEngine();
    error InvalidAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error TransferFailed();

    // State variables
    IERC20 public token;
    address public stakingEngine;
    bool private _initialized;
    
    // Modifiers
    modifier onlyStakingEngine() {
        if (msg.sender != stakingEngine) revert OnlyStakingEngine();
        _;
    }

    /// @notice Initialize the pool contract
    /// @param _token Address of the ERC20 token to manage
    /// @param initialOwner Address of the initial owner
    /// @param initialAdmin Address of the initial admin
    function initialize(
        address _token,
        address initialOwner,
        address initialAdmin
    ) public reinitializer(1) {
        // Validate addresses
        if (_token == address(0)) revert InvalidAddress();
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();
        
        // Initialize base contracts
        __GovernanceModule_init(initialOwner, initialAdmin);
        
        // Grant ADMIN_ROLE to initialOwner
        _grantRole(ProposalTypes.ADMIN_ROLE, initialOwner);
        
        // Set token
        token = IERC20(_token);
        
        emit TokenAddressSet(_token);
    }
    
    /// @notice Set the StakingEngine address - can only be set once for security
    /// @param _stakingEngine Address of the StakingEngine contract
    function setStakingEngine(address _stakingEngine)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (_stakingEngine == address(0)) revert InvalidAddress();
        if (_initialized) revert("StakingEngine already set");
        
        stakingEngine = _stakingEngine;
        _initialized = true;
        
        emit StakingEngineAddressSet(_stakingEngine);
    }
    
    /// @notice Get the current token balance of the pool
    /// @return The token balance
    function getBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
    
    /// @notice Transfer tokens from the pool to the stakingEngine address
    /// @dev Can only be called by the StakingEngine
    /// @param amount Amount to transfer
    function transferTokens(uint256 amount)
        external
        whenNotPaused
        nonReentrant
        onlyStakingEngine
        returns (bool)
    {
        if (amount == 0) revert InvalidAmount();
        
        uint256 balance = token.balanceOf(address(this));
        if (amount > balance) revert InsufficientBalance(amount, balance);
        
        token.safeTransfer(stakingEngine, amount);
        
        emit TokensTransferred(stakingEngine, amount);
        return true;
    }
    
    /// @notice Receive tokens directly (for topping up the pool)
    /// @param from Address sending the tokens
    /// @param amount Amount of tokens received
    function receiveTokens(address from, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        onlyStakingEngine
        returns (bool)
    {
        if (from == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        
        // This function just emits an event - tokens are transferred directly to this contract
        emit TokensReceived(from, amount);
        return true;
    }
    
    /// @notice Emergency recovery of tokens in case of critical issues
    /// @param amount Amount to recover
    function emergencyRecoverTokens(uint256 amount)
        external
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (amount == 0) revert InvalidAmount();
        
        uint256 balance = token.balanceOf(address(this));
        if (amount > balance) revert InsufficientBalance(amount, balance);
        
        token.safeTransfer(address(token), amount);
        
        emit TokensTransferred(address(token), amount);
    }
    
    /// @notice Custom implementation of createProposal for pool-specific operations
    /// @dev Handles specific proposal types for this contract
    function _createCustomProposal(
        uint8 proposalType,
        uint40,
        address,
        bytes32,
        uint96,
        address
    ) internal virtual override returns (bytes32) {
        // Currently no custom proposals for StakingPool
        // This function could be extended in the future if needed
        
        revert InvalidProposalType(proposalType);
    }
    
    /// @notice Handles expiry of custom proposals
    function _handleCustomProposalExpiry(bytes32) internal virtual override {
        // No custom proposal expiry handling needed yet
    }
    
    /// @notice Executes custom proposals for this contract
    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        // Currently no custom proposals to execute
        // This function could be extended in the future if needed
        
        revert InvalidProposalType(uint8(proposal.proposalType));
    }
    
    /// @notice Authorize contract upgrade through governance process
    function _authorizeUpgrade(address newImplementation) 
        internal 
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE)
        override 
    {
        // Delegate the authorization to the governance module
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
        _initialized = false;
    }
}
