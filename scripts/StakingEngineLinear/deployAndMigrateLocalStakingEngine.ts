// Comprehensive local testing script for StakingEngine deployment and migration
// This script systematically tests the entire migration process locally

import { ethers, upgrades } from "hardhat";
import { parseUnits } from "ethers";
import * as fs from "fs";
import * as path from "path";

interface StakeInfo {
    amount: string;
    rewardDebt: string;
    lockPeriod: string;
    startTime: string;
    referrer: string;
    isActive: boolean;
}

interface ReferrerInfo {
    totalReferred: string;
    totalRewards: string;
    lastClaimTime: string;
    unclaimedRewards?: string;
    referredStakersCount?: string;
    activeReferredStakersCount?: string;
    totalActiveStaked?: string;
    totalUnstaked?: string;
    totalActiveStaked90Days?: string;
    totalActiveStaked180Days?: string;
    totalActiveStaked365Days?: string;
}

interface MigrationData {
    stakes: { [address: string]: StakeInfo[] };
    referrers: { [address: string]: ReferrerInfo };
    totalStaked: string;
    totalStaked90Days: string;
    totalStaked180Days: string;
    totalStaked365Days: string;
    allStakerAddresses: string[];
    stakingPoolTokenBalance: string;
    rewardPoolTokenBalance: string;
    tokenAddress: string;
}

