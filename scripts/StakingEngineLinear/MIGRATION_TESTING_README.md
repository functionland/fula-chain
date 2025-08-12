# 🧪 StakingEngineLinearWithMigration Testing Guide

This guide provides comprehensive local testing for the StakingEngineLinearWithMigration migration process before deploying to mainnet.

## 📋 Overview

The migration testing system systematically validates the entire migration process by:
1. Deploying original contracts locally
2. Performing realistic staking operations
3. Extracting all data from original contracts
4. Deploying new contracts with migration capabilities
5. Migrating all data to new contracts
6. Verifying migration completeness and accuracy
7. Testing functionality of migrated contracts

## 🛠️ Prerequisites

- Node.js (v16 or higher)
- Hardhat development environment
- All project dependencies installed (`npm install`)

## 📁 Files Created

### Core Migration Files
- `deployAndMigrateLocalStakingEngine.ts` - Comprehensive local testing script
- `StakingEngineLinearWithMigration.sol` - Enhanced contract with migration functions
- `migrateStakingContracts.ts` - Data extraction script (for mainnet)
- `deployWithMigration.ts` - Deployment script (for mainnet)
- `migrateStakeData.ts` - Data migration script (for mainnet)
- `verifyMigration.ts` - Verification script (for mainnet)

### Test Runners
- `runMigrationTest.sh` - Unix/Linux/macOS test runner
- `runMigrationTest.bat` - Windows test runner

### Documentation
- `EMERGENCY_MIGRATION_README.md` - Mainnet migration guide
- `MIGRATION_TESTING_README.md` - This testing guide

## 🚀 Quick Start

### Option 1: Using Test Runner Scripts (Recommended)

**Unix/Linux/macOS:**
```bash
chmod +x scripts/StakingEngineLinear/runMigrationTest.sh
./scripts/StakingEngineLinear/runMigrationTest.sh
```

**Windows:**
```cmd
scripts\runMigrationTest.bat
```

### Option 2: Manual Execution

```bash
# Terminal 1: Start Hardhat node
npx hardhat node

# Terminal 2: Run the test
npx hardhat compile
npx hardhat run scripts/StakingEngineLinear/deployAndMigrateLocalStakingEngine.ts --network localhost
```

## 📊 Test Phases

### Phase 1: Deploy Original Contracts
- Deploys StorageToken with full governance setup
- Deploys StakingPool contracts (stake and reward pools)
- Deploys original StakingEngineLinear (to simulate compromised contract)
- Sets up permissions and funding

### Phase 2: Perform Staking Operations
- User1: Stakes 1000 tokens for 90 days (no referrer)
- User2: Stakes 1000 tokens for 180 days (User1 as referrer)
- User3: Stakes 1000 tokens for 365 days (User2 as referrer)
- User4: Multiple stakes (90d, 180d with referrer, 365d)
- Advances time and claims some rewards

### Phase 3: Extract Data
- Reads all global state variables
- Extracts token balances from pools
- Collects all user stakes and referrer data
- Saves to `migration-data-local-test.json`

### Phase 4: Deploy New Contracts
- Deploys new StakingPool contracts (secure replacements)
- Deploys **StakingEngineLinearWithMigration** (enhanced with migration capabilities)
- Transfers funds from old to new contracts

### Phase 5: Migrate Data
- Enables migration mode on **StakingEngineLinearWithMigration** (pauses normal operations)
- Sets global state variables using `setTotalStaked()`
- Migrates all user stakes using `migrateStake()` function
- Migrates referrer data using `migrateReferrer()` function
- Disables migration mode using `disableMigrationMode()`

### Phase 6: Comprehensive Verification
- Verifies global state variables match
- Verifies all user stakes migrated correctly
- Verifies referrer data migrated correctly
- Verifies token balances transferred correctly

### Phase 7: Functional Testing
- Tests new staking operations on migrated contract
- Tests claiming rewards on migrated stakes
- Tests referrer rewards on migrated data
- Verifies contract state consistency

## 📈 Expected Output

