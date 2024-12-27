// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./DAMMModule.sol";

contract StorageToken is Initializable, ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, DAMMModule {
    uint256 private constant TOTAL_SUPPLY = 1_000_000 * 10**18; // 1M tokens
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

    //DAMM
    event DAMMPoolCreated(address indexed quoteToken, uint256 initialLiquidity);
    event DAMMSwapExecuted(address indexed user, uint256 amountIn, uint256 amountOut);
    
    function initialize() public reinitializer(1) {  // Increment version number for each upgrade
        __ERC20_init("Test Token", "TT");
        __UUPSUpgradeable_init();
        __Ownable_init();
        __DAMMModule_init();
        _mint(msg.sender, TOTAL_SUPPLY);
    }

    function version() public pure returns (string memory) {
        return "1.0.0";
    }

    modifier onlyBridgeOperator() {
        require(bridgeOperators[msg.sender], "Not a bridge operator");
        _;
    }

    // Bridge operator management
    function addBridgeOperator(address operator) external onlyOwner {
        bridgeOperators[operator] = true;
        emit BridgeOperatorAdded(operator);
    }

    function removeBridgeOperator(address operator) external onlyOwner {
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
    function bridgeMint(address to, uint256 amount) external onlyBridgeOperator {
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

    // Modify bridgeMint for receiving chain
    function bridgeMint(address to, uint256 amount, uint256 sourceChain) 
        external onlyBridgeOperator {
        require(supportedChains[sourceChain], "Unsupported source chain");
        _mint(to, amount);
    }

    //DAMM
    function executeDAMMSwap(
        address quoteToken,
        uint256 amountIn,
        uint256 minAmountOut,
        bool isBaseToQuote
    ) external returns (uint256) {
        if (isBaseToQuote) {
            _transfer(msg.sender, address(this), amountIn);
            uint256 amountOut = super.swap(quoteToken, amountIn, minAmountOut, true);
            require(IERC20(quoteToken).transfer(msg.sender, amountOut), "Quote transfer failed");
            return amountOut;
        } else {
            require(IERC20(quoteToken).transferFrom(msg.sender, address(this), amountIn), "Quote transfer failed");
            uint256 amountOut = super.swap(quoteToken, amountIn, minAmountOut, false);
            _transfer(address(this), msg.sender, amountOut);
            return amountOut;
        }
    }

    function createDAMMPool(
        address quoteToken,
        address priceFeed,
        uint256 initialBaseAmount,
        uint256 initialQuoteAmount
    ) external onlyOwner {
        require(IERC20(quoteToken).transferFrom(msg.sender, address(this), initialQuoteAmount), "Quote transfer failed");
        _transfer(msg.sender, address(this), initialBaseAmount);
        
        super.createPool(quoteToken, priceFeed, initialBaseAmount, initialQuoteAmount);
        emit DAMMPoolCreated(quoteToken, initialBaseAmount);
    }

    function emergencyPausePool(address quoteToken) external onlyOwner {
        super.pausePool(quoteToken);
    }

    function emergencyResumePool(address quoteToken) external onlyOwner {
        super.resumePool(quoteToken);
    }

    function updatePoolParameters(address quoteToken) external {
        updatePoolDynamics(quoteToken);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}

// yarn hardhat verify --network sepolia 0x...