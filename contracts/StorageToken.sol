// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

contract StorageToken is Initializable, ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, PausableUpgradeable, AccessControlEnumerableUpgradeable, ReentrancyGuardUpgradeable {
    enum ContractType { Pool, Proof }
    uint256 private constant TOKEN_UNIT = 10**18; //Smallest unit for the token
    uint256 private constant TOTAL_SUPPLY = 2_000_000_000 * TOKEN_UNIT; // Maximum number of fixed cap token to be issued
    uint256 private lastEmergencyAction; // holds hte time of last emergency action (pause, unpause)
    uint256 private constant EMERGENCY_COOLDOWN = 5 minutes; // how much should we wait before allowing the next emergency action
    bytes32 public constant BRIDGE_OPERATOR_ROLE = keccak256("BRIDGE_OPERATOR_ROLE"); // role
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE"); //role
    bytes32 public constant CONTRACT_OPERATOR_ROLE = keccak256("CONTRACT_OPERATOR_ROLE");
    mapping(address => bool) public poolContracts; // Storage for contract addresses that are verified pool contracts to allow them transfer tokens from/to any address
    mapping(address => bool) public proofContracts; // Storage for contract addresses that are verified proof contracts to allow them transfer tokens from/to any address
    mapping(uint256 => bool) public supportedChains; // Storage for chains that are supported by the contract

    // Adding timelock for critical actions
    mapping(address => uint256) private roleChangeTimeLock; // Time holder of a role assignment
    uint256 private constant ROLE_CHANGE_DELAY = 1 days; // How much we should wait after a role is assigned to allow actions by that role
    mapping(address => uint256) private whitelistLockTime; // Lock time for whitelisted addresses to hold the time when an address is whitelisted
    uint256 private constant WHITELIST_LOCK_DURATION = 1 days; // Lock duration after adding to whitelist which should be passed before they can receive the transfer

    bool private _initializedMint; // Storage to indicate initial minting is done

    event RoleUpdated(address target, address caller, bytes32 role, bool status); //status true: added, status false: removed
    event EmergencyAction(string action, uint256 timestamp, address caller);
    event BridgeOperationDetails(address indexed operator, string operation, uint256 amount, uint256 chainId, uint256 timestamp);
    event WalletWhitelistedWithLock(address indexed wallet, uint256 lockUntil, address caller);
    event WalletRemovedFromWhitelist(address indexed wallet, address caller);
    event TransferFromContract(address indexed from, address indexed to, uint256 amount, address caller);
    event TokensMinted(address to, uint256 amount);
    event SupportedChainChanged(uint256 indexed chainId, bool supported, address caller);

    error ExceedsMaximumSupply(uint256 requested, uint256 maxSupply);
    error ExceedsAvailableSupply(uint256 requested, uint256 supply);
    error AmountMustBePositive();
    error UnsupportedChain(uint256 chain);
    error TokenPaused();
    error InsufficientAllowance(address spender, uint256 amount);
    error UnauthorizedTransfer(address sender);
    error TimeLockActive(address operator);

    modifier validateAddress(address _address) {
        require(_address != address(0), "Invalid address");
        _;
    }
    // onlyWhitelisted checks to ensure only whiltelisted reciepients and only after time lock period are allowed
    modifier onlyWhitelisted(address to) {
        require(whitelistLockTime[to] > 0, "Recipient not whitelisted");
        require(block.timestamp >= whitelistLockTime[to], "Recipient is still locked");
        _;
    }

    function initialize(address initialOwner, uint256 initialMintedTokens) public reinitializer(1) {  // Increment version number for each upgrade
        require(initialOwner != address(0), "Invalid owner address"); // check to ensure there is a valid initial owner address
        require(initialMintedTokens <= TOTAL_SUPPLY, "Exceeds maximum supply"); // initial minted tokens should not exceed maximum fixed cap supply
        __ERC20_init("Placeholder Token", "PLACEHOLDER"); // Placeholder will be changed to actual token name
        __UUPSUpgradeable_init();
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControlEnumerable_init();
        _grantRole(ADMIN_ROLE, initialOwner); // Assign admin role to deployer
        _grantRole(BRIDGE_OPERATOR_ROLE, initialOwner); // Assign bridge operator role to deployer

        // Mint the initial tokens to the contract address
        if (!_initializedMint) {
            _mint(address(this), initialMintedTokens);
            emit TokensMinted(address(this), initialMintedTokens);

            // Mark minting as initialized
            _initializedMint = true; // This could be redundant but still placed for guarantee
        }
    }

    function version() public pure returns (string memory) {
        return "1.0.0";
    }

    function tokenUnit() public pure returns (uint256) {
        unchecked {
            return 10**18; // This calculation cannot overflow
        }
    }

    function maxSupply() public pure returns (uint256) {
        unchecked {
            return TOTAL_SUPPLY; // This calculation cannot overflow
        }
    }

    // Add a wallet to the whitelist to allow receiving token transfers from contract
    function addToWhitelist(address wallet) external whenNotPaused nonReentrant onlyRole(ADMIN_ROLE) {
        require(wallet != address(0), "Invalid wallet address");
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        whitelistLockTime[wallet] = block.timestamp + WHITELIST_LOCK_DURATION;
        emit WalletWhitelistedWithLock(wallet, block.timestamp + WHITELIST_LOCK_DURATION, msg.sender);
    }

    // Remove a wallet from the whitelist to remove the permission of receiving tokens from contract
    function removeFromWhitelist(address wallet) external whenNotPaused nonReentrant onlyRole(ADMIN_ROLE) {
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        require(wallet != address(0), "Invalid wallet address");
        delete whitelistLockTime[wallet]; // Remove lock time
        emit WalletRemovedFromWhitelist(wallet, msg.sender);
    }

    // Pausing contract actions in emergency
    function emergencyPauseToken() external onlyRole(ADMIN_ROLE) {
        require(block.timestamp >= lastEmergencyAction + EMERGENCY_COOLDOWN, "Cooldown active");
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        _pause();
        lastEmergencyAction = block.timestamp;
        emit EmergencyAction("Contract paused", block.timestamp, msg.sender);
    }

    // UnPausing contract actions after emergency to return to normal
    function emergencyUnpauseToken() external onlyRole(ADMIN_ROLE) {
        require(block.timestamp >= lastEmergencyAction + EMERGENCY_COOLDOWN, "Cooldown active");
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        _unpause();
        emit EmergencyAction("Contract unpaused", block.timestamp, msg.sender);
    }

    // This method add or removes roles except admin which has its separate methods
    function updateAddressRole(address user, bytes32 role, bool isAdd) external whenNotPaused nonReentrant onlyRole(ADMIN_ROLE) validateAddress(user) {
        require(user != address(0), "Invalid user address");
        require(role == BRIDGE_OPERATOR_ROLE || role == CONTRACT_OPERATOR_ROLE, "Invalid role");
        
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        
        if (isAdd) {
            roleChangeTimeLock[user] = block.timestamp + ROLE_CHANGE_DELAY;
            _grantRole(role, user);
        } else {
            _revokeRole(role, user);
        }
        
        emit RoleUpdated(user, msg.sender, role, isAdd);
    }

    // Admin management: Assign the role to an address
    function addAdmin(address admin) external whenNotPaused nonReentrant onlyRole(ADMIN_ROLE) validateAddress(admin) {
        require(admin != address(0), "Invalid admin address");
        require(admin != owner(), "Cannot add owner as admin");
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        
        roleChangeTimeLock[admin] = block.timestamp + ROLE_CHANGE_DELAY;
        _grantRole(ADMIN_ROLE, admin);
        
        // If the caller is the owner, revoke their admin role
        if (msg.sender == owner()) {
            _revokeRole(ADMIN_ROLE, owner());
            emit RoleUpdated(owner(), msg.sender, ADMIN_ROLE, false);
        }
        
        emit RoleUpdated(admin, msg.sender, ADMIN_ROLE, true);
    }
    /**
     * @dev Removes an admin after ensuring the time lock has expired.
     * Uses `_revokeRole` because additional custom logic (time lock) is implemented. It also requires at least one admin and the last admin cannot be removed
    */
    function removeAdmin(address admin) external whenNotPaused nonReentrant onlyRole(ADMIN_ROLE) {
        require(admin != msg.sender, "Cannot remove self");
        require(admin != address(0), "Invalid admin address");
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        
        // Get the count of admins before removal
        uint256 adminCount = getRoleMemberCount(ADMIN_ROLE);
        require(adminCount > 1, "Cannot remove last admin");
        
        _revokeRole(ADMIN_ROLE, admin);
        emit RoleUpdated(admin, msg.sender, ADMIN_ROLE, false);
    }

    // Transfers tokens from contract to a whitelisted address (after the lock time has passed)
    function transferFromContract(address to, uint256 amount) external virtual whenNotPaused nonReentrant onlyRole(CONTRACT_OPERATOR_ROLE) onlyWhitelisted(to) returns (bool) {
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        if (amount <= 0) revert AmountMustBePositive();
        if (amount > balanceOf(address(this))) revert ExceedsAvailableSupply(amount, balanceOf(address(this)));
        _transfer(address(this), to, amount);
        emit TransferFromContract(address(this), to, amount, msg.sender);
        return true;
    }

    // Transfer from caller to an address if contract is not paused
    function transfer(address to, uint256 amount) public virtual override whenNotPaused nonReentrant returns (bool) {
        if (amount <= 0) revert AmountMustBePositive();
        require(to != address(0), "ERC20: transfer to the zero address not allowed");
        return super.transfer(to, amount);
    }

    // Mint Tokens to this address if it does not exceed total supply (Tokens should have been burnt on source chain before calling this method). This is for cross-chain transfer of tokens
    function bridgeMint(uint256 amount, uint256 sourceChain) external whenNotPaused nonReentrant onlyRole(BRIDGE_OPERATOR_ROLE) {
        if (!supportedChains[sourceChain]) revert UnsupportedChain(sourceChain);
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        if (amount <= 0) revert AmountMustBePositive();
        if (totalSupply() + amount > TOTAL_SUPPLY) {
            revert ExceedsMaximumSupply(amount, TOTAL_SUPPLY);
        }
        _mint(address(this), amount);
        emit BridgeOperationDetails(msg.sender, "MINT", amount, sourceChain, block.timestamp);
    }
    // burn tokens on this chain so that mint be called on the target chain and tokens be minted on target chain. This is for cross-chain transfer of tokens
    function bridgeBurn(uint256 amount, uint256 targetChain) external whenNotPaused nonReentrant onlyRole(BRIDGE_OPERATOR_ROLE) {
        if (!supportedChains[targetChain]) revert UnsupportedChain(targetChain);
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        if (amount <= 0) revert AmountMustBePositive();
        require(balanceOf(address(this)) >= amount, "Insufficient balance to burn");
        _burn(address(this), amount);
        emit BridgeOperationDetails(msg.sender, "BURN", amount, targetChain, block.timestamp);
    }

    // Add function to manage supported chains for cross-chain mint and burn
    function setSupportedChain(uint256 chainId, bool supported) external whenNotPaused nonReentrant onlyRole(ADMIN_ROLE) {
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        require(chainId > 0, "Invalid chain ID");
        supportedChains[chainId] = supported;
        emit SupportedChainChanged(chainId, supported, msg.sender);
    }

    // Only allow contract owner to upgrade the contract
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(CONTRACT_OPERATOR_ROLE) {}

    uint256[50] private __gap; // This is empty space for future upgrades
}