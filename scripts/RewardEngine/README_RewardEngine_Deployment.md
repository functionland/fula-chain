# RewardEngine Secure Deployment Guide

This guide covers the secure deployment of RewardEngine contracts using the provided deployment scripts, following the same security patterns as StoragePool deployment to prevent ERC1967Proxy front-running attacks.

## Overview

The RewardEngine contract is a UUPS upgradeable proxy that manages mining and storage rewards for pool members. It requires deployed StorageToken, StoragePool, and StakingPool contracts and proper initialization with owner and admin addresses.

## Security Features

✅ **ERC1967Proxy Attack Protection**: Implementation contracts are automatically initialized with dummy values to prevent front-running attacks  
✅ **UUPS Constructor Protection**: `_disableInitializers()` in constructor  
✅ **Governance Module Integration**: Proper role-based access control  
✅ **Comprehensive Verification**: Automatic security checks after deployment  

## Prerequisites

1. **StorageToken Contract**: Must be deployed first
2. **StoragePool Contract**: Must be deployed and configured
3. **StakingPool Contract**: Must be deployed and configured
4. **Environment Variables**: Required for mainnet deployment
5. **Network Configuration**: Hardhat network configuration
6. **Sufficient ETH**: For gas fees on target network

## Deployment Scripts

### 1. Local Development Deployment

**Script**: `scripts/RewardEngine/deployLocalRewardEngine.ts`

**Purpose**: Complete local testing environment with all dependencies

**Features**:
- Deploys StorageToken, StakingPool, StoragePool, and RewardEngine
- Secures all implementation contracts automatically
- Sets up governance parameters
- Funds contracts with test tokens
- Creates test user accounts

**Command**:
```bash
npx hardhat run scripts/RewardEngine/deployLocalRewardEngine.ts --network localhost
```

**What it deploys**:
- StorageToken with 1B token supply
- StakingPool for holding reward tokens
- StoragePool for managing storage pools
- RewardEngine for calculating and distributing rewards
- All implementation contracts properly secured
- Test accounts funded with tokens

### 2. Production Deployment

**Script**: `scripts/RewardEngine/deployRewardEngine.ts`

**Purpose**: Deploy RewardEngine to existing infrastructure

**Environment Variables Required**:

*Option 1: Deploy with existing StakingPool*
```bash
STORAGE_TOKEN_ADDRESS=<StorageToken_Proxy_Address>
STORAGE_POOL_ADDRESS=<StoragePool_Proxy_Address>
STAKING_POOL_ADDRESS=<StakingPool_Proxy_Address>
INITIAL_OWNER=<Owner_Address>
INITIAL_ADMIN=<Admin_Address>
ETHERSCAN_API_KEY=<API_Key> # Optional, for automatic verification
```

*Option 2: Deploy with new StakingPool*
```bash
STORAGE_TOKEN_ADDRESS=<StorageToken_Proxy_Address>
STORAGE_POOL_ADDRESS=<StoragePool_Proxy_Address>
DEPLOY_STAKING_POOL=true
INITIAL_OWNER=<Owner_Address>
INITIAL_ADMIN=<Admin_Address>
ETHERSCAN_API_KEY=<API_Key> # Optional, for automatic verification
```

**Commands**:

*Deploy with existing StakingPool:*
```bash
STORAGE_TOKEN_ADDRESS=0x... STORAGE_POOL_ADDRESS=0x... STAKING_POOL_ADDRESS=0x... INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/RewardEngine/deployRewardEngine.ts --network sepolia
```

*Deploy with new StakingPool:*
```bash
STORAGE_TOKEN_ADDRESS=0x... STORAGE_POOL_ADDRESS=0x... DEPLOY_STAKING_POOL=true INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/RewardEngine/deployRewardEngine.ts --network sepolia
```

**Features**:
- Validates all dependency contracts before deployment
- **Can deploy new StakingPool if needed** (set `DEPLOY_STAKING_POOL=true`)
- Deploys RewardEngine as UUPS proxy
- **SECURELY initializes all implementation contracts with dummy values**
- Estimates gas costs and checks account balance
- Requires user confirmation before deployment
- Automatic verification of both proxy and implementation contracts
- Sets up governance parameters
- Provides post-deployment instructions

