// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Assuming GovernanceModule.sol is in the same directory or path is adjusted
import "../governance/GovernanceModule.sol"; 
// --- FIX: Import ProposalTypes to access role definitions --- 
import "../governance/libraries/ProposalTypes.sol"; 

// Interface for the Staking Engine admin actions
interface IStakingEngineAdminActions {
    function pause() external;
    function unpause() external;
    function addRewardsToPool(uint256 amount) external; // Assuming governance adds rewards
    // Add other admin functions if needed, e.g., update parameters
    // function updateSomeParameter(uint256 newValue) external;

    // Function for UUPS upgrade authorization
    function authorizeUpgrade(address newImplementation) external;
}

/// @title ConcreteGovernance
/// @notice A concrete implementation inheriting the abstract GovernanceModule.
/// @dev This contract manages proposals and executes administrative actions 
///      on a separate target contract (e.g., StakingEngineLinear_Modular).
contract ConcreteGovernance is GovernanceModule {

    address public targetContract; // Address of the StakingEngineLinear_Modular contract

    // Event to signal successful execution targeting the staking contract
    event TargetActionExecuted(address indexed target, bytes data);
    // Event to signal failed execution targeting the staking contract
    event TargetActionFailed(address indexed target, bytes data, bytes reason);

    /**
     * @notice Constructor
     * @param _initialOwner Address of the initial owner/admin
     * @param _initialAdmin Address of the initial admin (can be same as owner)
     * @param _targetContract Address of the contract this governance module controls (StakingEngineLinear_Modular)
     */
    constructor(address _initialOwner, address _initialAdmin, address _targetContract) {
        require(_targetContract != address(0), "Invalid target contract");
        __GovernanceModule_init(_initialOwner, _initialAdmin);
        // Grant initial roles as needed by GovernanceModule's init logic
        // --- FIX: Use ProposalTypes.ADMIN_ROLE --- 
        _grantRole(ProposalTypes.ADMIN_ROLE, _initialAdmin);
        // Grant other roles like PROPOSER_ROLE, EXECUTOR_ROLE if defined in ProposalTypes and needed
        // Example: _grantRole(ProposalTypes.PROPOSER_ROLE, _initialAdmin);
        // Example: _grantRole(ProposalTypes.EXECUTOR_ROLE, _initialAdmin);
        targetContract = _targetContract;
    }

    /**
     * @notice Sets the target contract address (callable by admin).
     * @param _newTargetContract The new address of the controlled contract.
     */
     // --- FIX: Use ProposalTypes.ADMIN_ROLE --- 
    function setTargetContract(address _newTargetContract) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        require(_newTargetContract != address(0), "Invalid target contract");
        targetContract = _newTargetContract;
    }

    // --- Implement Abstract Functions from GovernanceModule --- 

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

    /**
     * @notice Override for authorizing upgrades (part of UUPS pattern).
     * @dev This function is called by the StakingEngineLinear_Modular contract 
     *      to check if an upgrade is authorized by governance.
     *      In this modular setup, the StakingEngineLinear_Modular calls its *own* 
     *      _authorizeUpgrade function, which then checks if msg.sender is this 
     *      ConcreteGovernance contract. This override in ConcreteGovernance is NOT called.
     *      Therefore, this override might not be strictly necessary in ConcreteGovernance, 
     *      UNLESS GovernanceModule itself requires it to be implemented.
     *      If GovernanceModule is abstract and requires this, implement it to simply return.
     */
    function _authorizeUpgrade(address /*newImplementation*/) internal virtual override {
        // This logic now resides within StakingEngineLinear_Modular, protected by onlyGovernance.
        // This override only needs to exist if required by the abstract GovernanceModule.
        // It doesn't perform the check itself in this modular design.
        return; 
    }

    // --- Helper functions to create proposal data --- 
    // These can be called off-chain or by other contracts to easily create proposals

    /**
     * @notice Creates proposal data to pause the target contract.
     */
    function encodePauseData() external pure returns (bytes memory) {
        return abi.encodeWithSelector(IStakingEngineAdminActions.pause.selector);
    }

    /**
     * @notice Creates proposal data to unpause the target contract.
     */
    function encodeUnpauseData() external pure returns (bytes memory) {
        return abi.encodeWithSelector(IStakingEngineAdminActions.unpause.selector);
    }

    /**
     * @notice Creates proposal data to authorize an upgrade in the target contract.
     * @param newImplementation The address of the new implementation contract.
     */
    function encodeAuthorizeUpgradeData(address newImplementation) external pure returns (bytes memory) {
        return abi.encodeWithSelector(IStakingEngineAdminActions.authorizeUpgrade.selector, newImplementation);
    }

    // Add other encoding functions for different admin actions as needed

}

