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
import "./DAMMModule.sol";

contract StorageToken is Initializable, ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, PausableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable, DAMMModule {
    
    uint256 private constant TOKEN_UNIT = 10**18;
    uint256 private constant TOTAL_SUPPLY = 1_000_000 * TOKEN_UNIT; // 1M tokens
    bool private _locked;
    uint256 private lastEmergencyAction;
    uint256 private constant EMERGENCY_COOLDOWN = 5 minutes;

    bytes32 public constant BRIDGE_OPERATOR_ROLE = keccak256("BRIDGE_OPERATOR_ROLE");
    mapping(address => bool) public poolContracts;
    mapping(address => bool) public proofContracts;
    mapping(uint256 => bool) public supportedChains;

    // Add timelock for critical role changes
    mapping(address => uint256) private roleChangeTimeLock;
    uint256 private constant ROLE_CHANGE_DELAY = 8 hours;

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

    //DAMM: Dynamic Automatic Market Making
    event DAMMPoolCreated(address indexed quoteToken, uint256 initialLiquidity);
    event DAMMSwapExecuted(
        address indexed user,
        address indexed quoteToken,
        uint256 indexed amountIn,
        uint256 amountOut
    );

    error ExceedsMaximumSupply(uint256 requested, uint256 maxSupply);
    error AmountMustBePositive();
    error UnsupportedSourceChain(uint256 chain);
    error TokenPaused();
    error InsufficientAllowance(address spender, uint256 amount);
    error UnauthorizedTransfer(address sender);
    error TimeLockActive(address operator);

    function initialize(address initialOwner) public reinitializer(1) {  // Increment version number for each upgrade
        require(initialOwner != address(0), "Invalid owner address");
        __ERC20_init("Test Token", "TT");
        __UUPSUpgradeable_init();
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __DAMMModule_init();
        __Pausable_init();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner); // Assign admin role to deployer
        _grantRole(BRIDGE_OPERATOR_ROLE, initialOwner); // Assign bridge operator role to deployer
    }

    function version() public pure returns (string memory) {
        return "1.0.0";
    }

    function tokenUnit() public pure returns (uint256) {
        unchecked {
            return 10**18; // This calculation cannot overflow
        }
    }

    function mintToken(uint256 amount) external onlyOwner {
        require(amount <= TOTAL_SUPPLY - totalSupply(), "No tokens left to mint"); // Calculate remaining tokens to mint
        require(amount > 0, "amount cannot be zero");
        _mint(address(this), amount); // Mint tokens to the contract's address
    }

    function maxSupply() public pure returns (uint256) {
        unchecked {
            return TOTAL_SUPPLY; // This calculation cannot overflow
        }
    }


    function emergencyPauseToken() external onlyOwner {
        require(block.timestamp >= lastEmergencyAction + EMERGENCY_COOLDOWN, "Cooldown active");
        _pause();
        lastEmergencyAction = block.timestamp;
        emit EmergencyAction("Contract paused", block.timestamp);
    }

    function emergencyUnpauseToken() external onlyOwner {
        _unpause();
        emit EmergencyAction("Contract unpaused", block.timestamp);
    }

    // Bridge operator management
    function addBridgeOperator(address operator) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) validateAddress(operator) {
        require(operator != address(0), "Invalid operator address");
        if (block.timestamp < roleChangeTimeLock[operator]) revert TimeLockActive(operator);
    
        roleChangeTimeLock[operator] = block.timestamp + ROLE_CHANGE_DELAY;
        grantRole(BRIDGE_OPERATOR_ROLE, operator);
        emit BridgeOperatorAdded(operator);
    }

    function removeBridgeOperator(address operator) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        require(operator != address(0), "Invalid operator address");
        revokeRole(BRIDGE_OPERATOR_ROLE, operator);
        emit BridgeOperatorRemoved(operator);
    }

    // Pool contract management
    function addPoolContract(address poolContract) external nonReentrant onlyOwner {
        require(poolContract != address(0), "Invalid pool contract address");
        poolContracts[poolContract] = true;
        emit PoolContractAdded(poolContract);
    }

    function removePoolContract(address poolContract) external nonReentrant onlyOwner {
        poolContracts[poolContract] = false;
        emit PoolContractRemoved(poolContract);
    }

    // Proof contract management
    function addProofContract(address proofContract) external nonReentrant onlyOwner {
         require(proofContract != address(0), "Invalid proof contract address");
        proofContracts[proofContract] = true;
        emit ProofContractAdded(proofContract);
    }

    function removeProofContract(address proofContract) external nonReentrant onlyOwner {
        proofContracts[proofContract] = false;
        emit ProofContractRemoved(proofContract);
    }

    function transferFromContract(address to, uint256 amount) external virtual whenNotPaused nonReentrant onlyOwner returns (bool) {
        if (paused()) revert TokenPaused();
        _transfer(address(this), to, amount);
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
    function setSupportedChain(uint256 chainId, bool supported) external nonReentrant onlyOwner {
        supportedChains[chainId] = supported;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    uint256[50] private __gap;
}