// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/IAccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "./IRoleManager.sol";
import "./RoleManagerErrors.sol";
import "./RoleManagerEvents.sol";

contract RoleManager is 
    IRoleManager,
    RoleManagerEvents,
    RoleManagerErrors,
    Initializable, 
    UUPSUpgradeable,
    AccessControlEnumerableUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable 
{
    // Constants
    bytes32 public constant BRIDGE_OPERATOR_ROLE = bytes32(uint256(keccak256("BRIDGE_OPERATOR_ROLE")) - 1);
    bytes32 public constant ADMIN_ROLE = bytes32(uint256(keccak256("ADMIN_ROLE")) - 1);
    bytes32 public constant CONTRACT_OPERATOR_ROLE = bytes32(uint256(keccak256("CONTRACT_OPERATOR_ROLE")) - 1);
    
    uint256 private constant ROLE_CHANGE_DELAY = 1 days;
    uint32 private constant INACTIVITY_THRESHOLD = 365 days;

    // Packed structs for gas optimization
    struct TimeConfig {
        uint64 lastActivityTime;
        uint64 roleChangeTimeLock;
        uint64 whitelistLockTime;
        uint32 padding; // For future use
    }

    struct RoleConfig {
        uint32 quorum;
        uint256 transactionLimit;
    }

    // Storage
    mapping(address => TimeConfig) public timeConfigs;
    mapping(bytes32 => RoleConfig) public roleConfigs;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialAdmin) external reinitializer(1) {
        if (initialAdmin == address(0)) revert InvalidAddress(initialAdmin);
        
        __AccessControlEnumerable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(ADMIN_ROLE, initialAdmin);

        // Set initial timelock
        TimeConfig storage adminTimeConfig = timeConfigs[initialAdmin];
        adminTimeConfig.roleChangeTimeLock = uint64(block.timestamp + ROLE_CHANGE_DELAY);
    }

    function checkRolePermission(address account, bytes32 role) 
        public 
        view 
        override 
        returns (bool) 
    {
        TimeConfig storage timeConfig = timeConfigs[account];
        return hasRole(role, account) && 
               block.timestamp >= timeConfig.roleChangeTimeLock;
    }

    function grantRole(bytes32 role, address account)
        public
        override(AccessControlUpgradeable, IAccessControl, IRoleManager)
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
    {
        if (account == address(0)) revert InvalidAddress(account);
        
        TimeConfig storage callerConfig = timeConfigs[msg.sender];
        if (block.timestamp < callerConfig.roleChangeTimeLock) {
            revert TimeLockActive(msg.sender);
        }

        _grantRole(role, account);
        
        TimeConfig storage accountConfig = timeConfigs[account];
        accountConfig.roleChangeTimeLock = uint64(block.timestamp + ROLE_CHANGE_DELAY);
        accountConfig.lastActivityTime = uint64(block.timestamp);

        emit RoleUpdated(account, msg.sender, role, true);
    }

    function revokeRole(bytes32 role, address account)
        public
        override(AccessControlUpgradeable, IAccessControl, IRoleManager)
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
    {
        if (account == msg.sender) revert CannotRemoveSelf();
        if (account == address(0)) revert InvalidAddress(account);

        TimeConfig storage callerConfig = timeConfigs[msg.sender];
        if (block.timestamp < callerConfig.roleChangeTimeLock) {
            revert TimeLockActive(msg.sender);
        }

        if (role == ADMIN_ROLE) {
            uint256 adminCount = getRoleMemberCount(ADMIN_ROLE);
            if(adminCount <= 2) revert MinimumRoleNoRequired();
        }

        _revokeRole(role, account);
        
        TimeConfig storage accountConfig = timeConfigs[account];
        if (accountConfig.roleChangeTimeLock > 0) {
            accountConfig.roleChangeTimeLock = 0;
        }
        accountConfig.lastActivityTime = uint64(block.timestamp);

        emit RoleUpdated(account, msg.sender, role, false);
    }

        // Getters for time-based configurations
    function getTimeLockConfig(address account) 
        external 
        view 
        returns (TimeConfig memory) 
    {
        return timeConfigs[account];
    }

    function checkRolePermissions(
        address account, 
        bytes32 role, 
        uint256 amount
    ) external view returns (bool) {
        TimeConfig storage timeConfig = timeConfigs[account];
        RoleConfig storage roleConfig = roleConfigs[role];
        
        return hasRole(role, account) && 
               block.timestamp >= timeConfig.roleChangeTimeLock &&
               amount <= roleConfig.transactionLimit;
    }

    function isRoleTimeUnlocked(address account) 
        external 
        view 
        returns (bool) 
    {
        TimeConfig storage timeConfig = timeConfigs[account];
        return block.timestamp >= timeConfig.roleChangeTimeLock;
    }

    function setRoleTimeLock(address account, uint64 duration) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE) 
    {
        if (account == address(0)) revert InvalidAddress(account);
        
        TimeConfig storage timeConfig = timeConfigs[account];
        timeConfig.roleChangeTimeLock = uint64(block.timestamp + duration);
        
        emit RoleTimeLockUpdated(account, duration);
    }

    function revokeRoleWithDelay(bytes32 role, address account) 
        external 
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE) 
    {
        if (account == address(0)) revert InvalidAddress(account);
        if (account == msg.sender) revert CannotRemoveSelf();
        
        TimeConfig storage timeConfig = timeConfigs[account];
        timeConfig.roleChangeTimeLock = uint64(block.timestamp + ROLE_CHANGE_DELAY);
        
        emit RoleRevocationScheduled(account, role, block.timestamp + ROLE_CHANGE_DELAY);
    }

    function getRoleMembers(bytes32 role) 
        public 
        override
        view 
        returns (address[] memory) 
    {
        uint256 memberCount = getRoleMemberCount(role);
        address[] memory members = new address[](memberCount);
        
        for(uint256 i = 0; i < memberCount; i++) {
            members[i] = getRoleMember(role, i);
        }
        
        return members;
    }

    function pause() 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        _pause();
    }

    function unpause() 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        _unpause();
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyRole(ADMIN_ROLE)
    {}

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlEnumerableUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function hasRoleWithTimeLock(address account, bytes32 role) 
        external 
        view 
        returns (bool) 
    {
        TimeConfig storage timeConfig = timeConfigs[account];
        return hasRole(role, account) && 
               block.timestamp >= timeConfig.roleChangeTimeLock;
    }

    function _beforeRoleChange(bytes32 role, address account) 
        internal 
        view 
    {
        if (role != ADMIN_ROLE && 
            role != CONTRACT_OPERATOR_ROLE && 
            role != BRIDGE_OPERATOR_ROLE) {
            revert InvalidRole(role);
        }
        
        if (account == address(0)) {
            revert InvalidAddress(account);
        }
    }


    uint256[45] private __gap;
}
