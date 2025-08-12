// Verification script to ensure migration was successful
// This script compares the migrated data with the original data

import { ethers } from "hardhat";
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

async function main() {
    console.log("🔍 MIGRATION VERIFICATION SCRIPT 🔍");
    console.log("Verifying migration completeness and accuracy...\n");

    // Get environment variables
    const newStakingEngineAddress = process.env.NEW_STAKING_ENGINE;
    let migrationDataFile = process.env.MIGRATION_DATA_FILE;

    if (!newStakingEngineAddress || !migrationDataFile) {
        throw new Error("NEW_STAKING_ENGINE and MIGRATION_DATA_FILE environment variables required");
    }

    // Remove surrounding quotes if present (Windows issue)
    migrationDataFile = migrationDataFile.replace(/^["']|["']$/g, '');

    // Load migration data
    console.log(`📁 Loading migration data from: ${migrationDataFile}`);
    const migrationData: MigrationData = JSON.parse(
        fs.readFileSync(path.join(__dirname, migrationDataFile), 'utf8')
    );

    // Get new contract instance
    const newStakingEngine = await ethers.getContractAt("StakingEngineLinearWithMigration", newStakingEngineAddress);
    const token = await ethers.getContractAt("IERC20", migrationData.tokenAddress);

    console.log("\n📋 Verification Configuration:");
    console.log(`New StakingEngine: ${newStakingEngineAddress}`);
    console.log(`Token Address: ${migrationData.tokenAddress}`);
    console.log(`Expected Stakers: ${migrationData.allStakerAddresses.length}`);

    let verificationResults = {
        globalStateCorrect: false,
        stakesCorrect: 0,
        stakesIncorrect: 0,
        referrersCorrect: 0,
        referrersIncorrect: 0,
        totalStakersExpected: migrationData.allStakerAddresses.length,
        totalStakesExpected: Object.values(migrationData.stakes).reduce((sum, stakes) => sum + stakes.length, 0),
        totalReferrersExpected: Object.keys(migrationData.referrers).length
    };

    console.log("\n🔍 Step 1: Verifying global state variables...");

    try {
        const newTotalStaked = await newStakingEngine.totalStaked();
        const newTotalStaked90 = await newStakingEngine.totalStaked90Days();
        const newTotalStaked180 = await newStakingEngine.totalStaked180Days();
        const newTotalStaked365 = await newStakingEngine.totalStaked365Days();

        console.log(`Expected Total Staked: ${ethers.formatEther(migrationData.totalStaked)}`);
        console.log(`Actual Total Staked: ${ethers.formatEther(newTotalStaked)}`);
        
        console.log(`Expected 90 Days: ${ethers.formatEther(migrationData.totalStaked90Days)}`);
        console.log(`Actual 90 Days: ${ethers.formatEther(newTotalStaked90)}`);
        
        console.log(`Expected 180 Days: ${ethers.formatEther(migrationData.totalStaked180Days)}`);
        console.log(`Actual 180 Days: ${ethers.formatEther(newTotalStaked180)}`);
        
        console.log(`Expected 365 Days: ${ethers.formatEther(migrationData.totalStaked365Days)}`);
        console.log(`Actual 365 Days: ${ethers.formatEther(newTotalStaked365)}`);

        const globalStateMatches = 
            newTotalStaked.toString() === migrationData.totalStaked &&
            newTotalStaked90.toString() === migrationData.totalStaked90Days &&
            newTotalStaked180.toString() === migrationData.totalStaked180Days &&
            newTotalStaked365.toString() === migrationData.totalStaked365Days;

        if (globalStateMatches) {
            console.log("✅ Global state variables match!");
            verificationResults.globalStateCorrect = true;
        } else {
            console.log("❌ Global state variables don't match!");
        }

    } catch (error) {
        console.error("❌ Error verifying global state:", error);
    }

    console.log("\n🔍 Step 2: Verifying individual stakes...");

    for (const stakerAddress of migrationData.allStakerAddresses) {
        const expectedStakes = migrationData.stakes[stakerAddress];
        if (!expectedStakes) continue;

        try {
            console.log(`   👤 Verifying ${expectedStakes.length} stakes for ${stakerAddress}`);

            for (let i = 0; i < expectedStakes.length; i++) {
                try {
                    const actualStake = await newStakingEngine.stakes(stakerAddress, i);
                    const expectedStake = expectedStakes[i];

                    const stakeMatches = 
                        actualStake.amount.toString() === expectedStake.amount &&
                        actualStake.rewardDebt.toString() === expectedStake.rewardDebt &&
                        actualStake.lockPeriod.toString() === expectedStake.lockPeriod &&
                        actualStake.startTime.toString() === expectedStake.startTime &&
                        actualStake.referrer.toLowerCase() === expectedStake.referrer.toLowerCase() &&
                        actualStake.isActive === expectedStake.isActive;

                    if (stakeMatches) {
                        verificationResults.stakesCorrect++;
                        console.log(`      ✅ Stake ${i}: ${ethers.formatEther(expectedStake.amount)} tokens`);
                    } else {
                        verificationResults.stakesIncorrect++;
                        console.log(`      ❌ Stake ${i}: Mismatch detected`);
                        console.log(`         Expected: ${ethers.formatEther(expectedStake.amount)} tokens`);
                        console.log(`         Actual: ${ethers.formatEther(actualStake.amount)} tokens`);
                    }

                } catch (error) {
                    verificationResults.stakesIncorrect++;
                    console.log(`      ❌ Stake ${i}: Error reading from contract`);
                }
            }

        } catch (error) {
            console.error(`   ❌ Error verifying stakes for ${stakerAddress}:`, error);
        }
    }

    console.log("\n🔍 Step 3: Verifying referrer data...");

    for (const referrerAddress of Object.keys(migrationData.referrers)) {
        const expectedReferrer = migrationData.referrers[referrerAddress];

        try {
            const actualReferrer = await newStakingEngine.referrers(referrerAddress);

            const referrerMatches = 
                actualReferrer.totalReferred.toString() === expectedReferrer.totalReferred &&
                actualReferrer.totalReferrerRewards.toString() === expectedReferrer.totalRewards &&
                actualReferrer.lastClaimTime.toString() === expectedReferrer.lastClaimTime;

            if (referrerMatches) {
                verificationResults.referrersCorrect++;
                console.log(`   Referrer ${referrerAddress}: ${expectedReferrer.totalReferred} referred`);
            } else {
                verificationResults.referrersIncorrect++;
                console.log(`   ❌ Referrer ${referrerAddress}: Mismatch detected`);
            }

        } catch (error) {
            verificationResults.referrersIncorrect++;
            console.log(`   ❌ Referrer ${referrerAddress}: Error reading from contract`);
        }
    }

    console.log("\n🔍 Step 4: Verifying token balances...");

    try {
        // Get stake pool and reward pool addresses from the staking engine
        const stakePoolAddress = await newStakingEngine.stakePool();
        const rewardPoolAddress = await newStakingEngine.rewardPool();

        const actualStakePoolBalance = await token.balanceOf(stakePoolAddress);
        const actualRewardPoolBalance = await token.balanceOf(rewardPoolAddress);

        console.log(`Expected StakePool Balance: ${ethers.formatEther(migrationData.stakingPoolTokenBalance)}`);
        console.log(`Actual StakePool Balance: ${ethers.formatEther(actualStakePoolBalance)}`);

        console.log(`Expected RewardPool Balance: ${ethers.formatEther(migrationData.rewardPoolTokenBalance)}`);
        console.log(`Actual RewardPool Balance: ${ethers.formatEther(actualRewardPoolBalance)}`);

        const balancesMatch = 
            actualStakePoolBalance.toString() === migrationData.stakingPoolTokenBalance &&
            actualRewardPoolBalance.toString() === migrationData.rewardPoolTokenBalance;

        if (balancesMatch) {
            console.log("✅ Token balances match!");
        } else {
            console.log("⚠️  Token balances don't match - may need manual transfer");
        }

    } catch (error) {
        console.error("❌ Error verifying token balances:", error);
    }

    console.log("\n📊 VERIFICATION SUMMARY");
    console.log("=" .repeat(50));
    console.log(`Global State: ${verificationResults.globalStateCorrect ? '✅ CORRECT' : '❌ INCORRECT'}`);
    console.log(`Stakes: ${verificationResults.stakesCorrect}/${verificationResults.totalStakesExpected} correct`);
    console.log(`Referrers: ${verificationResults.referrersCorrect}/${verificationResults.totalReferrersExpected} correct`);

    const allStakesCorrect = verificationResults.stakesIncorrect === 0;
    const allReferrersCorrect = verificationResults.referrersIncorrect === 0;

    if (verificationResults.globalStateCorrect && allStakesCorrect && allReferrersCorrect) {
        console.log("\n🎉 MIGRATION VERIFICATION SUCCESSFUL! 🎉");
        console.log("All data has been migrated correctly.");
        console.log("You can now safely resume normal operations.");
    } else {
        console.log("\n⚠️  MIGRATION VERIFICATION FAILED");
        console.log("Some data was not migrated correctly.");
        console.log("Please review the errors above and re-run migration for failed items.");
    }

    // Save verification report
    const verificationReport = {
        timestamp: new Date().toISOString(),
        contractAddress: newStakingEngineAddress,
        results: verificationResults,
        success: verificationResults.globalStateCorrect && allStakesCorrect && allReferrersCorrect
    };

    const reportFile = `verification-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(__dirname, reportFile), JSON.stringify(verificationReport, null, 2));
    console.log(`\n📁 Verification report saved to: ${reportFile}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Verification failed:", error);
        process.exit(1);
    });

// Usage:
// NEW_STAKING_ENGINE=0x... \
// MIGRATION_DATA_FILE=migration-data-2024-01-01T12-00-00-000Z.json \
// npx hardhat run scripts/StakingEngineLinear/verifyMigration.ts --network base
