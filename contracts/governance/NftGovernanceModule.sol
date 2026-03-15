// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./libraries/ProposalTypes.sol";

/// @title NftGovernanceModule
/// @notice Lightweight governance base for FulaFileNFT — roles, pause, UUPS, emergency.
/// @dev Stripped-down version of GovernanceModule without proposal management logic.
///      The full GovernanceModule is unchanged — other contracts still use it.
/// @dev WARNING: Storage layout is INCOMPATIBLE with GovernanceModule.
///      NEVER upgrade an existing GovernanceModule-based proxy to this contract.
///      This is designed for NEW proxy deployments only.
abstract contract NftGovernanceModule is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    PausableUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Events
    event EA(uint8 action, uint256 timestamp, address caller); // EmergencyAction 1 pause, 2 unpause
    event QuorumUpdated(bytes32 indexed role, uint256 newQuorum);

    // Errors
    error InvalidAddress();
    error TimeLockActive(address operator);
    error CoolDownActive(uint256 waitUntil);
    error InvalidQuorumErr(bytes32 role, uint16 quorum);
    error Failed(uint8 status);
    error UpgradeNotProposed();
    error UpgradeTimelockActive(uint256 readyAt);
    error MinimumAdminRequired();
    error UpgradeAlreadyProposed();
    error UpgradeNotPending();

    event UpgradeCancelled(address indexed implementation);

    event UpgradeProposed(address indexed newImplementation, uint256 proposedAt);

    uint256 public adminCount;

    mapping(bytes32 => ProposalTypes.RoleConfig) public roleConfigs;
    mapping(address => ProposalTypes.TimeConfig) public timeConfigs;

    struct PackedVars {
        uint8 flags;
        uint40 lastEmergencyAction;
    }
    PackedVars private packedVars;

    /// @dev Maps proposed implementation address to proposal timestamp (0 = not proposed)
    mapping(address => uint256) public pendingUpgrade;

    /// @notice Initialize the governance module
    function __GovernanceModule_init(
        address initialOwner,
        address initialAdmin
    ) internal onlyInitializing {
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();

        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControl_init();

        _grantRole(ProposalTypes.ADMIN_ROLE, initialOwner);
        _grantRole(ProposalTypes.ADMIN_ROLE, initialAdmin);
    }

    /// @notice Emergency pause functionality
    /// @param op 1 is pause and 2 is unpause
    function emergencyAction(uint8 op)
        external
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        PackedVars storage vars = packedVars;
        uint256 lastAction = vars.lastEmergencyAction;

        if (block.timestamp < lastAction + ProposalTypes.EMERGENCY_COOLDOWN) revert CoolDownActive(lastAction + ProposalTypes.EMERGENCY_COOLDOWN);

        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[msg.sender];
        if (block.timestamp < timeConfig.roleChangeTimeLock) revert TimeLockActive(msg.sender);

        if(op == uint8(1))
            _pause();
        else if(op == uint8(2))
             _unpause();
        else
            revert Failed(0);
        vars.lastEmergencyAction = uint40(block.timestamp);
        emit EA(op, block.timestamp, msg.sender);
    }

    /// @notice Set quorum for a role
    function setRoleQuorum(bytes32 role, uint16 quorum)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (quorum <= 1) revert InvalidQuorumErr(role, quorum);

        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[role];
        roleConfig.quorum = quorum;
        emit QuorumUpdated(role, quorum);
    }

    /// @notice Internal function to validate timelock
    function _validateTimelock(address account) internal view {
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[account];
        if (block.timestamp < timeConfig.roleChangeTimeLock) {
            revert TimeLockActive(account);
        }
    }

    /// @notice Propose an upgrade to a new implementation (starts 48h timelock)
    function proposeUpgrade(address newImplementation)
        external
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (newImplementation == address(0)) revert InvalidAddress();
        if (pendingUpgrade[newImplementation] != 0) revert UpgradeAlreadyProposed();
        pendingUpgrade[newImplementation] = block.timestamp;
        emit UpgradeProposed(newImplementation, block.timestamp);
    }

    /// @notice Cancel a pending upgrade proposal
    function cancelUpgrade(address newImplementation)
        external
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (pendingUpgrade[newImplementation] == 0) revert UpgradeNotPending();
        delete pendingUpgrade[newImplementation];
        emit UpgradeCancelled(newImplementation);
    }

    /// @notice Checks if conditions for upgrading the contract are met
    /// @dev Requires proposal + 48h timelock before upgrade can execute
    function _checkUpgrade(address newImplementation)
        internal
        virtual
        view
        returns (bool)
    {
        if (newImplementation == address(0)) revert InvalidAddress();
        uint256 proposed = pendingUpgrade[newImplementation];
        if (proposed == 0) revert UpgradeNotProposed();
        if (block.timestamp < proposed + 48 hours) revert UpgradeTimelockActive(proposed + 48 hours);
        return true;
    }

    /// @dev Track adminCount when roles are granted
    function _grantRole(bytes32 role, address account) internal virtual override returns (bool) {
        bool granted = super._grantRole(role, account);
        if (granted && role == ProposalTypes.ADMIN_ROLE) {
            adminCount++;
            timeConfigs[account].roleChangeTimeLock = uint64(block.timestamp + ProposalTypes.ROLE_CHANGE_DELAY);
        }
        return granted;
    }

    /// @dev Track adminCount when roles are revoked or renounced
    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
        bool revoked = super._revokeRole(role, account);
        if (revoked && role == ProposalTypes.ADMIN_ROLE) {
            if (adminCount <= 2) revert MinimumAdminRequired();
            adminCount--;
        }
        return revoked;
    }

    uint256[49] private __gap;
}
