// Migrate stake data to new StakingEngineLinearWithMigration contract
// This script restores all user stakes and referrer data to the new contract using migration functions

import { ethers } from "hardhat";
import { vars } from "hardhat/config";
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
    stakingPoolTokenBalance: string;
    rewardPoolTokenBalance: string;
    tokenAddress: string;
}

interface DeploymentInfo {
    contracts: {
        stakingEngineLinearWithMigration: string;
        stakePool: string;
        rewardPool: string;
    };
}

async function main() {
    console.log("🔄 STAKE DATA MIGRATION SCRIPT 🔄");
    console.log("Migrating user stakes to new contract...\n");

    const signers = await ethers.getSigners();
    const deployer = signers[0]; // Owner account
    let admin = signers[1] || deployer; // Default admin (fallback to deployer)

    // Prefer ADMIN_PK if provided, to avoid signer index ambiguity across networks
    let rawAdminPk: string | undefined;
    
    try {
        // Use vars from hardhat/config (same as hardhat.config.ts)
        if (vars.has("ADMIN_PK")) {
            rawAdminPk = vars.get("ADMIN_PK");
            console.log("Debug: vars.get('ADMIN_PK') returned:", rawAdminPk ? `[${rawAdminPk.length} chars]` : "undefined/empty");
        } else {
            console.log("Debug: vars.has('ADMIN_PK') returned false");
        }
        // Also try process.env as fallback
        if (!rawAdminPk && process.env.ADMIN_PK) {
            rawAdminPk = process.env.ADMIN_PK;
            console.log("Debug: process.env.ADMIN_PK returned:", rawAdminPk ? `[${rawAdminPk.length} chars]` : "undefined/empty");
        }
    } catch (e) {
        console.log("Debug: Exception accessing Hardhat vars:", e);
        // Fallback to environment variable if Hardhat vars not available
        rawAdminPk = process.env.ADMIN_PK;
    }
    const adminPk = rawAdminPk ? rawAdminPk.replace(/^["']|["']$/g, "").replace(/^0x/, "0x") : undefined;
    let adminSource = "fallback";
    if (adminPk && adminPk.length > 10) {
        console.log("ADMIN_PK detected: yes (length:", adminPk.length, ")");
        try {
            admin = new (ethers as any).Wallet(adminPk, ethers.provider);
            adminSource = "ADMIN_PK";
        } catch (e) {
            console.warn(" Failed to construct admin Wallet from ADMIN_PK, falling back to signers[1]/deployer");
        }
    } else {
        console.log("ADMIN_PK detected: no (using signers[1]/deployer fallback)");
    }

    console.log("Deployer account:", deployer.address);
    console.log("Admin account:", admin.address);
    console.log("Using admin account for migration operations (source:", adminSource, ")");

    // Load migration data
    let migrationDataFile = process.env.MIGRATION_DATA_FILE;
    let deploymentInfoFile = process.env.DEPLOYMENT_INFO_FILE;
    
    if (!migrationDataFile || !deploymentInfoFile) {
        throw new Error("MIGRATION_DATA_FILE and DEPLOYMENT_INFO_FILE environment variables required");
    }

    // Remove surrounding quotes if present (Windows issue)
    migrationDataFile = migrationDataFile.replace(/^["']|["']$/g, '');
    deploymentInfoFile = deploymentInfoFile.replace(/^["']|["']$/g, '');

    console.log(`📁 Loading migration data from: ${migrationDataFile}`);
    const migrationData: MigrationData = JSON.parse(
        fs.readFileSync(path.join(__dirname, migrationDataFile), 'utf8')
    );

    console.log(`📁 Loading deployment info from: ${deploymentInfoFile}`);
    const deploymentInfo: DeploymentInfo = JSON.parse(
        fs.readFileSync(path.join(__dirname, deploymentInfoFile), 'utf8')
    );

    // Get new contract instances
    const newStakingEngine = await ethers.getContractAt(
        "StakingEngineLinearWithMigration",
        deploymentInfo.contracts.stakingEngineLinearWithMigration
    );

    const token = await ethers.getContractAt("IERC20", migrationData.tokenAddress);

    console.log("\n📋 Migration Summary:");
    console.log(`New StakingEngineWithMigration: ${deploymentInfo.contracts.stakingEngineLinearWithMigration}`);
    console.log(`Total Stakers to migrate: ${migrationData.allStakerAddresses.length}`);
    console.log(`Total Stakes: ${Object.values(migrationData.stakes).reduce((sum, stakes) => sum + stakes.length, 0)}`);

    // Use admin account for all migration operations (admin has ADMIN_ROLE)
    console.log(`\nUsing admin account for migration: ${admin.address}`);

    // Enable migration mode
    // Preflight checks to surface the exact guard that might revert on certain networks (e.g. SKALE)
    const ADMIN_ROLE = (ethers as any).id ? (ethers as any).id("ADMIN_ROLE") : (ethers as any).keccak256((ethers as any).toUtf8Bytes("ADMIN_ROLE"));
    console.log("\n🔎 Preflight checks before enabling migration mode:");
    try {
        const paused = await newStakingEngine.paused();
        const migrationMode = await newStakingEngine.migrationMode();
        const migrationModeEverEnabled = await newStakingEngine.migrationModeEverEnabled();
        const hasAdmin = await newStakingEngine.hasRole(ADMIN_ROLE, admin.address);
        // Some providers may not support .target; fall back to .address
        const contractAddress = (newStakingEngine as any).target || (newStakingEngine as any).address;
        console.log(" Contract:", contractAddress);
        console.log(" Using admin:", admin.address);
        console.log(" paused:", paused);
        console.log(" migrationMode:", migrationMode);
        console.log(" migrationModeEverEnabled:", migrationModeEverEnabled);
        console.log(" has ADMIN_ROLE:", hasAdmin);
    } catch (e) {
        console.warn("⚠️ Preflight checks failed to read some state:", e);
    }

    // Dry-run to detect revert reason early (gas estimation also calls, but we want explicit log)
    console.log("\n🔒 Enabling migration mode...");
    try {
        const adminConn: any = newStakingEngine.connect(admin as any);
        if (adminConn.callStatic && adminConn.callStatic.enableMigrationMode) {
            await adminConn.callStatic.enableMigrationMode();
        } else if (adminConn.enableMigrationMode && adminConn.enableMigrationMode.staticCall) {
            await adminConn.enableMigrationMode.staticCall();
        } else {
            // Fallback to provider.call via populated transaction
            const tx = await adminConn.enableMigrationMode.populateTransaction();
            await (ethers as any).provider.call({ to: (adminConn as any).target || (adminConn as any).address, data: tx.data });
        }
        console.log(" callStatic enableMigrationMode: OK (would succeed)");
    } catch (e) {
        console.error(" callStatic enableMigrationMode: WOULD REVERT", e);
        throw e;
    }

    await newStakingEngine.connect(admin).enableMigrationMode();
    console.log("✅ Migration mode enabled - normal operations paused");

    // Batch size for processing
    const BATCH_SIZE = 10;
    let processedStakers = 0;
    let processedStakes = 0;

    console.log("\n🔄 Step 1: Migrating global state...");
    
    try {
        console.log("Setting total staked amounts...");
        console.log(`Total Staked: ${ethers.formatEther(migrationData.totalStaked)}`);
        console.log(`Total Staked 90 Days: ${ethers.formatEther(migrationData.totalStaked90Days)}`);
        console.log(`Total Staked 180 Days: ${ethers.formatEther(migrationData.totalStaked180Days)}`);
        console.log(`Total Staked 365 Days: ${ethers.formatEther(migrationData.totalStaked365Days)}`);

        // Note: Global state (totalStaked, totalStaked90Days, etc.) is automatically updated
        // during the migration process through migrateStake and migrateMultipleStakes functions.
        // No manual global state setting is required.
        
        console.log("✅ Global state will be updated automatically during stake migration");
    } catch (error) {
        console.error("❌ Error migrating global state:", error);
        throw error;
    }

    console.log("\n🔄 Step 2: Migrating individual stakes...");

    // Process stakers in batches
    const stakerAddresses = Object.keys(migrationData.stakes);
    
    for (let i = 0; i < stakerAddresses.length; i += BATCH_SIZE) {
        const batch = stakerAddresses.slice(i, i + BATCH_SIZE);
        
        console.log(`\n📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(stakerAddresses.length / BATCH_SIZE)}`);
        
        for (const stakerAddress of batch) {
            const stakes = migrationData.stakes[stakerAddress];
            
            console.log(`   👤 Migrating ${stakes.length} stakes for ${stakerAddress}`);
            
            try {
                // Check if user is already migrated
                const isAlreadyMigrated = await newStakingEngine.migratedUsers(stakerAddress);
                if (isAlreadyMigrated) {
                    console.log(`      ⚠️  User ${stakerAddress} already migrated, skipping...`);
                    processedStakes += stakes.length;
                    continue;
                }
                
                // Prepare arrays for migrateMultipleStakes
                const amounts = stakes.map(s => s.amount);
                const rewardDebts = stakes.map(s => s.rewardDebt);
                const lockPeriods = stakes.map(s => s.lockPeriod);
                const startTimes = stakes.map(s => s.startTime);
                const referrers = stakes.map(s => s.referrer);
                const isActiveFlags = stakes.map(s => s.isActive);
                
                // Log individual stakes for visibility and validation
                stakes.forEach((stake, index) => {
                    console.log(`      💰 Stake ${index + 1}: ${ethers.formatEther(stake.amount)} tokens, ${Number(stake.lockPeriod) / (24 * 60 * 60)} days`);
                    console.log(`        - Amount: ${stake.amount}`);
                    console.log(`        - RewardDebt: ${stake.rewardDebt}`);
                    console.log(`        - LockPeriod: ${stake.lockPeriod}`);
                    console.log(`        - StartTime: ${stake.startTime} (${new Date(Number(stake.startTime) * 1000).toISOString()})`);
                    console.log(`        - Referrer: ${stake.referrer}`);
                    console.log(`        - IsActive: ${stake.isActive}`);
                });
                
                // Get contract lock period constants for validation
                const LOCK_PERIOD_1 = await newStakingEngine.LOCK_PERIOD_1();
                const LOCK_PERIOD_2 = await newStakingEngine.LOCK_PERIOD_2();
                const LOCK_PERIOD_3 = await newStakingEngine.LOCK_PERIOD_3();
                
                console.log(`      🔍 Contract lock periods: ${LOCK_PERIOD_1}, ${LOCK_PERIOD_2}, ${LOCK_PERIOD_3}`);
                
                // Validate all data before migration
                let hasInvalidData = false;
                for (let i = 0; i < lockPeriods.length; i++) {
                    const lockPeriod = lockPeriods[i];
                    const amount = amounts[i];
                    const startTime = startTimes[i];
                    const referrer = referrers[i];
                    
                    // Validate lock period
                    if (lockPeriod !== LOCK_PERIOD_1.toString() && 
                        lockPeriod !== LOCK_PERIOD_2.toString() && 
                        lockPeriod !== LOCK_PERIOD_3.toString()) {
                        console.log(`      ❌ Invalid lock period: ${lockPeriod} (expected: ${LOCK_PERIOD_1}, ${LOCK_PERIOD_2}, or ${LOCK_PERIOD_3})`);
                        hasInvalidData = true;
                    }
                    
                    // Validate amount
                    if (!amount || amount === '0') {
                        console.log(`      ❌ Invalid amount: ${amount}`);
                        hasInvalidData = true;
                    }
                    
                    // Validate start time (should be in the past)
                    const currentTime = Math.floor(Date.now() / 1000);
                    if (!startTime || Number(startTime) > currentTime) {
                        console.log(`      ❌ Invalid start time: ${startTime} (current: ${currentTime})`);
                        hasInvalidData = true;
                    }
                    
                    // Validate referrer (should be valid address or zero address)
                    if (!referrer || (referrer !== ethers.ZeroAddress && !ethers.isAddress(referrer))) {
                        console.log(`      ❌ Invalid referrer: ${referrer}`);
                        hasInvalidData = true;
                    }
                }
                
                if (hasInvalidData) {
                    console.log(`      ⚠️  Skipping user ${stakerAddress} due to invalid data`);
                    continue;
                }
                
                console.log(`      🚀 Calling migrateMultipleStakes for ${stakerAddress}...`);
                
                // Additional debugging for problematic user
                if (stakerAddress === '0x5B91dDA147fEfAFed5130702821B70d2f31e878d') {
                    console.log(`      🔍 DEBUGGING PROBLEMATIC USER:`);
                    try {
                        // Check if user has any existing stakes in new contract
                        const userStakes = await newStakingEngine.stakes(stakerAddress, 0).catch(() => null);
                        console.log(`        - Existing stakes in new contract: ${userStakes ? 'YES' : 'NO'}`);
                        
                        // Check migration mode
                        const migrationModeActive = await newStakingEngine.migrationMode();
                        console.log(`        - Migration mode active: ${migrationModeActive}`);
                        
                        // Check admin role using ProposalTypes
                        const adminRoleHash = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
                        const hasAdminRole = await newStakingEngine.hasRole(adminRoleHash, admin.address);
                        console.log(`        - Admin has ADMIN_ROLE: ${hasAdminRole}`);
                        
                        // Try to estimate gas
                        const gasEstimate = await newStakingEngine.connect(admin).migrateMultipleStakes.estimateGas(
                            stakerAddress,
                            amounts,
                            rewardDebts,
                            lockPeriods,
                            startTimes,
                            referrers,
                            isActiveFlags
                        );
                        console.log(`        - Gas estimate: ${gasEstimate}`);
                    } catch (debugError: any) {
                        console.log(`        - Debug error: ${debugError.message || debugError}`);
                    }
                }
                
                // Preflight: try a static call to surface revert reasons early
                try {
                    await newStakingEngine.connect(admin).migrateMultipleStakes.staticCall(
                        stakerAddress,
                        amounts,
                        rewardDebts,
                        lockPeriods,
                        startTimes,
                        referrers,
                        isActiveFlags
                    );
                } catch (preflightError: any) {
                    console.error(`      ❌ Preflight revert for ${stakerAddress}:`, preflightError?.reason || preflightError?.shortMessage || preflightError?.message || preflightError);
                    throw preflightError;
                }

                // Estimate gas and add a 25% safety buffer to avoid underestimation
                const estimatedGas = await newStakingEngine.connect(admin).migrateMultipleStakes.estimateGas(
                    stakerAddress,
                    amounts,
                    rewardDebts,
                    lockPeriods,
                    startTimes,
                    referrers,
                    isActiveFlags
                );
                const bufferedGas = (estimatedGas * 125n) / 100n; // +25%
                console.log(`      ⛽ Estimated gas: ${estimatedGas.toString()} | Using gas limit: ${bufferedGas.toString()}`);

                // Send transaction with buffered gas limit
                const tx = await newStakingEngine.connect(admin).migrateMultipleStakes(
                    stakerAddress,
                    amounts,
                    rewardDebts,
                    lockPeriods,
                    startTimes,
                    referrers,
                    isActiveFlags,
                    { gasLimit: bufferedGas }
                );
                
                // Wait for transaction confirmation
                const receipt = await tx.wait();
                if (receipt) {
                    console.log(`      ✅ Transaction confirmed: ${receipt.hash}`);
                    console.log(`      ⛽ Gas used: ${receipt.gasUsed}`);
                    console.log(`      📊 Transaction status: ${receipt.status === 1 ? 'SUCCESS' : 'FAILED'}`);
                    
                    if (receipt.status !== 1) {
                        throw new Error(`Transaction failed with status: ${receipt.status}`);
                    }
                } else {
                    throw new Error("Transaction receipt is null");
                }
                
                // Verify user is now marked as migrated
                const isMigrated = await newStakingEngine.migratedUsers(stakerAddress);
                if (isMigrated) {
                    processedStakes += stakes.length;
                    console.log(`      ✅ VERIFIED: User ${stakerAddress} marked as migrated with ${stakes.length} stakes`);
                } else {
                    console.log(`      ❌ FAILED: User ${stakerAddress} not marked as migrated`);
                    throw new Error(`User not marked as migrated after transaction`);
                }
                
            } catch (error) {
                console.error(`      ❌ Error migrating stakes for ${stakerAddress}:`, error);
            }
            
            processedStakers++;
        }
        
        // Small delay between batches to avoid overwhelming the network
        await new Promise(resolve => setTimeout(resolve, 1000));
    }


    
    try {
        const newTotalStaked = await newStakingEngine.totalStaked();
        console.log(`New contract total staked: ${ethers.formatEther(newTotalStaked)}`);
        console.log(`Expected total staked: ${ethers.formatEther(migrationData.totalStaked)}`);
        
        if (newTotalStaked.toString() === migrationData.totalStaked) {
            console.log("✅ Total staked amounts match!");
        } else {
            console.log("⚠️  Total staked amounts don't match - manual verification needed");
        }
    } catch (error) {
        console.log("⚠️  Could not verify total staked - manual verification needed");
    }

    console.log("\n🔄 Step 3: Analyzing referrer data in migrated stakes...");
    
    // Analyze referrer data from migrated stakes
    const referrerMap = new Map<string, Set<number>>();
    let totalStakesWithReferrers = 0;
    let analyzedStakes = 0;

    console.log("🔍 Reading stake data from contract to verify referrer preservation...");
    for (const staker of migrationData.allStakerAddresses) {
        try {
            const stakes = await newStakingEngine.getStakes(staker);
            analyzedStakes += stakes.length;
            
            for (const stake of stakes) {
                if (stake.referrer && stake.referrer !== "0x0000000000000000000000000000000000000000") {
                    if (!referrerMap.has(stake.referrer)) {
                        referrerMap.set(stake.referrer, new Set());
                    }
                    referrerMap.get(stake.referrer)!.add(Number(stake.lockPeriod));
                    totalStakesWithReferrers++;
                }
            }
        } catch (error: any) {
            console.log(`⚠️  Could not read stakes for ${staker}: ${error.message}`);
        }
    }

    console.log("\n📊 Migration Summary:");
    console.log(`✅ Processed Stakers: ${processedStakers}/${migrationData.allStakerAddresses.length}`);
    console.log(`✅ Processed Stakes: ${processedStakes}`);
    console.log(`✅ Analyzed Stakes in Contract: ${analyzedStakes}`);
    console.log(`✅ Stakes with Referrers: ${totalStakesWithReferrers}`);
    console.log(`✅ Unique Referrers Found: ${referrerMap.size}`);
    
    if (referrerMap.size > 0) {
        console.log("\n📄 Referrer Details:");
        let index = 1;
        for (const [referrer, lockPeriods] of referrerMap.entries()) {
            console.log(`  ${index}. ${referrer} (${lockPeriods.size} lock periods: ${Array.from(lockPeriods).join(", ")})`);
            index++;
        }
    }

    // Verify migration
    console.log("\n🔍 Step 4: Verifying migration...");
        
    try {
        const newTotalStaked = await newStakingEngine.totalStaked();
        console.log(`New contract total staked: ${ethers.formatEther(newTotalStaked)}`);
        console.log(`Expected total staked: ${ethers.formatEther(migrationData.totalStaked)}`);
        
        if (newTotalStaked.toString() === migrationData.totalStaked) {
            console.log("✅ Total staked amounts match!");
        } else {
            console.log("⚠️  Total staked amounts don't match - manual verification needed");
        }
    } catch (error) {
        console.log("⚠️  Could not verify total staked - manual verification needed");
    }

    // Disable migration mode and resume normal operations
    console.log("\n🔓 Disabling migration mode...");
        
    // Get fresh nonce to prevent underpriced transaction error (use admin account)
    const currentNonce = await admin.getNonce();
    console.log(`🔢 Using admin nonce: ${currentNonce}`);
        
    try {
        const tx = await newStakingEngine.connect(admin).disableMigrationMode({ 
            nonce: currentNonce,
            gasLimit: 200000 // Explicit gas limit for simple state change
        });
        await tx.wait();
        console.log("✅ Migration mode disabled - normal operations resumed");
    } catch (error: any) {
        console.log("⚠️  Warning: Could not disable migration mode:", error.message);
        console.log("ℹ️  Migration completed successfully, but migration mode may still be active");
        console.log("ℹ️  You can manually disable it later if needed");
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Migration failed:", error);
        process.exit(1);
    });

// Usage:
// MIGRATION_DATA_FILE=migration-data-2024-01-01T12-00-00-000Z.json \
// DEPLOYMENT_INFO_FILE=deployment-2024-01-01T12-30-00-000Z.json \
// npx hardhat run scripts/StakingEngineLinear/migrateStakeData.ts --network base
