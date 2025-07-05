# StoragePool Deployment Guide

This guide covers the deployment of StoragePool contracts using the provided deployment scripts, following the same patterns as the Airdrop contract deployment.

## Overview

The StoragePool contract is a UUPS upgradeable proxy that manages decentralized storage pools. It requires a deployed StorageToken contract and proper initialization with owner and admin addresses.

## Prerequisites

1. **StorageToken Contract**: Must be deployed first
2. **Environment Variables**: Required for mainnet deployment
3. **Network Configuration**: Hardhat network configuration
4. **Sufficient ETH**: For gas fees on target network

## Deployment Scripts

### 1. Local Development Deployment

**Script**: `scripts/deployLocalStoragePool.ts`

**Purpose**: Deploy StoragePool on local Hardhat network with full setup including sample data

**Prerequisites**:
- Run `npx hardhat node` in a separate terminal

**Environment Variables (all optional)**:
```bash
TOKEN_ADDRESS=<Existing_StorageToken_Address>  # Optional: use existing token
INITIAL_OWNER=<Owner_Address>                  # Optional: custom owner
INITIAL_ADMIN=<Admin_Address>                  # Optional: custom admin
```

**Commands**:

*Option 1: Deploy with new StorageToken (full deployment):*
```bash
npx hardhat run scripts/StoragePool/deployLocalStoragePool.ts --network localhost
```

*Option 2: Deploy with existing StorageToken:*
```bash
TOKEN_ADDRESS=0x... npx hardhat run scripts/StoragePool/deployLocalStoragePool.ts --network localhost
```

*Option 3: Deploy with custom addresses:*
```bash
TOKEN_ADDRESS=0x... INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/StoragePool/deployLocalStoragePool.ts --network localhost
```

**Features**:
- **Smart Token Deployment**: Automatically deploys StorageToken if not provided, or connects to existing one
- **Command Line Parameters**: Use `--token <address>` to specify existing StorageToken
- Deploys StoragePool with predefined admin/owner wallets
- Sets up governance parameters (quorum, transaction limits) intelligently
- Authorizes StoragePool in StorageToken contract
- Creates a sample pool for testing
- Displays comprehensive contract details
- Verifies deployment integrity

**Token Deployment Logic**:
- **Without `TOKEN_ADDRESS`**: Deploys new StorageToken with 2B total supply, 1B initially minted
- **With `TOKEN_ADDRESS`**: Connects to existing StorageToken and validates it
- **Address Handling**: Uses provided `INITIAL_OWNER`/`INITIAL_ADMIN` or defaults to hardhat accounts
- **Governance Setup**: Only configures governance if deploying new token
- **Timelock Handling**: Skips timelock waits when using existing tokens

### 2. Mainnet/Testnet Deployment

**Script**: `scripts/deployStoragePool.ts`

**Purpose**: Deploy StoragePool on mainnet or testnets with production-ready configuration

**Environment Variables Required**:
```bash
TOKEN_ADDRESS=<StorageToken_Proxy_Address>
INITIAL_OWNER=<Owner_Address>
INITIAL_ADMIN=<Admin_Address>
ETHERSCAN_API_KEY=<API_Key> # Optional, for automatic verification
```

**Command**:
```bash
TOKEN_ADDRESS=0x... INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/StoragePool/deployStoragePool.ts --network sepolia
```

**Features**:
- Validates StorageToken contract before deployment
- Deploys StoragePoolLib library and links it to StoragePool
- Estimates gas costs and checks account balance
- Requires user confirmation before deployment
- Automatic verification of both proxy and implementation contracts on Etherscan
- Provides post-deployment instructions

### 3. Legacy Deployment (Updated)

**Script**: `scripts/TBD/deployPool.ts`

**Purpose**: Updated version of the original deployment script with correct parameters

