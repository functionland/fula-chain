// Deploy new StakingEngineLinearWithMigration and StakingPool contracts with migration data
// This script deploys fresh contracts with migration capabilities for emergency migration

import { ethers, upgrades } from "hardhat";
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
}

interface MigrationData {
    stakes: { [address: string]: StakeInfo[] };
    referrers: { [address: string]: ReferrerInfo };
    totalStaked: string;
    totalStaked90Days: string;
    totalStaked180Days: string;
    totalStaked365Days: string;
    allStakerAddresses: string[];
    stakerAddressesByPeriod: { [period: string]: string[] };
    stakingPoolTokenBalance: string;
    rewardPoolTokenBalance: string;
    oldStakingEngine: string;
    oldStakePool: string;
    oldRewardPool: string;
    tokenAddress: string;
}

async function main() {
    console.log("🚀 EMERGENCY DEPLOYMENT WITH MIGRATION 🚀");
    console.log("Deploying new contracts and migrating data...\n");

    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);

    // Load migration data
    let migrationDataFile = process.env.MIGRATION_DATA_FILE;
    if (!migrationDataFile) {
        throw new Error("MIGRATION_DATA_FILE environment variable not set");
    }

    // Remove surrounding quotes if present (Windows issue)
    migrationDataFile = migrationDataFile.replace(/^["']|["']$/g, '');

    const migrationDataPath = path.join(__dirname, migrationDataFile);
    if (!fs.existsSync(migrationDataPath)) {
        throw new Error(`Migration data file not found: ${migrationDataPath}`);
    }

    console.log(`📁 Loading migration data from: ${migrationDataFile}`);
    const migrationData: MigrationData = JSON.parse(fs.readFileSync(migrationDataPath, 'utf8'));

    // Environment variables (with quote stripping for Windows compatibility)
    let initialOwner = process.env.INITIAL_OWNER || deployer.address;
    let initialAdmin = process.env.INITIAL_ADMIN || deployer.address;
    
    // Remove surrounding quotes if present (Windows issue)
    initialOwner = initialOwner.replace(/^["']|["']$/g, '');
    initialAdmin = initialAdmin.replace(/^["']|["']$/g, '');

    console.log("\n📋 Configuration:");
    console.log(`Initial Owner: ${initialOwner}`);
    console.log(`Initial Admin: ${initialAdmin}`);
    console.log(`Token Address: ${migrationData.tokenAddress}`);
    console.log(`Migrating ${migrationData.allStakerAddresses.length} stakers`);

    // Get token contract
    const token = await ethers.getContractAt("IERC20", migrationData.tokenAddress);

    // Decide whether to deploy new pools or use existing ones
    const deployPools = ((process.env.DEPLOY_POOLS || "").trim().toLowerCase() === "true");
    let stakePoolAddress: string;
    let rewardPoolAddress: string = ""; // Initialize to prevent lint errors

    if (deployPools) {
        console.log("\n🏗️  Step 1: Deploying new StakingPool proxies (stake and reward)...");

        // Deploy StakingPool implementation using upgrades plugin
        const StakingPool = await ethers.getContractFactory("StakingPool");
        console.log("🛠️  Deploying StakingPool implementation...");
        const stakingPoolImplementation = await upgrades.deployImplementation(StakingPool);
        const stakingPoolImplAddress = stakingPoolImplementation.toString();
        console.log("✅ StakingPool implementation deployed:", stakingPoolImplAddress);

        // Encode initialize(token, owner, admin)
        const initData = StakingPool.interface.encodeFunctionData(
            "initialize",
            [migrationData.tokenAddress, initialOwner, initialAdmin]
        );

        // Deploy proxies for stake and reward pools
        const Proxy = await ethers.getContractFactory("ERC1967Proxy");

        console.log("Deploying Stake Pool proxy...");
        let currentNonce = await deployer.getNonce();
        const stakePoolProxy = await Proxy.deploy(stakingPoolImplAddress, initData, {
            nonce: currentNonce,
            gasLimit: 500000
        });
        await stakePoolProxy.waitForDeployment();
        stakePoolAddress = await stakePoolProxy.getAddress();
        console.log("✅ Stake Pool proxy deployed at:", stakePoolAddress);

        // Wait a bit to ensure transaction is fully processed
        console.log("⏳ Waiting 5 seconds before next deployment...");
        await new Promise(resolve => setTimeout(resolve, 5000));

        console.log("Deploying Reward Pool proxy...");
        
        // Retry logic for reward pool deployment
        let rewardPoolProxy;
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`🔄 Deployment attempt ${attempts}/${maxAttempts}...`);
                
                currentNonce = await deployer.getNonce();
                const feeData = await ethers.provider.getFeeData();
                const gasPrice = feeData.gasPrice ? feeData.gasPrice * (150n + BigInt(attempts * 25)) / 100n : undefined;
                
                rewardPoolProxy = await Proxy.deploy(stakingPoolImplAddress, initData, {
                    nonce: currentNonce,
                    gasLimit: 500000,
                    gasPrice: gasPrice
                });
                
                await rewardPoolProxy.waitForDeployment();
                rewardPoolAddress = await rewardPoolProxy.getAddress();
                console.log("✅ Reward Pool proxy deployed at:", rewardPoolAddress);
                break; // Success, exit loop
                
            } catch (error: any) {
                console.log(`⚠️  Attempt ${attempts} failed:`, error.message);
                
                if (attempts >= maxAttempts) {
                    throw error; // Re-throw if all attempts failed
                }
                
                // Wait before retry (exponential backoff)
                const waitTime = 10000 * attempts; // 10s, 20s, 30s
                console.log(`⏳ Waiting ${waitTime/1000}s before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

    } else {
        console.log("\n🏗️  Step 1: Using existing StakingPool contracts...");
        // Use existing pool addresses (env overrides or defaults)
        stakePoolAddress = process.env.STAKE_POOL_ADDRESS || "0x55A95011136c511749FD68e9f40601670Bd866D4";
        rewardPoolAddress = process.env.REWARD_POOL_ADDRESS || "0x2D91737D21106598d0288afD04E5a284780d8Ffd";
        console.log("✅ Using existing StakePool:", stakePoolAddress);
        console.log("✅ Using existing RewardPool:", rewardPoolAddress);
    }

    console.log("\n🏗️  Step 2: Deploying new StakingEngineLinearWithMigration...");

    // Deploy StakingEngineLinearWithMigration as a UUPS proxy (using working pattern)
    console.log("\n🏠 Deploying StakingEngineLinearWithMigration as a UUPS proxy...");
    const StakingEngineLinearWithMigration = await ethers.getContractFactory("StakingEngineLinearWithMigration");
    const stakingEngine = await upgrades.deployProxy(
        StakingEngineLinearWithMigration,
        [
            migrationData.tokenAddress,
            stakePoolAddress,
            rewardPoolAddress,
            initialOwner,
            initialAdmin
        ],
        { kind: 'uups', initializer: 'initialize' }
    );

    await stakingEngine.waitForDeployment();
    const stakingEngineAddress = await stakingEngine.getAddress();
    console.log("✅ New StakingEngineLinearWithMigration deployed to:", stakingEngineAddress);

    // Set up permissions (skip if already configured)
    console.log("\n🔐 Step 3: Checking permissions...");
    const stakePool = await ethers.getContractAt("StakingPool", stakePoolAddress);
    const rewardPool = await ethers.getContractAt("StakingPool", rewardPoolAddress);

    try {
        // Check if staking engine is already set
        const currentStakePoolEngine = await stakePool.stakingEngine();
        console.log(`📝 Current StakePool engine: ${currentStakePoolEngine}`);
        
        if (currentStakePoolEngine === "0x0000000000000000000000000000000000000000") {
            await stakePool.connect(deployer).setStakingEngine(stakingEngineAddress);
            console.log("✅ StakePool configured with new StakingEngine");
        } else {
            console.log("ℹ️ StakePool already has a staking engine configured - skipping");
        }
    } catch (error: any) {
        console.log("ℹ️ StakePool permission setup skipped:", error.message);
    }

    try {
        const currentRewardPoolEngine = await rewardPool.stakingEngine();
        console.log(`📝 Current RewardPool engine: ${currentRewardPoolEngine}`);
        
        if (currentRewardPoolEngine === "0x0000000000000000000000000000000000000000") {
            await rewardPool.connect(deployer).setStakingEngine(stakingEngineAddress);
            console.log("✅ RewardPool configured with new StakingEngine");
        } else {
            console.log("ℹ️ RewardPool already has a staking engine configured - skipping");
        }
    } catch (error: any) {
        console.log("ℹ️ RewardPool permission setup skipped:", error.message);
    }

    console.log("\n💰 Step 4: Transferring funds from old contracts...");
    
    // Get old contracts
    const oldStakePool = await ethers.getContractAt("StakingPool", migrationData.oldStakePool);
    const oldRewardPool = await ethers.getContractAt("StakingPool", migrationData.oldRewardPool);

    // Check if we have admin access to transfer funds
    try {
        const stakePoolBalance = ethers.parseEther(migrationData.stakingPoolTokenBalance);
        const rewardPoolBalance = ethers.parseEther(migrationData.rewardPoolTokenBalance);

        console.log(`Attempting to transfer ${ethers.formatEther(stakePoolBalance)} from old StakePool...`);
        console.log(`Attempting to transfer ${ethers.formatEther(rewardPoolBalance)} from old RewardPool...`);

        // Note: These transfers will only work if the deployer has admin access
        // If not, you'll need to do this manually through governance or admin functions
        
        console.log("⚠️  Manual fund transfer required:");
        console.log(`   Transfer ${ethers.formatEther(stakePoolBalance)} tokens from ${migrationData.oldStakePool} to ${stakePoolAddress}`);
        console.log(`   Transfer ${ethers.formatEther(rewardPoolBalance)} tokens from ${migrationData.oldRewardPool} to ${rewardPoolAddress}`);
        
    } catch (error) {
        console.log("⚠️  Could not automatically transfer funds. Manual transfer required.");
    }

    console.log("\n📊 Step 5: Summary of new deployment...");
    console.log("New Contract Addresses:");
    console.log(`   StakingEngineLinearWithMigration: ${stakingEngineAddress}`);
    console.log(`   StakePool: ${stakePoolAddress}`);
    console.log(`   RewardPool: ${rewardPoolAddress}`);

    // Save deployment info
    const deploymentInfo = {
        timestamp: new Date().toISOString(),
        network: (await ethers.provider.getNetwork()).name,
        deployer: deployer.address,
        contracts: {
            stakingEngineLinearWithMigration: stakingEngineAddress,
            stakePool: stakePoolAddress,
            rewardPool: rewardPoolAddress
        },
        migrationData: {
            totalStakers: migrationData.allStakerAddresses.length,
            totalStaked: migrationData.totalStaked,
            stakingPoolBalance: migrationData.stakingPoolTokenBalance,
            rewardPoolBalance: migrationData.rewardPoolTokenBalance
        },
        oldContracts: {
            stakingEngine: migrationData.oldStakingEngine,
            stakePool: migrationData.oldStakePool,
            rewardPool: migrationData.oldRewardPool
        }
    };

    const deploymentFile = `deployment-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(__dirname, deploymentFile), JSON.stringify(deploymentInfo, null, 2));
    
    console.log(`\n📁 Deployment info saved to: ${deploymentFile}`);
    
    console.log("\n✅ Emergency deployment complete!");
    console.log("\n🚨 CRITICAL NEXT STEPS:");
    console.log("1. ⚠️  IMMEDIATELY transfer all funds from old contracts to new ones");
    console.log("2. 🔄 Run the data migration script to restore user stakes");
    console.log("3. 🔒 Pause or disable the old contracts if possible");
    console.log("4. 📢 Notify users about the new contract addresses");
    console.log("5. ✅ Verify all contracts on block explorer");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });

// Usage: 
// MIGRATION_DATA_FILE=migration-data-2024-01-01T12-00-00-000Z.json \
// INITIAL_OWNER=0x... \
// INITIAL_ADMIN=0x... \
// npx hardhat run scripts/StakingEngineLinear/deployWithMigration.ts --network base
