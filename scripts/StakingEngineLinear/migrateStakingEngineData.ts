import { ethers } from "hardhat";
import { StakingEngineLinearWithMigration, StakingEngineLinear } from "../../typechain-types";

interface StakeData {
    user: string;
    amount: bigint;
    rewardDebt: bigint;
    lockPeriod: bigint;
    startTime: bigint;
    referrer: string;
    isActive: boolean;
}

interface ReferrerData {
    referrer: string;
    totalReferred: bigint;
    totalReferrerRewards: bigint;
    unclaimedRewards: bigint;
    lastClaimTime: bigint;
    referredStakersCount: bigint;
    activeReferredStakersCount: bigint;
    totalActiveStaked: bigint;
    totalUnstaked: bigint;
    totalActiveStaked90Days: bigint;
    totalActiveStaked180Days: bigint;
    totalActiveStaked365Days: bigint;
}

async function main() {
    console.log("Starting StakingEngine migration...");

    // Get contract addresses from environment
    const oldContractAddress = process.env.OLD_STAKING_ENGINE_ADDRESS;
    const newContractAddress = process.env.NEW_STAKING_ENGINE_ADDRESS;

    if (!oldContractAddress || !newContractAddress) {
        throw new Error("OLD_STAKING_ENGINE_ADDRESS and NEW_STAKING_ENGINE_ADDRESS must be set");
    }

    console.log("Old Contract:", oldContractAddress);
    console.log("New Contract:", newContractAddress);

    // Get signers
    const [deployer] = await ethers.getSigners();
    console.log("Migrating with account:", deployer.address);

    // Connect to contracts
    const oldContract = await ethers.getContractAt("StakingEngineLinear", oldContractAddress) as StakingEngineLinear;
    const newContract = await ethers.getContractAt("StakingEngineLinearWithMigration", newContractAddress) as StakingEngineLinearWithMigration;

    // Check if migration mode is already enabled
    const migrationMode = await newContract.migrationMode();
    const migrationModeEverEnabled = await newContract.migrationModeEverEnabled();

    console.log("Migration mode:", migrationMode);
    console.log("Migration mode ever enabled:", migrationModeEverEnabled);

    // Enable migration mode if not already enabled
    if (!migrationMode && !migrationModeEverEnabled) {
        console.log("Enabling migration mode...");
        const tx = await newContract.enableMigrationMode();
        await tx.wait();
        console.log("Migration mode enabled");
    } else if (migrationModeEverEnabled && !migrationMode) {
        throw new Error("Migration mode was already used and disabled. Cannot re-enable.");
    }

    // Get all staker addresses from old contract
    console.log("Fetching staker addresses from old contract...");
    const allStakers = await oldContract.getAllStakerAddresses();
    console.log(`Found ${allStakers.length} stakers to migrate`);

    // Migrate stakes for each user
    let migratedUsers = 0;
    let totalMigratedStakes = 0;

    for (const staker of allStakers) {
        try {
            console.log(`\nMigrating stakes for user: ${staker}`);
            
            // Check if user is already migrated
            const isAlreadyMigrated = await newContract.migratedUsers(staker);
            if (isAlreadyMigrated) {
                console.log(`User ${staker} already migrated, skipping...`);
                continue;
            }

            // Get user's stakes from old contract
            const userStakes = await oldContract.stakes(staker, 0).catch(() => null);
            if (!userStakes) {
                console.log(`No stakes found for user ${staker}`);
                continue;
            }

            // Collect all stakes for this user
            const stakes: StakeData[] = [];
            let stakeIndex = 0;
            
            while (true) {
                try {
                    const stake = await oldContract.stakes(staker, stakeIndex);
                    stakes.push({
                        user: staker,
                        amount: stake.amount,
                        rewardDebt: stake.rewardDebt,
                        lockPeriod: stake.lockPeriod,
                        startTime: stake.startTime,
                        referrer: stake.referrer,
                        isActive: stake.isActive
                    });
                    stakeIndex++;
                } catch (error) {
                    // No more stakes for this user
                    break;
                }
            }

            if (stakes.length === 0) {
                console.log(`No stakes found for user ${staker}`);
                continue;
            }

            console.log(`Found ${stakes.length} stakes for user ${staker}`);

            // Migrate stakes in batches if there are many
            const batchSize = 10; // Adjust based on gas limits
            for (let i = 0; i < stakes.length; i += batchSize) {
                const batch = stakes.slice(i, i + batchSize);
                
                if (batch.length === 1) {
                    // Use single stake migration
                    const stake = batch[0];
                    console.log(`Migrating single stake: ${stake.amount} tokens, lock period: ${stake.lockPeriod}`);
                    
                    const tx = await newContract.migrateStake(
                        staker,
                        stake.amount,
                        stake.rewardDebt,
                        stake.lockPeriod,
                        stake.startTime,
                        stake.referrer,
                        stake.isActive
                    );
                    await tx.wait();
                } else {
                    // Use multiple stakes migration
                    console.log(`Migrating batch of ${batch.length} stakes`);
                    
                    const amounts = batch.map(s => s.amount);
                    const rewardDebts = batch.map(s => s.rewardDebt);
                    const lockPeriods = batch.map(s => s.lockPeriod);
                    const startTimes = batch.map(s => s.startTime);
                    const referrers = batch.map(s => s.referrer);
                    const isActiveFlags = batch.map(s => s.isActive);

                    const tx = await newContract.migrateMultipleStakes(
                        staker,
                        amounts,
                        rewardDebts,
                        lockPeriods,
                        startTimes,
                        referrers,
                        isActiveFlags
                    );
                    await tx.wait();
                }
                
                totalMigratedStakes += batch.length;
            }

            migratedUsers++;
            console.log(`Successfully migrated ${stakes.length} stakes for user ${staker}`);

        } catch (error) {
            console.error(`Failed to migrate stakes for user ${staker}:`, error);
            // Continue with next user
        }
    }

    // Get all referrer addresses and migrate referrer data
    console.log("\nMigrating referrer data...");
    try {
        const allReferrers = await oldContract.getAllReferrerAddresses();
        console.log(`Found ${allReferrers.length} referrers to migrate`);

        for (const referrer of allReferrers) {
            try {
                console.log(`Migrating referrer: ${referrer}`);
                
                const referrerInfo = await oldContract.referrers(referrer);
                
                const tx = await newContract.migrateReferrer(
                    referrer,
                    referrerInfo.totalReferred,
                    referrerInfo.totalReferrerRewards,
                    referrerInfo.unclaimedRewards,
                    referrerInfo.lastClaimTime,
                    referrerInfo.referredStakersCount,
                    referrerInfo.activeReferredStakersCount,
                    referrerInfo.totalActiveStaked,
                    referrerInfo.totalUnstaked,
                    referrerInfo.totalActiveStaked90Days,
                    referrerInfo.totalActiveStaked180Days,
                    referrerInfo.totalActiveStaked365Days
                );
                await tx.wait();
                
                console.log(`Successfully migrated referrer ${referrer}`);
            } catch (error) {
                console.error(`Failed to migrate referrer ${referrer}:`, error);
            }
        }
    } catch (error) {
        console.error("Failed to migrate referrer data:", error);
    }

    // Set initial global totals if needed (only if not set by atomic updates)
    console.log("\nSetting initial global totals...");
    try {
        const oldTotalStaked = await oldContract.totalStaked();
        const oldTotalStaked90Days = await oldContract.totalStaked90Days();
        const oldTotalStaked180Days = await oldContract.totalStaked180Days();
        const oldTotalStaked365Days = await oldContract.totalStaked365Days();

        console.log("Old contract totals:");
        console.log("- Total Staked:", oldTotalStaked.toString());
        console.log("- Total Staked 90 Days:", oldTotalStaked90Days.toString());
        console.log("- Total Staked 180 Days:", oldTotalStaked180Days.toString());
        console.log("- Total Staked 365 Days:", oldTotalStaked365Days.toString());

        // Only set if the new contract totals don't match (in case atomic updates didn't cover everything)
        const newTotalStaked = await newContract.totalStaked();
        if (newTotalStaked !== oldTotalStaked) {
            console.log("Adjusting global totals...");
            const tx = await newContract.setInitialTotalStaked(
                oldTotalStaked,
                oldTotalStaked90Days,
                oldTotalStaked180Days,
                oldTotalStaked365Days
            );
            await tx.wait();
            console.log("Global totals set");
        } else {
            console.log("Global totals already match, no adjustment needed");
        }
    } catch (error) {
        console.error("Failed to set global totals:", error);
    }

    // Disable migration mode
    console.log("\nDisabling migration mode...");
    try {
        const tx = await newContract.disableMigrationMode();
        await tx.wait();
        console.log("Migration mode disabled - contract is now ready for normal operations");
    } catch (error) {
        console.error("Failed to disable migration mode:", error);
    }

    // Final verification
    console.log("\n=== Migration Summary ===");
    console.log(`Migrated users: ${migratedUsers}`);
    console.log(`Total migrated stakes: ${totalMigratedStakes}`);
    
    const finalTotalStaked = await newContract.totalStaked();
    const finalMigrationMode = await newContract.migrationMode();
    
    console.log(`Final total staked: ${finalTotalStaked.toString()}`);
    console.log(`Final migration mode: ${finalMigrationMode}`);
    
    console.log("Migration completed successfully!");
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then(() => {
        console.log("Migration script completed successfully");
        process.exit(0);
    })
    .catch((error) => {
        console.error("Migration script failed:", error);
        process.exit(1);
    });
