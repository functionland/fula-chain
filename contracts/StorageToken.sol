// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract StorageToken is ERC20Upgradeable, UUPSUpgradeable, OwnableUpgradeable {
    uint256 private constant TOTAL_SUPPLY = 1_000_000 * 10**18; // 1M tokens
    mapping(address => bool) public bridgeOperators;
    mapping(address => bool) public poolContracts;
    mapping(address => bool) public proofContracts;

    event BridgeTransfer(address indexed from, uint256 amount, uint256 targetChain);
    event BridgeOperatorAdded(address operator);
    event BridgeOperatorRemoved(address operator);
    event PoolContractAdded(address poolContract);
    event PoolContractRemoved(address poolContract);
    event ProofContractAdded(address proofContract);
    event ProofContractRemoved(address proofContract);

    constructor() {}
    
    function initialize() public initializer {
        __ERC20_init("Test Token", "TT");
        __UUPSUpgradeable_init();
        __Ownable_init();
        _mint(msg.sender, TOTAL_SUPPLY);
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

    function bridgeTransfer(uint256 targetChain, uint256 amount) external {
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");
        _burn(msg.sender, amount);
        emit BridgeTransfer(msg.sender, amount, targetChain);
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

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
