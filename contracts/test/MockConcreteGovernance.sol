// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "../governance/libraries/ProposalTypes.sol";

// Interface for the Staking Engine admin actions
interface IStakingEngineAdminActions {
    function pause() external;
    function unpause() external;
    function addRewardsToPool(uint256 amount) external;
    function authorizeUpgrade(address newImplementation) external;
}

/**
 * @title MockConcreteGovernance
 * @notice A simplified mock governance implementation for testing purposes only
 * @dev This avoids inheriting from GovernanceModule to prevent function override issues
 */
contract MockConcreteGovernance is 
    Initializable, 
    UUPSUpgradeable, 
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    address public targetContract;
    
    struct Proposal {
        uint8 proposalType;
        address target;
        bytes32 role;
        uint96 amount;
        address tokenAddress;
        uint64 expiryTime;
        uint64 executionTime;
        uint8 status; // 0 = pending, 1 = executed
        uint16 approvals;
        bytes data;
    }
    
    mapping(bytes32 => Proposal) public proposals;
    mapping(bytes32 => mapping(address => bool)) public hasApproved;
    
    event ProposalCreated(bytes32 indexed proposalId, uint8 proposalType, address target);
    event ProposalApproved(bytes32 indexed proposalId, address approver);
    event ProposalExecuted(bytes32 indexed proposalId, address executor);
    event TargetActionExecuted(address indexed target, bytes data);
    event TargetActionFailed(address indexed target, bytes data, bytes reason);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize function (replaces constructor for proxy pattern)
     * @param _initialOwner Address of the initial owner/admin
     * @param _initialAdmin Address of the initial admin (can be same as owner)
     * @param _targetContract Address of the contract this governance module controls
     */
    function initialize(
        address _initialOwner,
        address _initialAdmin,
        address _targetContract
    ) public initializer {
        require(_targetContract != address(0), "Invalid target contract");
        
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        
        // Grant the default admin role to the owner so they can manage roles
        _grantRole(DEFAULT_ADMIN_ROLE, _initialOwner);
        
        // Grant ADMIN_ROLE to the admin
        _grantRole(ProposalTypes.ADMIN_ROLE, _initialAdmin);
        
        // Also grant other roles for testing
        _grantRole(ProposalTypes.CONTRACT_OPERATOR_ROLE, _initialAdmin);
        _grantRole(ProposalTypes.BRIDGE_OPERATOR_ROLE, _initialAdmin);
        
        targetContract = _targetContract;
    }

    function setTargetContract(address _newTargetContract) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        require(_newTargetContract != address(0), "Invalid target contract");
        targetContract = _newTargetContract;
    }

    /**
     * @notice Create a new proposal
     */
    function createProposal(
        uint8 proposalType,
        uint40 id,
        address target,
        bytes32 role,
        uint96 amount,
        address tokenAddress
    ) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
        returns (bytes32)
    {
        require(target != address(0), "Invalid address");
        
        // Create a proposal ID
        bytes32 proposalId = keccak256(abi.encodePacked(
            proposalType, id, target, role, amount, tokenAddress, block.timestamp
        ));
        
        // Store the proposal
        Proposal storage proposal = proposals[proposalId];
        proposal.proposalType = proposalType;
        proposal.target = target;
        proposal.role = role;
        proposal.amount = amount;
        proposal.tokenAddress = tokenAddress;
        
        // Set up config
        proposal.expiryTime = uint64(block.timestamp + 24 hours);
        proposal.executionTime = uint64(block.timestamp + 1 hours);
        proposal.approvals = 0;
        proposal.status = 0;
        
        emit ProposalCreated(proposalId, proposalType, target);
        return proposalId;
    }

    /**
     * @notice Create a simplified proposal with just data to execute
     */
    function createProposal(
        uint8 proposalType,
        address target,
        uint256 value, 
        bytes memory data
    )
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
        returns (bytes32)
    {
        require(target != address(0), "Invalid address");
        
        // Create a proposal ID
        bytes32 proposalId = keccak256(abi.encodePacked(
            proposalType, target, value, data, block.timestamp
        ));
        
        // Store the proposal
        Proposal storage proposal = proposals[proposalId];
        proposal.proposalType = proposalType;
        proposal.target = target;
        proposal.data = data;
        
        // Set up config
        proposal.expiryTime = uint64(block.timestamp + 24 hours);
        proposal.executionTime = uint64(block.timestamp + 1 hours);
        proposal.approvals = 0;
        proposal.status = 0;
        
        emit ProposalCreated(proposalId, proposalType, target);
        return proposalId;
    }

    /**
     * @notice Add an address to the whitelist for a whitelist proposal
     */
    function addToWhitelist(bytes32 proposalId, address account) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        require(account != address(0), "Invalid address");
        
        // For testing purposes, we just need this function to exist
        // In a real implementation, we would add the address to the proposal's whitelist
    }

    /**
     * @notice Approve a proposal
     */
    function approveProposal(bytes32 proposalId)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        // For testing, just approve the proposal
        Proposal storage proposal = proposals[proposalId];
        require(proposal.target != address(0), "Proposal does not exist");
        
        proposal.approvals++;
        hasApproved[proposalId][msg.sender] = true;
        
        emit ProposalApproved(proposalId, msg.sender);
    }

    /**
     * @notice Execute a proposal
     */
    function executeProposal(bytes32 proposalId)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        // For testing, execute the proposal by calling the target
        Proposal storage proposal = proposals[proposalId];
        require(proposal.target != address(0), "Proposal does not exist");
        require(proposal.status == 0, "Proposal already executed");
        
        proposal.status = 1; // Mark as executed

        // If specific data was provided, use it for the call
        if (proposal.data.length > 0) {
            (bool success, bytes memory returndata) = proposal.target.call(proposal.data);
            if (success) {
                emit TargetActionExecuted(proposal.target, proposal.data);
            } else {
                emit TargetActionFailed(proposal.target, proposal.data, returndata);
            }
        }
        
        emit ProposalExecuted(proposalId, msg.sender);
    }

    /**
     * @dev UUPS Upgradeable authorization
     */
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // Helper functions for creating proposal data
    function encodePauseData() external pure returns (bytes memory) {
        return abi.encodeWithSelector(IStakingEngineAdminActions.pause.selector);
    }

    function encodeUnpauseData() external pure returns (bytes memory) {
        return abi.encodeWithSelector(IStakingEngineAdminActions.unpause.selector);
    }

    function encodeAuthorizeUpgradeData(address newImplementation) external pure returns (bytes memory) {
        return abi.encodeWithSelector(IStakingEngineAdminActions.authorizeUpgrade.selector, newImplementation);
    }
    
    function encodeAddRewardsData(uint256 amount) external pure returns (bytes memory) {
        return abi.encodeWithSelector(IStakingEngineAdminActions.addRewardsToPool.selector, amount);
    }
    
    // Pause and unpause functionality
    function pause() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        _unpause();
    }
}
