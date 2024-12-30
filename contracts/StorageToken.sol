// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./DAMMModule.sol";

contract StorageToken is Initializable, ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, PausableUpgradeable, AccessControlUpgradeable, DAMMModule {
    uint256 private constant TOKEN_UNIT = 10**18;
    uint256 private constant TOTAL_SUPPLY = 1_000_000 * TOKEN_UNIT; // 1M tokens
    bytes32 public constant BRIDGE_OPERATOR_ROLE = keccak256("BRIDGE_OPERATOR_ROLE");
    mapping(address => bool) public bridgeOperators;
    mapping(address => bool) public poolContracts;
    mapping(address => bool) public proofContracts;
    mapping(uint256 => bool) public supportedChains;

    event BridgeTransfer(address indexed from, uint256 amount, uint256 targetChain);
    event BridgeOperatorAdded(address operator);
    event BridgeOperatorRemoved(address operator);
    event PoolContractAdded(address poolContract);
    event PoolContractRemoved(address poolContract);
    event ProofContractAdded(address proofContract);
    event ProofContractRemoved(address proofContract);
    event EmergencyAction(string action, uint256 timestamp);

    //DAMM: Dynamic Automatic Market Making
    event DAMMPoolCreated(address indexed quoteToken, uint256 initialLiquidity);
    event DAMMSwapExecuted(
        address indexed user,
        address indexed quoteToken,
        uint256 indexed amountIn,
        uint256 amountOut
    );
    
    function initialize(address initialOwner) public reinitializer(1) {  // Increment version number for each upgrade
        require(initialOwner != address(0), "Invalid owner address");
        __ERC20_init("Test Token", "TT");
        __UUPSUpgradeable_init();
        __Ownable_init(initialOwner);
        __DAMMModule_init();
        __Pausable_init();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner); // Assign admin role to deployer
        _grantRole(BRIDGE_OPERATOR_ROLE, initialOwner); // Assign bridge operator role to deployer
        _mint(initialOwner, TOTAL_SUPPLY);
    }

    function version() public pure returns (string memory) {
        return "1.0.0";
    }

    function tokenUnit() public pure returns (uint256) {
        return TOKEN_UNIT;
    }


    function emergencyPauseToken() external onlyOwner {
        _pause();
        emit EmergencyAction("Contract paused", block.timestamp);
    }

    function emergencyUnpauseToken() external onlyOwner {
        _unpause();
        emit EmergencyAction("Contract unpaused", block.timestamp);
    }

    modifier onlyBridgeOperator() {
        require(bridgeOperators[msg.sender], "Not a bridge operator");
        _;
    }

    // Bridge operator management
    function addBridgeOperator(address operator) external onlyRole(DEFAULT_ADMIN_ROLE) validateAddress(operator) {
        require(operator != address(0), "Invalid operator address");
        require(!bridgeOperators[operator], "Operator already exists");
        grantRole(BRIDGE_OPERATOR_ROLE, operator);
        bridgeOperators[operator] = true;
        emit BridgeOperatorAdded(operator);
    }

    function removeBridgeOperator(address operator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(operator != address(0), "Invalid operator address");
        revokeRole(BRIDGE_OPERATOR_ROLE, operator);
        bridgeOperators[operator] = false;
        emit BridgeOperatorRemoved(operator);
    }

    // Pool contract management
    function addPoolContract(address poolContract) external onlyOwner {
        poolContracts[poolContract] = true;
        emit PoolContractAdded(poolContract);
    }

    function removePoolContract(address poolContract) external onlyOwner {
        poolContracts[poolContract] = false;
        emit PoolContractRemoved(poolContract);
    }

    // Proof contract management
    function addProofContract(address proofContract) external onlyOwner {
        proofContracts[proofContract] = true;
        emit ProofContractAdded(proofContract);
    }

    function removeProofContract(address proofContract) external onlyOwner {
        proofContracts[proofContract] = false;
        emit ProofContractRemoved(proofContract);
    }

    // Bridge-specific functions with access control
    function bridgeMint(address to, uint256 amount, uint256 sourceChain) 
        external onlyBridgeOperator {
        require(totalSupply() + amount <= TOTAL_SUPPLY, "Exceeds maximum supply");
        require(supportedChains[sourceChain], "Unsupported source chain");
        _mint(to, amount);
    }

    function bridgeBurn(address from, uint256 amount) external onlyBridgeOperator {
        _burn(from, amount);
    }

    // Override transfer functions to handle pool and proof contracts
    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) public virtual override returns (bool) {
        if (poolContracts[msg.sender] || proofContracts[msg.sender]) {
            _transfer(sender, recipient, amount);
            return true;
        }
        return super.transferFrom(sender, recipient, amount);
    }

    // multi-chain token transfer
    // Add function to manage supported chains
    function setSupportedChain(uint256 chainId, bool supported) external onlyOwner {
        supportedChains[chainId] = supported;
    }

    // Modify bridgeTransfer function
    function bridgeTransfer(uint256 targetChain, uint256 amount) external {
        require(supportedChains[targetChain], "Unsupported chain");
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");
        
        // Lock tokens on source chain
        _burn(msg.sender, amount);
        
        // Emit event for bridge operators
        emit BridgeTransfer(msg.sender, amount, targetChain);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    uint256[50] private __gap;
}

// yarn hardhat verify --network sepolia 0x...