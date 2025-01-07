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
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

contract StorageToken is Initializable, ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    
    uint256 private constant TOKEN_UNIT = 10**18;
    uint256 private constant TOTAL_SUPPLY = 1_000_000 * TOKEN_UNIT; // 1M tokens
    bool private _locked;
    uint256 private lastEmergencyAction;
    uint256 private constant EMERGENCY_COOLDOWN = 5 minutes;

    bytes32 public constant BRIDGE_OPERATOR_ROLE = keccak256("BRIDGE_OPERATOR_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    mapping(address => bool) public poolContracts;
    mapping(address => bool) public proofContracts;
    mapping(uint256 => bool) public supportedChains;

    // Add timelock for critical role changes
    mapping(address => uint256) private roleChangeTimeLock;
    uint256 private constant ROLE_CHANGE_DELAY = 8 hours;

    mapping(address => bool) private whitelist; // Whitelisted addresses
    mapping(address => uint256) private whitelistLockTime; // Lock time for whitelisted addresses
    uint256 private constant WHITELIST_LOCK_DURATION = 48 hours; // Lock duration after adding to whitelist

    bool private _initializedMint;

    event BridgeTransfer(address indexed from, uint256 amount, uint256 targetChain);
    event BridgeOperatorAdded(address operator);
    event BridgeOperatorRemoved(address operator);
    event PoolContractAdded(address poolContract);
    event PoolContractRemoved(address poolContract);
    event ProofContractAdded(address proofContract);
    event ProofContractRemoved(address proofContract);
    event EmergencyAction(string action, uint256 timestamp);

    event BridgeOperationDetails(
        address indexed operator,
        string operation,
        uint256 amount,
        uint256 chainId,
        uint256 timestamp
    );
    event WalletWhitelisted(address indexed wallet);
    event WalletRemovedFromWhitelist(address indexed wallet);
    event TransferFromContract(address indexed from, address indexed to, uint256 amount);
    event TokensMinted(address indexed to, uint256 amount);

    error ExceedsMaximumSupply(uint256 requested, uint256 maxSupply);
    error AmountMustBePositive();
    error UnsupportedSourceChain(uint256 chain);
    error TokenPaused();
    error InsufficientAllowance(address spender, uint256 amount);
    error UnauthorizedTransfer(address sender);
    error TimeLockActive(address operator);

    modifier validateAddress(address _address) {
        require(_address != address(0), "Invalid address");
        _;
    }
    modifier onlyWhitelisted(address to) {
        require(whitelist[to], "Recipient not whitelisted");
        require(block.timestamp >= whitelistLockTime[to], "Recipient is still locked");
        _;
    }

    function initialize(address initialOwner, uint256 initialMintedTokens) public reinitializer(1) {  // Increment version number for each upgrade
        require(initialOwner != address(0), "Invalid owner address");
        require(initialMintedTokens <= TOTAL_SUPPLY, "Exceeds maximum supply");
        __ERC20_init("Test Token", "TT");
        __UUPSUpgradeable_init();
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, initialOwner); // Assign admin role to deployer
        _grantRole(BRIDGE_OPERATOR_ROLE, initialOwner); // Assign bridge operator role to deployer

        // Mint the initial tokens to the owner's address
        if (!_initializedMint) {
            _mint(address(this), initialMintedTokens);
            emit TokensMinted(address(this), initialMintedTokens);

            // Mark minting as initialized
            _initializedMint = true;
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

    // Add a wallet to the whitelist
    function addToWhitelist(address wallet) external onlyRole(ADMIN_ROLE) {
        require(wallet != address(0), "Invalid wallet address");
        whitelist[wallet] = true;
        whitelistLockTime[wallet] = block.timestamp + WHITELIST_LOCK_DURATION;
        emit WalletWhitelisted(wallet);
    }

    // Remove a wallet from the whitelist
    function removeFromWhitelist(address wallet) external onlyRole(ADMIN_ROLE) {
        require(wallet != address(0), "Invalid wallet address");
        whitelist[wallet] = false;
        whitelistLockTime[wallet] = 0; // Reset lock time
        emit WalletRemovedFromWhitelist(wallet);
    }


    function emergencyPauseToken() external onlyRole(ADMIN_ROLE) {
        require(block.timestamp >= lastEmergencyAction + EMERGENCY_COOLDOWN, "Cooldown active");
        _pause();
        lastEmergencyAction = block.timestamp;
        emit EmergencyAction("Contract paused", block.timestamp);
    }

    function emergencyUnpauseToken() external onlyRole(ADMIN_ROLE) {
        _unpause();
        emit EmergencyAction("Contract unpaused", block.timestamp);
    }

    // Bridge operator management
    function addBridgeOperator(address operator) external nonReentrant onlyRole(ADMIN_ROLE) validateAddress(operator) {
        require(operator != address(0), "Invalid operator address");
        if (block.timestamp < roleChangeTimeLock[operator]) revert TimeLockActive(operator);
    
        roleChangeTimeLock[operator] = block.timestamp + ROLE_CHANGE_DELAY;
        _grantRole(BRIDGE_OPERATOR_ROLE, operator);
        emit BridgeOperatorAdded(operator);
    }

    function removeBridgeOperator(address operator) external nonReentrant onlyRole(ADMIN_ROLE) {
        require(operator != address(0), "Invalid operator address");
        revokeRole(BRIDGE_OPERATOR_ROLE, operator);
        emit BridgeOperatorRemoved(operator);
    }

    // Pool contract management
    function addPoolContract(address poolContract) external nonReentrant onlyRole(ADMIN_ROLE) {
        require(poolContract != address(0), "Invalid pool contract address");
        poolContracts[poolContract] = true;
        emit PoolContractAdded(poolContract);
    }

    function removePoolContract(address poolContract) external nonReentrant onlyRole(ADMIN_ROLE) {
        poolContracts[poolContract] = false;
        emit PoolContractRemoved(poolContract);
    }

    // Proof contract management
    function addProofContract(address proofContract) external nonReentrant onlyRole(ADMIN_ROLE) {
         require(proofContract != address(0), "Invalid proof contract address");
        proofContracts[proofContract] = true;
        emit ProofContractAdded(proofContract);
    }

    function removeProofContract(address proofContract) external nonReentrant onlyRole(ADMIN_ROLE) {
        proofContracts[proofContract] = false;
        emit ProofContractRemoved(proofContract);
    }

    function transferFromContract(address to, uint256 amount)
        external
        virtual
        whenNotPaused
        nonReentrant
        onlyRole(ADMIN_ROLE)
        onlyWhitelisted(to)
        returns (bool)
    {
        if (paused()) revert("TokenPaused");
        
        _transfer(address(this), to, amount);
        
        emit TransferFromContract(address(this), to, amount);
        
        return true;
    }

    function transfer(address to, uint256 amount) public virtual override whenNotPaused nonReentrant returns (bool) {
        if (paused()) revert TokenPaused();
        return super.transfer(to, amount);
    }

    // Bridge-specific functions with access control
    function bridgeMint(uint256 amount, uint256 sourceChain) 
    external 
    nonReentrant
    whenNotPaused 
    onlyRole(BRIDGE_OPERATOR_ROLE)
    {
        if (!supportedChains[sourceChain]) revert UnsupportedSourceChain(sourceChain);
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        if (amount == 0) revert AmountMustBePositive();
        if (totalSupply() + amount > TOTAL_SUPPLY) {
            revert ExceedsMaximumSupply(amount, TOTAL_SUPPLY);
        }
        _mint(address(this), amount);
        emit BridgeOperationDetails(msg.sender, "MINT", amount, sourceChain, block.timestamp);
    }

    function bridgeBurn(uint256 amount, uint256 targetChain) 
        external 
        whenNotPaused 
        nonReentrant
        onlyRole(BRIDGE_OPERATOR_ROLE)
    {
        if (block.timestamp < roleChangeTimeLock[msg.sender]) revert TimeLockActive(msg.sender);
        require(amount > 0, "Amount must be positive");
        require(balanceOf(address(this)) >= amount, "Insufficient balance to burn");
        require(supportedChains[targetChain], "Unsupported target chain");
        _burn(address(this), amount);
        emit BridgeOperationDetails(msg.sender, "BURN", amount, targetChain, block.timestamp);
    }

    // Override transfer functions to handle pool and proof contracts
    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) public virtual whenNotPaused nonReentrant override returns (bool) {
        if (paused()) revert TokenPaused();
        if (poolContracts[msg.sender] || proofContracts[msg.sender]) {
            _transfer(sender, recipient, amount);
            return true;
        }
        return super.transferFrom(sender, recipient, amount);
    }

    // multi-chain token transfer
    // Add function to manage supported chains
    function setSupportedChain(uint256 chainId, bool supported) external nonReentrant onlyRole(BRIDGE_OPERATOR_ROLE) {
        supportedChains[chainId] = supported;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    uint256[50] private __gap;
}