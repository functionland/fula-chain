# 🚨 Emergency Contract Migration Guide

This guide provides a complete process for migrating from compromised StakingEngineLinear and StakingPool contracts to new secure ones.

## 📋 Overview

Due to a security incident, you need to:
1. Extract all storage data from compromised contracts
2. Deploy new secure contracts
3. Transfer funds from old to new contracts
4. Migrate all user stake data
5. Resume normal operations

## 🛠️ Prerequisites

- Node.js and Hardhat environment set up
- Access to deployer account with sufficient ETH for gas
- Admin access to old contracts (if possible)
- Network access to read from compromised contracts

## 📁 Files Created

- `scripts/StakingEngineLinear/validateContractAddresses.ts` - Validate contract addresses before migration
- `scripts/StakingEngineLinear/migrateStakingContracts.ts` - Extract data from old contracts
- `scripts/StakingEngineLinear/deployWithMigration.ts` - Deploy new contracts
- `scripts/StakingEngineLinear/migrateStakeData.ts` - Migrate stake data to new contracts
- `contracts/core/StakingEngineLinearWithMigration.sol` - Enhanced contract with migration functions

## 🚀 Step-by-Step Migration Process

### Step 1: Validate Contract Addresses

**First, set the correct contract addresses:**

```bash
# Set environment variables for the compromised contract addresses
export COMPROMISED_STAKING_ENGINE="0x[actual_staking_engine_address]"
export COMPROMISED_STAKE_POOL="0x[actual_stake_pool_address]"
export COMPROMISED_REWARD_POOL="0x[actual_reward_pool_address]"
```

**⚠️ Important: Replace the placeholder addresses with actual contract addresses**

To find the correct contract addresses:
1. Check your deployment records
2. Look at previous transaction history
3. Use block explorers (Basescan) to verify contract existence
4. Ensure the contracts have the expected functions (`token()`, `stakes()`, etc.)

**Validate the addresses before proceeding:**

```bash
# Validate that all contract addresses are correct and accessible
npx hardhat run scripts/StakingEngineLinear/validateContractAddresses.ts --network base
```

This validation script will:
- ✅ Check address format validity
- ✅ Verify contracts exist on the network
- ✅ Test critical contract functions
- ✅ Display network and contract information

### Step 2: Extract Data from Compromised Contracts

```bash
# Extract all storage data from compromised contracts
npx hardhat run scripts/StakingEngineLinear/migrateStakingContracts.ts --network base
```

This will:
- Read all stake data from StakingEngineLinear
- Extract referrer information
- Get token balances from StakingPools
- Save everything to `migration-data-[timestamp].json`

**Output**: `migration-data-2024-01-01T12-00-00-000Z.json`

### Step 2: Deploy New Contracts

```bash
# Set environment variables
export MIGRATION_DATA_FILE="migration-data-2024-01-01T12-00-00-000Z.json"
export INITIAL_OWNER="0x383a6A34C623C02dcf9BB7069FAE4482967fb713"
export INITIAL_ADMIN="0xFa8b02596a84F3b81B4144eA2F30482f8C33D446"
export DEPLOY_POOLS=true

# Deploy new contracts
npx hardhat run scripts/StakingEngineLinear/deployWithMigration.ts --network base
```

This will:
- Deploy new StakingPool contracts (stake pool and reward pool)
- Deploy new **StakingEngineLinearWithMigration** (enhanced with migration capabilities)
- Set up proper permissions and configurations
- Save deployment info to `deployment-[timestamp].json`

**Output**: `deployment-2024-01-01T12-30-00-000Z.json`

### Step 3: Transfer Funds (CRITICAL - Do Immediately)

⚠️ **URGENT**: Transfer all tokens from old contracts to new ones immediately:

```bash
# The deployWithMigration.ts script will handle fund transfers automatically
# It will transfer tokens from:
# - Old StakePool (0xfa9cb36656cf9A2D2BA3a6b0aD810fB9993F7A21)
# - Old RewardPool (if accessible)
# To the new StakePool and RewardPool addresses

# If automatic transfer fails, you may need to:
# 1. Use emergency withdrawal functions (if available)
# 2. Transfer manually through admin interface
# 3. Use governance proposals to move funds
```

### Step 4: Migrate Stake Data