## Security Verification

### Automatic Security Check

After deployment, verify your contracts are secure:

```bash
# Check RewardEngine only
REWARD_ENGINE_PROXY=0x... npx hardhat run scripts/checkERC1967SecurityQuick.ts --network <network>

# Check all contracts
STORAGE_TOKEN_PROXY=0x... STAKING_POOL_PROXY=0x... STORAGE_POOL_PROXY=0x... REWARD_ENGINE_PROXY=0x... npx hardhat run scripts/checkERC1967SecurityQuick.ts --network <network>
```

### Manual Security Verification

You can also manually verify implementation security:

```typescript
// Get implementation address
const implAddress = await upgrades.erc1967.getImplementationAddress(rewardEngineProxy);

// Try to initialize (should fail if secure)
const impl = await ethers.getContractAt("RewardEngine", implAddress);
try {
    await impl.initialize.staticCall(deadAddress, deadAddress, deadAddress, deadAddress, deadAddress);
    console.log("🚨 VULNERABLE: Implementation can still be initialized!");
} catch (error) {
    if (error.message.includes("already initialized")) {
        console.log("✅ SAFE: Implementation is already initialized");
    }
}
```

## Post-Deployment Configuration

### 1. Configure Reward Parameters

```solidity
// Set monthly reward per peer (default: 8000 tokens)
await rewardEngine.setMonthlyRewardPerPeer(ethers.parseEther("8000"));

// Set expected period (default: 8 hours)
await rewardEngine.setExpectedPeriod(8 * 60 * 60);
```

### 2. Set Up StakingPool Permissions

The RewardEngine needs permission to transfer tokens from StakingPool:

```solidity
// This should be done during StakingPool setup
await stakingPool.setStakingEngine(rewardEngineAddress);
```

### 3. Fund StakingPool with Reward Tokens

```solidity
// Transfer reward tokens to StakingPool
await storageToken.transferFromContract(stakingPoolAddress, rewardAmount);
```

## Integration with Existing Contracts

### StoragePool Integration

RewardEngine reads pool membership and online status from StoragePool:

```solidity
// RewardEngine calls these StoragePool functions:
storagePool.isPeerIdMemberOfPool(poolId, peerId)
storagePool.getTotalMembers()
```

### StakingPool Integration

RewardEngine transfers reward tokens from StakingPool:

```solidity
// RewardEngine calls this StakingPool function:
stakingPool.transferTokens(amount)
```

## Testing

### Local Testing Setup

1. Deploy local environment:
```bash
npx hardhat run scripts/RewardEngine/deployLocalRewardEngine.ts --network localhost
```

2. Create test pools and add members using StoragePool
3. Update online status for peer IDs
4. Test reward calculations and claiming

### Integration Tests

The deployment includes comprehensive integration tests in:
- `test/governance/integration/RewardEngine.test.ts`

## Troubleshooting

### Common Issues

1. **"InvalidAddress" error**: Check that all dependency contracts are deployed and addresses are correct
2. **"Already initialized" error**: Implementation was already secured (this is good!)
3. **Gas estimation fails**: Check that all contracts exist and parameters are valid
4. **Verification fails**: Ensure ETHERSCAN_API_KEY is set and network is supported

### Security Issues

If security check shows vulnerabilities:

```bash
# Fix vulnerable implementations automatically
npx hardhat run scripts/checkVulnarable.ts --network <network>
```

## Best Practices

1. **Always run security checks** after deployment
2. **Verify contracts on block explorer** for transparency
3. **Test on testnet first** before mainnet deployment
4. **Keep private keys secure** and use hardware wallets for mainnet
5. **Monitor contract events** for unusual activity
6. **Set up governance properly** with appropriate quorum and timelock

## Contract Addresses Template

After deployment, record your contract addresses:

```
Network: <network_name>
StorageToken: 0x...
StakingPool: 0x...
StoragePool: 0x...
RewardEngine: 0x...
RewardEngine Implementation: 0x...
Deployment Block: <block_number>
Deployer: 0x...
```

## Security Note

This deployment script includes critical security measures to prevent the ERC1967Proxy front-running attack. The implementation contracts are automatically initialized with dummy values to prevent attackers from hijacking them. This is essential for maintaining the security of your entire system.