**Environment Variables Required**:
```bash
TOKEN_ADDRESS=<StorageToken_Address>
INITIAL_OWNER=<Owner_Address>
INITIAL_ADMIN=<Admin_Address>
```

## Upgrade Scripts

### StoragePool Implementation Upgrade

**Script**: `scripts/StoragePool/upgradeStoragePool.ts`

**Purpose**: Deploy new implementation contract for existing StoragePool proxies

**Command**:
```bash
npx hardhat run scripts/StoragePool/upgradeStoragePool.ts --network sepolia
```

**Features**:
- Deploys new implementation contract
- Automatic contract verification
- Outputs implementation address for upgrade process

## Post-Deployment Steps

After deploying StoragePool, complete these essential steps:

### 1. Authorize StoragePool in StorageToken

The StoragePool must be authorized in the StorageToken contract to manage token locks:

```solidity
// Call this function on the StorageToken contract
StorageToken.addPoolContract(storagePoolAddress)
```

### 2. Set Up Governance Parameters

Configure governance settings if not done during deployment:

```solidity
// Set quorum for admin role
storagePool.setRoleQuorum(ADMIN_ROLE, 2)

// Set transaction limits
storagePool.setRoleTransactionLimit(ADMIN_ROLE, amount)
```

### 3. Grant Pool Creator Roles

Grant `POOL_CREATOR_ROLE` to addresses that should create pools:

```solidity
storagePool.grantRole(POOL_CREATOR_ROLE, creatorAddress)
```

### 4. Configure Pool Creation Requirements

Adjust token requirements for pool creation if needed:

```solidity
storagePool.setDataPoolCreationTokens(newAmount)
```

## Contract Verification

### Automatic Verification

Set `ETHERSCAN_API_KEY` environment variable for automatic verification during deployment.

### Manual Verification

```bash
# Verify implementation contract
npx hardhat verify <implementation_address> --network sepolia

# Verify with specific contract path
npx hardhat verify --contract contracts/core/StoragePool.sol:StoragePool <proxy_address> --network sepolia
```

## Important Notes

### Contract Size Optimization

StoragePool uses external library linking (`StoragePoolLib.sol`) to stay under the 24KB deployment limit. The deployment scripts automatically deploy the StoragePoolLib library first, then link it to the StoragePool contract during deployment.

### Initialization Parameters

StoragePool requires three initialization parameters:
1. `_storageToken`: Address of the deployed StorageToken contract
2. `initialOwner`: Address that will own the contract and have admin privileges
3. `initialAdmin`: Address that will have admin role for governance operations

### Default Configuration

- **Pool Creation Requirement**: 500,000 tokens (500K FULA)
- **Default Challenge Response Period**: 7 days (if not specified)
- **Governance Module**: Automatically initialized with timelock and role management

## Troubleshooting

### Common Issues

1. **"Invalid token address"**: Ensure TOKEN_ADDRESS points to a valid StorageToken contract
2. **"Insufficient balance"**: Ensure deployer account has enough ETH for gas fees
3. **"External library linking"**: Ensure `unsafeAllow` flag is included in deployment options
4. **Verification failures**: Wait for sufficient block confirmations before verification

### Gas Estimation

The deployment scripts provide gas estimation to help plan deployment costs. Actual costs may vary based on network conditions.

## Security Considerations

1. **Owner/Admin Separation**: Use different addresses for owner and admin roles
2. **Multi-sig Recommended**: Consider using multi-signature wallets for owner/admin roles
3. **Timelock Governance**: The contract includes built-in timelock mechanisms for sensitive operations
4. **Role Management**: Carefully manage who receives POOL_CREATOR_ROLE and other privileged roles

## Example Deployment Flow

1. Deploy StorageToken (if not already deployed)
2. Run StoragePool deployment script
3. Authorize StoragePool in StorageToken
4. Set up governance parameters
5. Grant necessary roles
6. Create initial pools or configure pool creation requirements
7. Verify all contracts on block explorer