### Successful Test Output
```
🧪 COMPREHENSIVE LOCAL STAKING ENGINE MIGRATION TEST 🧪
======================================================================

Test accounts:
- Deployer: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
- Admin: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
...

🏗️  PHASE 1: DEPLOYING ORIGINAL CONTRACTS
--------------------------------------------------
✅ StorageToken deployed: 0x...
✅ Original StakingEngineLinear: 0x... (simulating compromised contract)
✅ New StakingEngineLinearWithMigration: 0x... (secure replacement)
...

💰 PHASE 2: PERFORMING STAKING OPERATIONS
--------------------------------------------------
✅ User1 staked 1000.0 for 90 days (no referrer)
✅ User2 staked 1000.0 for 180 days (User1 referrer)
...

🎉 MIGRATION TEST SUCCESSFUL! 🎉
```

### Generated Files
- `migration-data-local-test.json` - Extracted data from original contracts
- `migration-test-results-[timestamp].json` - Detailed test results
- `hardhat-node.log` - Hardhat node logs

## 🔍 Verification Checks

The test performs comprehensive verification:

### Global State Verification
- ✅ Total staked amounts match
- ✅ Period-specific staked amounts match

### User Stakes Verification
- ✅ Stake count matches for each user
- ✅ Stake amounts match exactly
- ✅ Reward debt matches
- ✅ Lock periods match
- ✅ Start times match
- ✅ Referrer addresses match
- ✅ Active status matches

### Referrer Data Verification
- ✅ Total referred count matches
- ✅ Total rewards match
- ✅ Last claim time matches

### Token Balance Verification
- ✅ StakePool balance transferred correctly
- ✅ RewardPool balance transferred correctly

### Functional Verification
- ✅ New staking operations work
- ✅ Reward claiming works on migrated stakes
- ✅ Referrer rewards work on migrated data
- ✅ Contract state updates correctly

## 🛡️ Security Features Tested

### Migration Mode
- ✅ Normal operations paused during migration (`enableMigrationMode()`)
- ✅ Only admin can perform migration functions (`migrateStake`, `migrateReferrer`, `setTotalStaked`)
- ✅ Migration mode can be enabled/disabled (`disableMigrationMode()`)

### Data Validation
- ✅ Input validation on migration functions
- ✅ Lock period validation
- ✅ Amount validation

### Access Control
- ✅ Only admin can call migration functions
- ✅ Proper role-based access control

## 🐛 Troubleshooting

### Common Issues

**"hardhat.config.ts not found"**
- Ensure you're running the script from the project root directory

**"Contract compilation failed"**
- Run `npx hardhat clean` then `npx hardhat compile`
- Check for syntax errors in contracts

**"Failed to start Hardhat node"**
- Kill any existing node processes
- Check if port 8545 is available

**"Migration test failed"**
- Check the detailed error output
- Review `hardhat-node.log` for additional information
- Ensure all dependencies are installed

### Debug Mode

For detailed debugging, run the test manually:
```bash
npx hardhat node --verbose
# In another terminal:
npx hardhat run scripts/StakingEngineLinear/deployAndMigrateLocalStakingEngine.ts --network localhost
```

## 📋 Test Results Interpretation

### Success Criteria
- All phases complete without errors
- All verification checks pass
- Functional tests pass
- No data mismatches

### Failure Indicators
- Verification errors in output
- Exception during migration
- Data mismatches
- Functional test failures

## 🚀 Next Steps

After successful local testing:

1. **Review test results** - Check `migration-test-results-*.json`
2. **Validate contract addresses** - Ensure all contracts deployed correctly
3. **Proceed to mainnet** - Use the emergency migration scripts
4. **Monitor deployment** - Watch for any issues during mainnet migration

## 📞 Support

If you encounter issues:
1. Check the troubleshooting section
2. Review generated log files
3. Ensure all prerequisites are met
4. Verify contract compilation succeeds

---

**Remember**: This local testing validates the migration process thoroughly before mainnet deployment. Always run this test after any changes to migration scripts or contracts.