async function main() {
    console.log("🧪 COMPREHENSIVE LOCAL STAKING ENGINE MIGRATION TEST 🧪");
    console.log("=" .repeat(70));
    
    const [deployer, admin, user1, user2, user3, user4] = await ethers.getSigners();
    console.log("Test accounts:");
    console.log(`- Deployer: ${deployer.address}`);
    console.log(`- Admin: ${admin.address}`);
    console.log(`- User1: ${user1.address}`);
    console.log(`- User2: ${user2.address}`);
    console.log(`- User3: ${user3.address}`);
    console.log(`- User4: ${user4.address}`);

    // Test configuration
    const tokenSupply = parseUnits("1000000000", 18); // 1 billion tokens
    const poolInitialAmount = parseUnits("10000000", 18); // 10M tokens for each pool
    const stakeAmount = parseUnits("1000", 18); // 1000 tokens per stake
    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    
    // Lock periods (matching contract constants)
    const LOCK_PERIOD_90 = 90 * 24 * 60 * 60;
    const LOCK_PERIOD_180 = 180 * 24 * 60 * 60;
    const LOCK_PERIOD_365 = 365 * 24 * 60 * 60;

    console.log("\n📋 Test Configuration:");
    console.log(`- Token Supply: ${ethers.formatEther(tokenSupply)}`);
    console.log(`- Pool Initial Amount: ${ethers.formatEther(poolInitialAmount)}`);
    console.log(`- Stake Amount: ${ethers.formatEther(stakeAmount)}`);

    // ========================================
    // PHASE 1: DEPLOY ORIGINAL CONTRACTS
    // ========================================
    console.log("\n🏗️  PHASE 1: DEPLOYING ORIGINAL CONTRACTS");
    console.log("-" .repeat(50));

    // Deploy Token
    console.log("1. Deploying StorageToken...");
    const StorageToken = await ethers.getContractFactory("StorageToken");
    const storageToken = await StorageToken.deploy();
    await storageToken.waitForDeployment();
    const tokenAddress = await storageToken.getAddress();
    console.log(`✅ StorageToken deployed: ${tokenAddress}`);

    // Initialize token
    await storageToken.initialize(deployer.address, admin.address, tokenSupply);
    console.log("✅ StorageToken initialized");

    // Set up token governance (fast-forward time for testing)
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await storageToken.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await storageToken.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    console.log("✅ Token governance configured");

    // Deploy StakingPool contracts
    console.log("2. Deploying StakingPool contracts...");
    const StakingPool = await ethers.getContractFactory("StakingPool");
    const StakingPoolProxy = await ethers.getContractFactory("ERC1967Proxy");
    
    const stakingPoolImplementation = await StakingPool.deploy();
    await stakingPoolImplementation.waitForDeployment();
    const stakingPoolImplAddress = await stakingPoolImplementation.getAddress();
    console.log(`✅ StakingPool implementation: ${stakingPoolImplAddress}`);

    // Deploy stake pool proxy
    const stakePoolInitData = stakingPoolImplementation.interface.encodeFunctionData(
        "initialize", [tokenAddress, deployer.address, admin.address]
    );
    const stakePoolProxy = await StakingPoolProxy.deploy(stakingPoolImplAddress, stakePoolInitData);
    await stakePoolProxy.waitForDeployment();
    const stakePoolAddress = await stakePoolProxy.getAddress();
    console.log(`✅ StakePool proxy: ${stakePoolAddress}`);

    // Deploy reward pool proxy
    const rewardPoolInitData = stakingPoolImplementation.interface.encodeFunctionData(
        "initialize", [tokenAddress, deployer.address, admin.address]
    );
    const rewardPoolProxy = await StakingPoolProxy.deploy(stakingPoolImplAddress, rewardPoolInitData);
    await rewardPoolProxy.waitForDeployment();
    const rewardPoolAddress = await rewardPoolProxy.getAddress();
    console.log(`✅ RewardPool proxy: ${rewardPoolAddress}`);

    // Set up pool governance
    const stakePool = await ethers.getContractAt("StakingPool", stakePoolAddress);
    const rewardPool = await ethers.getContractAt("StakingPool", rewardPoolAddress);
    
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await stakePool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
    await rewardPool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await stakePool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    await rewardPool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    console.log("✅ Pool governance configured");

    // Deploy original StakingEngineLinear
    console.log("3. Deploying original StakingEngineLinear...");
    const StakingEngineLinear = await ethers.getContractFactory("StakingEngineLinear");
    const originalStakingEngine = await upgrades.deployProxy(
        StakingEngineLinear,
        [tokenAddress, stakePoolAddress, rewardPoolAddress, deployer.address, admin.address],
        { kind: 'uups', initializer: 'initialize' }
    );
    await originalStakingEngine.waitForDeployment();
    const originalStakingEngineAddress = await originalStakingEngine.getAddress();
    console.log(`✅ Original StakingEngineLinear: ${originalStakingEngineAddress}`);

    // Configure pools with staking engine
    await stakePool.connect(deployer).setStakingEngine(originalStakingEngineAddress);
    await rewardPool.connect(deployer).setStakingEngine(originalStakingEngineAddress);
    console.log("✅ Pools configured with StakingEngine");

    // Set up token permissions and fund pools
    console.log("4. Setting up token permissions and funding...");
    const storageTokenWithAdmin = storageToken.connect(admin);
    
    // Whitelist reward pool
    const ADD_WHITELIST_TYPE = 5;
    const ZERO_HASH = ethers.ZeroHash;
    const ZERO_ADDRESS = ethers.ZeroAddress;
    
    const whitelistTx = await storageTokenWithAdmin.createProposal(
        ADD_WHITELIST_TYPE, 0, rewardPoolAddress, ZERO_HASH, 0, ZERO_ADDRESS
    );
    const whitelistReceipt = await whitelistTx.wait();
    const proposalCreatedLog = whitelistReceipt.logs.find(log => {
        try {
            const parsed = storageToken.interface.parseLog(log);
            return parsed?.name === "ProposalCreated";
        } catch {
            return false;
        }
    });
    const whitelistProposalId = proposalCreatedLog ? 
        storageToken.interface.parseLog(proposalCreatedLog)?.args[0] : undefined;
    
    await storageToken.connect(deployer).approveProposal(whitelistProposalId);
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await storageTokenWithAdmin.executeProposal(whitelistProposalId);
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    
    // Transfer tokens to reward pool
    await storageTokenWithAdmin.transferFromContract(rewardPoolAddress, poolInitialAmount);
    console.log("✅ Reward pool funded");

    // Whitelist and fund users
    const users = [user1, user2, user3, user4];
    for (const user of users) {
        const userWhitelistTx = await storageTokenWithAdmin.createProposal(
            ADD_WHITELIST_TYPE, 0, user.address, ZERO_HASH, 0, ZERO_ADDRESS
        );
        const userWhitelistReceipt = await userWhitelistTx.wait();
        const userProposalLog = userWhitelistReceipt.logs.find(log => {
            try {
                const parsed = storageToken.interface.parseLog(log);
                return parsed?.name === "ProposalCreated";
            } catch {
                return false;
            }
        });
        const userProposalId = userProposalLog ? 
            storageToken.interface.parseLog(userProposalLog)?.args[0] : undefined;
        
        await storageToken.connect(deployer).approveProposal(userProposalId);
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine", []);
        await storageTokenWithAdmin.executeProposal(userProposalId);
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine", []);
        
        // Fund user
        await storageTokenWithAdmin.transferFromContract(user.address, stakeAmount * 5n);
        console.log(`✅ User ${user.address} whitelisted and funded`);
    }

    console.log("\n✅ PHASE 1 COMPLETE: Original contracts deployed and configured");

    // ========================================
    // PHASE 2: PERFORM STAKING OPERATIONS
    // ========================================
    console.log("\n💰 PHASE 2: PERFORMING STAKING OPERATIONS");
    console.log("-" .repeat(50));

    // Add rewards to the pool first
    console.log("1. Adding rewards to the pool...");
    await originalStakingEngine.connect(admin).addRewardsToPool(poolInitialAmount);
    console.log("✅ Rewards added to pool");

    // Perform various staking operations (matching test patterns)
    console.log("2. Performing staking operations...");

    // User1: Stake 1000 tokens for 90 days without referrer
    await storageToken.connect(user1).approve(originalStakingEngineAddress, stakeAmount);
    await originalStakingEngine.connect(user1).stakeToken(stakeAmount, LOCK_PERIOD_90);
    console.log(`✅ User1 staked ${ethers.formatEther(stakeAmount)} for 90 days (no referrer)`);

    // User2: Stake 1000 tokens for 180 days with User1 as referrer
    await storageToken.connect(user2).approve(originalStakingEngineAddress, stakeAmount);
    await originalStakingEngine.connect(user2).stakeTokenWithReferrer(stakeAmount, LOCK_PERIOD_180, user1.address);
    console.log(`✅ User2 staked ${ethers.formatEther(stakeAmount)} for 180 days (User1 referrer)`);

    // User3: Stake 1000 tokens for 365 days with User2 as referrer
    await storageToken.connect(user3).approve(originalStakingEngineAddress, stakeAmount);
    await originalStakingEngine.connect(user3).stakeTokenWithReferrer(stakeAmount, LOCK_PERIOD_365, user2.address);
    console.log(`✅ User3 staked ${ethers.formatEther(stakeAmount)} for 365 days (User2 referrer)`);

    // User4: Multiple stakes with different periods
    await storageToken.connect(user4).approve(originalStakingEngineAddress, stakeAmount * 3n);
    await originalStakingEngine.connect(user4).stakeToken(stakeAmount, LOCK_PERIOD_90);
    await originalStakingEngine.connect(user4).stakeTokenWithReferrer(stakeAmount, LOCK_PERIOD_180, user1.address);
    await originalStakingEngine.connect(user4).stakeToken(stakeAmount, LOCK_PERIOD_365);
    console.log(`✅ User4 made 3 stakes (90d, 180d with referrer, 365d)`);

    // Advance time to generate some rewards
    console.log("3. Advancing time to generate rewards...");
    await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]); // 30 days
    await ethers.provider.send("evm_mine", []);
    console.log("✅ Advanced 30 days");

    // Claim some rewards
    console.log("4. Claiming some rewards...");
    await originalStakingEngine.connect(user1).claimStakerReward(0);
    console.log("✅ User1 claimed staker rewards");

    await originalStakingEngine.connect(user1).claimReferrerReward(0); // From User2's stake
    console.log("✅ User1 claimed referrer rewards");

    await originalStakingEngine.connect(user2).claimReferrerReward(0); // From User3's stake
    console.log("✅ User2 claimed referrer rewards");

    console.log("\n✅ PHASE 2 COMPLETE: Staking operations performed");

    // ========================================
    // PHASE 3: EXTRACT DATA FROM ORIGINAL
    // ========================================
    console.log("\n🔍 PHASE 3: EXTRACTING DATA FROM ORIGINAL CONTRACT");
    console.log("-" .repeat(50));

    console.log("1. Reading global state variables...");
    const originalTotalStaked = await originalStakingEngine.totalStaked();
    const originalTotalStaked90 = await originalStakingEngine.totalStaked90Days();
    const originalTotalStaked180 = await originalStakingEngine.totalStaked180Days();
    const originalTotalStaked365 = await originalStakingEngine.totalStaked365Days();

    console.log(`- Total Staked: ${ethers.formatEther(originalTotalStaked)}`);
    console.log(`- Total Staked 90 Days: ${ethers.formatEther(originalTotalStaked90)}`);
    console.log(`- Total Staked 180 Days: ${ethers.formatEther(originalTotalStaked180)}`);
    console.log(`- Total Staked 365 Days: ${ethers.formatEther(originalTotalStaked365)}`);

    console.log("2. Reading token balances...");
    const originalStakePoolBalance = await storageToken.balanceOf(stakePoolAddress);
    const originalRewardPoolBalance = await storageToken.balanceOf(rewardPoolAddress);

    console.log(`- StakePool Balance: ${ethers.formatEther(originalStakePoolBalance)}`);
    console.log(`- RewardPool Balance: ${ethers.formatEther(originalRewardPoolBalance)}`);

    console.log("3. Extracting user stakes and referrer data...");
    const migrationData: MigrationData = {
        stakes: {},
        referrers: {},
        totalStaked: originalTotalStaked.toString(),
        totalStaked90Days: originalTotalStaked90.toString(),
        totalStaked180Days: originalTotalStaked180.toString(),
        totalStaked365Days: originalTotalStaked365.toString(),
        allStakerAddresses: [],
        stakingPoolTokenBalance: originalStakePoolBalance.toString(),
        rewardPoolTokenBalance: originalRewardPoolBalance.toString(),
        tokenAddress: tokenAddress
    };

    // Extract stakes for each user
    for (const user of users) {
        const userStakes = await originalStakingEngine.getUserStakes(user.address);
        if (userStakes.length > 0) {
            migrationData.allStakerAddresses.push(user.address);
            migrationData.stakes[user.address] = userStakes.map(stake => ({
                amount: stake.amount.toString(),
                rewardDebt: stake.rewardDebt.toString(),
                lockPeriod: stake.lockPeriod.toString(),
                startTime: stake.startTime.toString(),
                referrer: stake.referrer,
                isActive: stake.isActive
            }));
            console.log(`✅ Extracted ${userStakes.length} stakes for ${user.address}`);
        }

        // Extract referrer data
        try {
            const referrerInfo = await originalStakingEngine.referrers(user.address);
            if (referrerInfo.totalReferred > 0n || referrerInfo.totalRewards > 0n) {
                migrationData.referrers[user.address] = {
                    totalReferred: referrerInfo.totalReferred.toString(),
                    totalRewards: referrerInfo.totalRewards.toString(),
                    lastClaimTime: referrerInfo.lastClaimTime.toString()
                };
                console.log(`✅ Extracted referrer data for ${user.address}`);
            }
        } catch (error) {
            // No referrer data for this user
        }
    }

    // Save migration data
    const migrationDataFile = `migration-data-local-test.json`;
    fs.writeFileSync(
        path.join(__dirname, migrationDataFile),
        JSON.stringify(migrationData, null, 2)
    );
    console.log(`✅ Migration data saved to ${migrationDataFile}`);

    console.log("\n✅ PHASE 3 COMPLETE: Data extraction completed");

    // ========================================
    // PHASE 4: DEPLOY NEW CONTRACTS
    // ========================================
    console.log("\n🚀 PHASE 4: DEPLOYING NEW CONTRACTS");
    console.log("-" .repeat(50));

    console.log("1. Deploying new StakingPool contracts...");

    // Deploy new stake pool proxy
    const newStakePoolProxy = await StakingPoolProxy.deploy(stakingPoolImplAddress, stakePoolInitData);
    await newStakePoolProxy.waitForDeployment();
    const newStakePoolAddress = await newStakePoolProxy.getAddress();
    console.log(`✅ New StakePool: ${newStakePoolAddress}`);

    // Deploy new reward pool proxy
    const newRewardPoolProxy = await StakingPoolProxy.deploy(stakingPoolImplAddress, rewardPoolInitData);
    await newRewardPoolProxy.waitForDeployment();
    const newRewardPoolAddress = await newRewardPoolProxy.getAddress();
    console.log(`✅ New RewardPool: ${newRewardPoolAddress}`);

    // Set up governance for new pools
    const newStakePool = await ethers.getContractAt("StakingPool", newStakePoolAddress);
    const newRewardPool = await ethers.getContractAt("StakingPool", newRewardPoolAddress);

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await newStakePool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
    await newRewardPool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await newStakePool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    await newRewardPool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    console.log("✅ New pool governance configured");

    console.log("2. Deploying new StakingEngineLinearWithMigration...");
    const StakingEngineLinearWithMigration = await ethers.getContractFactory("StakingEngineLinearWithMigration");
    const newStakingEngine = await upgrades.deployProxy(
        StakingEngineLinearWithMigration,
        [tokenAddress, newStakePoolAddress, newRewardPoolAddress, deployer.address, admin.address],
        { kind: 'uups', initializer: 'initialize' }
    );
    await newStakingEngine.waitForDeployment();
    const newStakingEngineAddress = await newStakingEngine.getAddress();
    console.log(`✅ New StakingEngineLinearWithMigration: ${newStakingEngineAddress}`);

    // Configure new pools with new staking engine
    await newStakePool.connect(deployer).setStakingEngine(newStakingEngineAddress);
    await newRewardPool.connect(deployer).setStakingEngine(newStakingEngineAddress);
    console.log("✅ New pools configured with new StakingEngine");

    console.log("3. Transferring funds to new contracts...");

    // Whitelist new reward pool
    const newRewardPoolWhitelistTx = await storageTokenWithAdmin.createProposal(
        ADD_WHITELIST_TYPE, 0, newRewardPoolAddress, ZERO_HASH, 0, ZERO_ADDRESS
    );
    const newRewardPoolWhitelistReceipt = await newRewardPoolWhitelistTx.wait();
    const newRewardPoolProposalLog = newRewardPoolWhitelistReceipt.logs.find(log => {
        try {
            const parsed = storageToken.interface.parseLog(log);
            return parsed?.name === "ProposalCreated";
        } catch {
            return false;
        }
    });
    const newRewardPoolProposalId = newRewardPoolProposalLog ?
        storageToken.interface.parseLog(newRewardPoolProposalLog)?.args[0] : undefined;

    await storageToken.connect(deployer).approveProposal(newRewardPoolProposalId);
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await storageTokenWithAdmin.executeProposal(newRewardPoolProposalId);
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    // Transfer funds from old pools to new pools
    await storageTokenWithAdmin.transferFromContract(newStakePoolAddress, originalStakePoolBalance);
    await storageTokenWithAdmin.transferFromContract(newRewardPoolAddress, originalRewardPoolBalance);
    console.log("✅ Funds transferred to new contracts");

    console.log("\n✅ PHASE 4 COMPLETE: New contracts deployed and funded");

    // ========================================
    // PHASE 5: MIGRATE DATA TO NEW CONTRACTS
    // ========================================
    console.log("\n🔄 PHASE 5: MIGRATING DATA TO NEW CONTRACTS");
    console.log("-" .repeat(50));

    console.log("1. Enabling migration mode...");
    await newStakingEngine.connect(admin).enableMigrationMode();
    console.log("✅ Migration mode enabled");

    console.log("2. Setting global state variables...");
    await newStakingEngine.connect(admin).setTotalStaked(
        migrationData.totalStaked,
        migrationData.totalStaked90Days,
        migrationData.totalStaked180Days,
        migrationData.totalStaked365Days
    );
    console.log("✅ Global state variables set");

    console.log("3. Migrating user stakes...");
    for (const userAddress of migrationData.allStakerAddresses) {
        const userStakes = migrationData.stakes[userAddress];
        console.log(`   Migrating ${userStakes.length} stakes for ${userAddress}...`);

        for (const stake of userStakes) {
            await newStakingEngine.connect(admin).migrateStake(
                userAddress,
                stake.amount,
                stake.rewardDebt,
                stake.lockPeriod,
                stake.startTime,
                stake.referrer,
                stake.isActive
            );
        }
        console.log(`   ✅ Migrated ${userStakes.length} stakes for ${userAddress}`);
    }

    console.log("4. Migrating referrer data...");
    for (const referrerAddress of Object.keys(migrationData.referrers)) {
        const referrerInfo = migrationData.referrers[referrerAddress];
        await newStakingEngine.connect(admin).migrateReferrer(
            referrerAddress,
            referrerInfo.totalReferred || 0,
            referrerInfo.totalRewards || 0,
            referrerInfo.unclaimedRewards || 0,
            referrerInfo.lastClaimTime || 0,
            referrerInfo.referredStakersCount || 0,
            referrerInfo.activeReferredStakersCount || 0,
            referrerInfo.totalActiveStaked || 0,
            referrerInfo.totalUnstaked || 0,
            referrerInfo.totalActiveStaked90Days || 0,
            referrerInfo.totalActiveStaked180Days || 0,
            referrerInfo.totalActiveStaked365Days || 0
        );
        console.log(`   ✅ Migrated referrer data for ${referrerAddress}`);
    }

    console.log("5. Disabling migration mode...");
    await newStakingEngine.connect(admin).disableMigrationMode();
    console.log("✅ Migration mode disabled - normal operations resumed");

    console.log("\n✅ PHASE 5 COMPLETE: Data migration completed");

    // ========================================
    // PHASE 6: COMPREHENSIVE VERIFICATION
    // ========================================
    console.log("\n🔍 PHASE 6: COMPREHENSIVE VERIFICATION");
    console.log("-" .repeat(50));

    let verificationPassed = true;
    const errors: string[] = [];

    console.log("1. Verifying global state variables...");
    const newTotalStaked = await newStakingEngine.totalStaked();
    const newTotalStaked90 = await newStakingEngine.totalStaked90Days();
    const newTotalStaked180 = await newStakingEngine.totalStaked180Days();
    const newTotalStaked365 = await newStakingEngine.totalStaked365Days();

    if (newTotalStaked.toString() !== migrationData.totalStaked) {
        errors.push(`Total staked mismatch: expected ${migrationData.totalStaked}, got ${newTotalStaked.toString()}`);
        verificationPassed = false;
    }
    if (newTotalStaked90.toString() !== migrationData.totalStaked90Days) {
        errors.push(`Total staked 90 days mismatch: expected ${migrationData.totalStaked90Days}, got ${newTotalStaked90.toString()}`);
        verificationPassed = false;
    }
    if (newTotalStaked180.toString() !== migrationData.totalStaked180Days) {
        errors.push(`Total staked 180 days mismatch: expected ${migrationData.totalStaked180Days}, got ${newTotalStaked180.toString()}`);
        verificationPassed = false;
    }
    if (newTotalStaked365.toString() !== migrationData.totalStaked365Days) {
        errors.push(`Total staked 365 days mismatch: expected ${migrationData.totalStaked365Days}, got ${newTotalStaked365.toString()}`);
        verificationPassed = false;
    }

    if (verificationPassed) {
        console.log("✅ Global state variables verified");
    } else {
        console.log("❌ Global state variables verification failed");
    }

    console.log("2. Verifying user stakes...");
    for (const userAddress of migrationData.allStakerAddresses) {
        const expectedStakes = migrationData.stakes[userAddress];
        const actualStakes = await newStakingEngine.getUserStakes(userAddress);

        if (expectedStakes.length !== actualStakes.length) {
            errors.push(`Stake count mismatch for ${userAddress}: expected ${expectedStakes.length}, got ${actualStakes.length}`);
            verificationPassed = false;
            continue;
        }

        for (let i = 0; i < expectedStakes.length; i++) {
            const expected = expectedStakes[i];
            const actual = actualStakes[i];

            if (actual.amount.toString() !== expected.amount ||
                actual.rewardDebt.toString() !== expected.rewardDebt ||
                actual.lockPeriod.toString() !== expected.lockPeriod ||
                actual.startTime.toString() !== expected.startTime ||
                actual.referrer.toLowerCase() !== expected.referrer.toLowerCase() ||
                actual.isActive !== expected.isActive) {

                errors.push(`Stake ${i} mismatch for ${userAddress}`);
                verificationPassed = false;
            }
        }

        if (verificationPassed) {
            console.log(`   ✅ Stakes verified for ${userAddress}`);
        }
    }

    console.log("3. Verifying referrer data...");
    for (const referrerAddress of Object.keys(migrationData.referrers)) {
        const expected = migrationData.referrers[referrerAddress];
        const actual = await newStakingEngine.referrers(referrerAddress);

        if (actual.totalReferred.toString() !== expected.totalReferred ||
            actual.totalRewards.toString() !== expected.totalRewards ||
            actual.lastClaimTime.toString() !== expected.lastClaimTime) {

            errors.push(`Referrer data mismatch for ${referrerAddress}`);
            verificationPassed = false;
        } else {
            console.log(`   ✅ Referrer data verified for ${referrerAddress}`);
        }
    }

    console.log("4. Verifying token balances...");
    const newStakePoolBalance = await storageToken.balanceOf(newStakePoolAddress);
    const newRewardPoolBalance = await storageToken.balanceOf(newRewardPoolAddress);

    if (newStakePoolBalance.toString() !== migrationData.stakingPoolTokenBalance) {
        errors.push(`StakePool balance mismatch: expected ${migrationData.stakingPoolTokenBalance}, got ${newStakePoolBalance.toString()}`);
        verificationPassed = false;
    }
    if (newRewardPoolBalance.toString() !== migrationData.rewardPoolTokenBalance) {
        errors.push(`RewardPool balance mismatch: expected ${migrationData.rewardPoolTokenBalance}, got ${newRewardPoolBalance.toString()}`);
        verificationPassed = false;
    }

    if (verificationPassed) {
        console.log("✅ Token balances verified");
    }

    console.log("\n✅ PHASE 6 COMPLETE: Verification completed");

    // ========================================
    // PHASE 7: FUNCTIONAL TESTING
    // ========================================
    console.log("\n🧪 PHASE 7: FUNCTIONAL TESTING OF NEW CONTRACT");
    console.log("-" .repeat(50));

    console.log("1. Testing new staking operations...");

    // Test new stake on migrated contract
    await storageToken.connect(user1).approve(newStakingEngineAddress, stakeAmount);
    await newStakingEngine.connect(user1).stakeToken(stakeAmount, LOCK_PERIOD_90);
    console.log("✅ New stake created successfully");

    // Test claiming rewards on migrated stakes
    await ethers.provider.send("evm_increaseTime", [10 * 24 * 60 * 60]); // 10 more days
    await ethers.provider.send("evm_mine", []);

    await newStakingEngine.connect(user2).claimStakerReward(0);
    console.log("✅ Claimed rewards on migrated stake");

    // Test referrer rewards on migrated data
    await newStakingEngine.connect(user1).claimReferrerReward(1); // From User4's stake
    console.log("✅ Claimed referrer rewards on migrated data");

    console.log("2. Testing contract state consistency...");
    const finalTotalStaked = await newStakingEngine.totalStaked();
    const expectedFinalTotal = BigInt(migrationData.totalStaked) + stakeAmount;

    if (finalTotalStaked === expectedFinalTotal) {
        console.log("✅ Total staked updated correctly after new stake");
    } else {
        errors.push(`Total staked not updated correctly: expected ${expectedFinalTotal}, got ${finalTotalStaked}`);
        verificationPassed = false;
    }

    console.log("\n✅ PHASE 7 COMPLETE: Functional testing completed");

    // ========================================
    // FINAL SUMMARY
    // ========================================
    console.log("\n📊 FINAL MIGRATION TEST SUMMARY");
    console.log("=" .repeat(70));

    if (verificationPassed) {
        console.log("🎉 MIGRATION TEST SUCCESSFUL! 🎉");
        console.log("\nAll phases completed successfully:");
        console.log("✅ Original contracts deployed and configured");
        console.log("✅ Staking operations performed");
        console.log("✅ Data extracted from original contract");
        console.log("✅ New contracts deployed and funded");
        console.log("✅ Data migrated to new contracts");
        console.log("✅ Comprehensive verification passed");
        console.log("✅ Functional testing passed");

        console.log("\n📋 Contract Addresses:");
        console.log(`- Original StakingEngine: ${originalStakingEngineAddress}`);
        console.log(`- New StakingEngine: ${newStakingEngineAddress}`);
        console.log(`- Token: ${tokenAddress}`);
        console.log(`- Original StakePool: ${stakePoolAddress}`);
        console.log(`- New StakePool: ${newStakePoolAddress}`);
        console.log(`- Original RewardPool: ${rewardPoolAddress}`);
        console.log(`- New RewardPool: ${newRewardPoolAddress}`);

        console.log("\n📈 Migration Statistics:");
        console.log(`- Total Stakers Migrated: ${migrationData.allStakerAddresses.length}`);
        console.log(`- Total Stakes Migrated: ${Object.values(migrationData.stakes).reduce((sum, stakes) => sum + stakes.length, 0)}`);
        console.log(`- Total Referrers Migrated: ${Object.keys(migrationData.referrers).length}`);
        console.log(`- Total Staked Amount: ${ethers.formatEther(migrationData.totalStaked)}`);
        console.log(`- StakePool Balance: ${ethers.formatEther(migrationData.stakingPoolTokenBalance)}`);
        console.log(`- RewardPool Balance: ${ethers.formatEther(migrationData.rewardPoolTokenBalance)}`);

        console.log("\n🚀 READY FOR MAINNET DEPLOYMENT!");
        console.log("The migration scripts have been thoroughly tested and verified.");

    } else {
        console.log("❌ MIGRATION TEST FAILED!");
        console.log("\nErrors encountered:");
        for (const error of errors) {
            console.log(`- ${error}`);
        }
        console.log("\nPlease review and fix the issues before proceeding to mainnet.");
    }

    // Save test results
    const testResults = {
        timestamp: new Date().toISOString(),
        success: verificationPassed,
        errors: errors,
        contracts: {
            original: {
                stakingEngine: originalStakingEngineAddress,
                stakePool: stakePoolAddress,
                rewardPool: rewardPoolAddress
            },
            new: {
                stakingEngine: newStakingEngineAddress,
                stakePool: newStakePoolAddress,
                rewardPool: newRewardPoolAddress
            },
            token: tokenAddress
        },
        migrationStats: {
            totalStakers: migrationData.allStakerAddresses.length,
            totalStakes: Object.values(migrationData.stakes).reduce((sum, stakes) => sum + stakes.length, 0),
            totalReferrers: Object.keys(migrationData.referrers).length,
            totalStaked: migrationData.totalStaked,
            stakingPoolBalance: migrationData.stakingPoolTokenBalance,
            rewardPoolBalance: migrationData.rewardPoolTokenBalance
        }
    };

    const testResultsFile = `migration-test-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(
        path.join(__dirname, testResultsFile),
        JSON.stringify(testResults, null, 2)
    );
    console.log(`\n📁 Test results saved to: ${testResultsFile}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Test failed:", error);
        process.exit(1);
    });

// Usage: npx hardhat run scripts/StakingEngineLinear/deployAndMigrateLocalStakingEngine.ts --network localhost