```bash
# Set environment variables
export MIGRATION_DATA_FILE="migration-data-2024-01-01T12-00-00-000Z.json"
export DEPLOYMENT_INFO_FILE="deployment-2024-01-01T12-30-00-000Z.json"

# Migrate all stake data using StakingEngineLinearWithMigration
npx hardhat run scripts/StakingEngineLinear/migrateStakeData.ts --network base
```

This will:

- Enable migration mode on **StakingEngineLinearWithMigration** (pauses normal operations)
- Migrate all user stakes using `migrateStake()` function
- Migrate referrer data using `migrateReferrer()` function
- Set global state variables using `setTotalStaked()` function
- Verify migration completeness
- Mark users as migrated using `markUserMigrated()` function

### Step 5: Resume Normal Operations

```bash
# After verifying all data is migrated correctly, disable migration mode:
# This will call disableMigrationMode() on the StakingEngineLinearWithMigration contract
# Normal staking operations will resume
```

## 📊 Data Being Migrated

### StakingEngineLinearWithMigration Data

- **User Stakes**: Amount, reward debt, lock period, start time, referrer, active status
- **Referrer Info**: Total referred users, total rewards, last claim time
- **Global State**: Total staked amounts by period
- **Tracking Arrays**: All staker addresses, stakers by period

### StakingPool Data

- **Token Balances**: All locked tokens in stake and reward pools
- **Contract References**: Token address, staking engine address

## 🔒 Security Considerations

1. **Migration Mode**: StakingEngineLinearWithMigration has migration mode that pauses normal operations during migration
2. **Admin Only**: All migration functions (`migrateStake`, `migrateReferrer`, `setTotalStaked`) require admin role
3. **Data Validation**: Migration functions validate input data (amounts, lock periods, addresses)
4. **Batch Processing**: Large migrations are processed in batches using `migrateMultipleStakes()` to avoid gas limits
5. **Verification**: Built-in verification to ensure migration completeness
6. **Pause Protection**: Normal staking functions are blocked during migration mode

## ⚠️ Important Notes

### Manual Steps Required

1. **Fund Transfer**: You must manually transfer tokens from old to new contracts
2. **User Notification**: Inform users about new contract addresses
3. **Frontend Updates**: Update frontend to use new contract addresses
4. **Block Explorer**: Verify new contracts on block explorer

### Verification Checklist

- [ ] All user stakes migrated correctly
- [ ] All referrer data migrated
- [ ] Total staked amounts match
- [ ] Token balances transferred completely
- [ ] New contracts verified on block explorer
- [ ] Frontend updated with new addresses
- [ ] Users notified of migration

## 🆘 Troubleshooting

### Common Issues

1. **Gas Limit Exceeded**: Reduce batch size in migration script
2. **Access Denied**: Ensure deployer has admin role on new contracts
3. **Data Mismatch**: Verify migration data file integrity
4. **Fund Transfer Failed**: Use emergency withdrawal functions if available

### Recovery Options

If migration fails partially:

- Migration functions can be called multiple times
- Use `markUserMigrated()` to track progress
- Verify individual user data with getter functions
- Check `getMigrationStatus()` for progress tracking

## 📞 Emergency Contacts

- Ensure you have backup admin accounts
- Keep migration data files secure
- Document all transaction hashes for audit trail

## 🎯 Success Criteria

Migration is complete when:

1. ✅ All funds transferred to new contracts
2. ✅ All user stakes migrated using `migrateStake()` or `migrateMultipleStakes()`
3. ✅ All referrer data migrated using `migrateReferrer()`
4. ✅ Global state variables set correctly using `setTotalStaked()`
5. ✅ Migration mode disabled using `disableMigrationMode()`
6. ✅ Normal operations resumed (staking/unstaking/claiming work)
7. ✅ Users can interact with new StakingEngineLinearWithMigration contract

## 🔍 Verification Script

After migration, run the verification script:

```bash
export NEW_STAKING_ENGINE="[new_contract_address]"
export MIGRATION_DATA_FILE="migration-data-2024-01-01T12-00-00-000Z.json"
npx hardhat run scripts/StakingEngineLinear/verifyMigration.ts --network base
```

---

**Remember**: This is an emergency procedure. Work quickly but carefully, and verify each step before proceeding to the next.
