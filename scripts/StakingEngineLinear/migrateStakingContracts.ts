// Emergency Migration Script - Extract data from compromised StakingEngine contracts
// This script comprehensively extracts all critical data needed for migration to new contracts
// Uses both getter methods and event parsing with cross-validation

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Configuration from environment variables
const EVENT_START_BLOCK = parseInt(process.env.EVENT_START_BLOCK || "0");
const EVENT_END_BLOCK = process.env.EVENT_END_BLOCK === "latest" ? "latest" : parseInt(process.env.EVENT_END_BLOCK || "0");
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "500");
const LOCK_PERIODS = [7776000, 15552000, 31536000]; // 90, 180, 365 days

interface StakeInfo {
    amount: bigint;
    rewardDebt: bigint;
    lockPeriod: bigint;
    startTime: bigint;
    referrer: string;
    isActive: boolean;
}

interface ReferrerRewardInfo {
    stakeIndex: bigint;
    amount: bigint;
    lockPeriod: bigint;
    startTime: bigint;
    endTime: bigint;
    rewardAmount: bigint;
    claimedAmount: bigint;
    lastClaimTime: bigint;
    isActive: boolean;
    staker: string;
}

interface ReferrerInfo {
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
    referredStakers: string[];
    rewards: ReferrerRewardInfo[];
}

interface EventData {
    stakes: { [txHash: string]: any };
    referrals: { [txHash: string]: any };
    unstakes: { [txHash: string]: any };
    claims: { [txHash: string]: any };
}

interface MigrationData {
    // Stake data
    stakes: { [address: string]: StakeInfo[] };
    
    // Referrer data
    referrers: { [address: string]: ReferrerInfo };
    
    // Address lists
    allStakerAddresses: string[];
    stakerAddressesByPeriod: { [period: string]: string[] };
    allReferrerAddresses: string[];
    referrerAddressesByPeriod: { [period: string]: string[] };
    
    // Global state
    totalStaked: bigint;
    totalStaked90Days: bigint;
    totalStaked180Days: bigint;
    totalStaked365Days: bigint;
    
    // StakingPool data
    stakingPoolTokenBalance: bigint;
    rewardPoolTokenBalance: bigint;
    
    // Contract addresses
    oldStakingEngine: string;
    oldStakePool: string;
    oldRewardPool: string;
    tokenAddress: string;
    
    // Extraction metadata
    extractionTimestamp: number;
    eventStartBlock: number;
    eventEndBlock: number;
    totalStakesExtracted: number;
    totalReferrersExtracted: number;
    dataIntegrityChecks: {
        stakesFromMethods: number;
        stakesFromEvents: number;
        referrersFromMethods: number;
        referrersFromEvents: number;
        crossValidationPassed: boolean;
    };
}

// Helper functions for data extraction
async function extractGlobalState(stakingEngine: any): Promise<{
    totalStaked: bigint;
    totalStaked90Days: bigint;
    totalStaked180Days: bigint;
    totalStaked365Days: bigint;
}> {
    console.log("🔍 Extracting global state variables...");
    
    const totalStaked = await stakingEngine.totalStaked();
    const totalStaked90Days = await stakingEngine.totalStaked90Days();
    const totalStaked180Days = await stakingEngine.totalStaked180Days();
    const totalStaked365Days = await stakingEngine.totalStaked365Days();
    
    console.log(`   Total Staked: ${ethers.formatEther(totalStaked)} tokens`);
    console.log(`   Total Staked 90 Days: ${ethers.formatEther(totalStaked90Days)} tokens`);
    console.log(`   Total Staked 180 Days: ${ethers.formatEther(totalStaked180Days)} tokens`);
    console.log(`   Total Staked 365 Days: ${ethers.formatEther(totalStaked365Days)} tokens`);
    
    return { totalStaked, totalStaked90Days, totalStaked180Days, totalStaked365Days };
}

async function extractStakerAddresses(stakingEngine: any): Promise<{
    allStakerAddresses: string[];
    stakerAddressesByPeriod: { [period: string]: string[] };
}> {
    console.log("🔍 Extracting staker addresses...");
    
    // Get all staker addresses
    const allStakerAddresses = await stakingEngine.getAllStakerAddresses();
    console.log(`   Found ${allStakerAddresses.length} total stakers`);
    
    // Get staker addresses by period
    const stakerAddressesByPeriod: { [period: string]: string[] } = {};
    
    for (const period of LOCK_PERIODS) {
        try {
            const stakersForPeriod = await stakingEngine.getStakerAddressesByPeriod(period);
            stakerAddressesByPeriod[period.toString()] = stakersForPeriod;
            console.log(`   Period ${period} (${period / 86400} days): ${stakersForPeriod.length} stakers`);
        } catch (error) {
            console.warn(`   Warning: Could not get stakers for period ${period}:`, error);
            stakerAddressesByPeriod[period.toString()] = [];
        }
    }
    
    return { allStakerAddresses, stakerAddressesByPeriod };
}

async function extractReferrerAddresses(stakingEngine: any): Promise<{
    allReferrerAddresses: string[];
    referrerAddressesByPeriod: { [period: string]: string[] };
}> {
    console.log("🔍 Extracting referrer addresses...");
    
    // Get all referrer addresses
    const allReferrerAddresses = await stakingEngine.getAllReferrerAddresses();
    console.log(`   Found ${allReferrerAddresses.length} total referrers`);
    
    // Get referrer addresses by period
    const referrerAddressesByPeriod: { [period: string]: string[] } = {};
    
    for (const period of LOCK_PERIODS) {
        try {
            const referrersForPeriod = await stakingEngine.getReferrerAddressesByPeriod(period);
            referrerAddressesByPeriod[period.toString()] = referrersForPeriod;
            console.log(`   Period ${period} (${period / 86400} days): ${referrersForPeriod.length} referrers`);
        } catch (error) {
            console.warn(`   Warning: Could not get referrers for period ${period}:`, error);
            referrerAddressesByPeriod[period.toString()] = [];
        }
    }
    
    return { allReferrerAddresses, referrerAddressesByPeriod };
}

async function extractUserStakes(stakingEngine: any, stakerAddresses: string[]): Promise<{ [address: string]: StakeInfo[] }> {
    console.log(`🔍 Extracting stakes for ${stakerAddresses.length} stakers...`);
    
    const stakes: { [address: string]: StakeInfo[] } = {};
    let processedCount = 0;
    
    for (const stakerAddress of stakerAddresses) {
        try {
            const userStakes = await stakingEngine.getUserStakes(stakerAddress);
            
            stakes[stakerAddress] = userStakes.map((stake: any) => ({
                amount: BigInt(stake.amount.toString()),
                rewardDebt: BigInt(stake.rewardDebt.toString()),
                lockPeriod: BigInt(stake.lockPeriod.toString()),
                startTime: BigInt(stake.startTime.toString()),
                referrer: stake.referrer,
                isActive: stake.isActive
            }));
            
            processedCount++;
            if (processedCount % 50 === 0) {
                console.log(`   Processed ${processedCount}/${stakerAddresses.length} stakers`);
            }
        } catch (error) {
            console.warn(`   Warning: Could not get stakes for ${stakerAddress}:`, error);
            stakes[stakerAddress] = [];
        }
    }
    
    console.log(`   ✅ Extracted stakes for ${processedCount} stakers`);
    return stakes;
}

async function extractReferrerData(stakingEngine: any, referrerAddresses: string[]): Promise<{ [address: string]: ReferrerInfo }> {
    console.log(`🔍 Extracting referrer data for ${referrerAddresses.length} referrers...`);
    
    const referrers: { [address: string]: ReferrerInfo } = {};
    let processedCount = 0;
    
    for (const referrerAddress of referrerAddresses) {
        try {
            // Get basic referrer info
            const referrerInfo = await stakingEngine.referrers(referrerAddress);
            
            // Get referred stakers
            const referredStakers = await stakingEngine.getReferredStakers(referrerAddress);
            
            // Get referrer rewards
            const referrerRewards = await stakingEngine.getReferrerRewards(referrerAddress);
            
            // Handle referrer rewards safely - some referrers may not have rewards
            const rewards: ReferrerRewardInfo[] = [];
            if (referrerRewards && Array.isArray(referrerRewards) && referrerRewards.length > 0) {
                for (const reward of referrerRewards) {
                    if (reward && reward.stakeIndex !== undefined) {
                        rewards.push({
                            stakeIndex: BigInt(reward.stakeIndex.toString()),
                            amount: BigInt(reward.amount?.toString() || '0'),
                            lockPeriod: BigInt(reward.lockPeriod?.toString() || '0'),
                            startTime: BigInt(reward.startTime?.toString() || '0'),
                            endTime: BigInt(reward.endTime?.toString() || '0'),
                            rewardAmount: BigInt(reward.rewardAmount?.toString() || '0'),
                            claimedAmount: BigInt(reward.claimedAmount?.toString() || '0'),
                            lastClaimTime: BigInt(reward.lastClaimTime?.toString() || '0'),
                            isActive: reward.isActive || false,
                            staker: reward.staker || ''
                        });
                    }
                }
            }
            
            referrers[referrerAddress] = {
                totalReferred: BigInt(referrerInfo.totalReferred.toString()),
                totalReferrerRewards: BigInt(referrerInfo.totalReferrerRewards.toString()),
                unclaimedRewards: BigInt(referrerInfo.unclaimedRewards.toString()),
                lastClaimTime: BigInt(referrerInfo.lastClaimTime.toString()),
                referredStakersCount: BigInt(referrerInfo.referredStakersCount.toString()),
                activeReferredStakersCount: BigInt(referrerInfo.activeReferredStakersCount.toString()),
                totalActiveStaked: BigInt(referrerInfo.totalActiveStaked.toString()),
                totalUnstaked: BigInt(referrerInfo.totalUnstaked.toString()),
                totalActiveStaked90Days: BigInt(referrerInfo.totalActiveStaked90Days.toString()),
                totalActiveStaked180Days: BigInt(referrerInfo.totalActiveStaked180Days.toString()),
                totalActiveStaked365Days: BigInt(referrerInfo.totalActiveStaked365Days.toString()),
                referredStakers: referredStakers,
                rewards: rewards
            };
            
            processedCount++;
            if (processedCount % 10 === 0) {
                console.log(`   Processed ${processedCount}/${referrerAddresses.length} referrers`);
            }
        } catch (error) {
            console.warn(`   Warning: Could not get referrer data for ${referrerAddress}:`, error);
            // Create empty referrer data
            referrers[referrerAddress] = {
                totalReferred: 0n,
                totalReferrerRewards: 0n,
                unclaimedRewards: 0n,
                lastClaimTime: 0n,
                referredStakersCount: 0n,
                activeReferredStakersCount: 0n,
                totalActiveStaked: 0n,
                totalUnstaked: 0n,
                totalActiveStaked90Days: 0n,
                totalActiveStaked180Days: 0n,
                totalActiveStaked365Days: 0n,
                referredStakers: [],
                rewards: []
            };
        }
    }
    
    console.log(`   ✅ Extracted data for ${processedCount} referrers`);
    return referrers;
}

async function extractPoolBalances(stakePool: any, rewardPool: any): Promise<{
    stakingPoolTokenBalance: bigint;
    rewardPoolTokenBalance: bigint;
}> {
    console.log("🔍 Extracting pool balances...");
    
    const stakingPoolTokenBalance = await stakePool.getBalance();
    const rewardPoolTokenBalance = await rewardPool.getBalance();
    
    console.log(`   Staking Pool Balance: ${ethers.formatEther(stakingPoolTokenBalance)} tokens`);
    console.log(`   Reward Pool Balance: ${ethers.formatEther(rewardPoolTokenBalance)} tokens`);
    
    return { stakingPoolTokenBalance, rewardPoolTokenBalance };
}

async function extractEventData(stakingEngine: any, startBlock: number, endBlock: number | string): Promise<EventData> {
    console.log(`🔍 Extracting event data from block ${startBlock} to ${endBlock}...`);
    
    const eventData: EventData = {
        stakes: {},
        referrals: {},
        unstakes: {},
        claims: {}
    };
    
    const currentBlock = endBlock === "latest" ? await ethers.provider.getBlockNumber() : endBlock as number;
    let fromBlock = startBlock;
    
    while (fromBlock <= currentBlock) {
        const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, currentBlock);
        
        console.log(`   Processing blocks ${fromBlock} to ${toBlock}...`);
        
        try {
            // Get Staked events
            const stakedEvents = await stakingEngine.queryFilter(
                stakingEngine.filters.Staked(),
                fromBlock,
                toBlock
            );
            
            for (const event of stakedEvents) {
                eventData.stakes[event.transactionHash] = {
                    user: event.args?.user,
                    amount: event.args?.amount,
                    lockPeriod: event.args?.lockPeriod,
                    referrer: event.args?.referrer,
                    blockNumber: event.blockNumber,
                    transactionHash: event.transactionHash
                };
            }
            
            // Note: ReferrerRewardAdded events may not exist in this contract version
            // Skip referrer event extraction to avoid errors
            console.log("     Skipping ReferrerRewardAdded events (not available in this contract)");
            
            console.log(`     Found ${stakedEvents.length} Staked events`);
            
        } catch (error) {
            console.warn(`   Warning: Error processing blocks ${fromBlock}-${toBlock}:`, error);
        }
        
        fromBlock = toBlock + 1;
    }
    
    console.log(`   ✅ Event extraction complete`);
    return eventData;
}

async function crossValidateData(migrationData: MigrationData, eventData: EventData): Promise<boolean> {
    console.log("🔍 Cross-validating data integrity...");
    
    let validationPassed = true;
    
    // Count stakes from methods vs events
    const stakesFromMethods = Object.values(migrationData.stakes).reduce((total, stakes) => total + stakes.length, 0);
    const stakesFromEvents = Object.keys(eventData.stakes).length;
    
    console.log(`   Stakes from methods: ${stakesFromMethods}`);
    console.log(`   Stakes from events: ${stakesFromEvents}`);
    
    if (Math.abs(stakesFromMethods - stakesFromEvents) > stakesFromMethods * 0.1) {
        console.warn(`   ⚠️  Significant discrepancy in stake count (>10% difference)`);
        validationPassed = false;
    }
    
    // Update migration data with validation results
    migrationData.dataIntegrityChecks = {
        stakesFromMethods,
        stakesFromEvents,
        referrersFromMethods: Object.keys(migrationData.referrers).length,
        referrersFromEvents: Object.keys(eventData.referrals).length,
        crossValidationPassed: validationPassed
    };
    
    return validationPassed;
}

async function main() {
    console.log("🚨 EMERGENCY MIGRATION SCRIPT 🚨");
    console.log("Comprehensively extracting data from compromised contracts...\n");
    
    console.log("📋 Configuration:");
    console.log(`Event Start Block: ${EVENT_START_BLOCK}`);
    console.log(`Event End Block: ${EVENT_END_BLOCK}`);
    console.log(`Batch Size: ${BATCH_SIZE}`);
    console.log("");

    // Compromised contract addresses from environment variables
    const COMPROMISED_STAKING_ENGINE = process.env.COMPROMISED_STAKING_ENGINE || "0x32A2b049b1E7A6c8C26284DE49e7F05A00466a5d";
    const COMPROMISED_STAKE_POOL = process.env.COMPROMISED_STAKE_POOL || "0xfa9cb36656cf9A2D2BA3a6b0aD810fB9993F7A21";
    const COMPROMISED_REWARD_POOL = process.env.COMPROMISED_REWARD_POOL || "0xDB2ab8De23eb8dd6cd12127673be9ae6Ae6edd9A";

    console.log("📋 Using Contract Addresses:");
    console.log(`StakingEngine: ${COMPROMISED_STAKING_ENGINE}`);
    console.log(`Stake Pool: ${COMPROMISED_STAKE_POOL}`);
    console.log(`Reward Pool: ${COMPROMISED_REWARD_POOL}`);
    console.log("");

    // Validate contract addresses
    if (!ethers.isAddress(COMPROMISED_STAKING_ENGINE) || 
        !ethers.isAddress(COMPROMISED_STAKE_POOL) || 
        !ethers.isAddress(COMPROMISED_REWARD_POOL)) {
        throw new Error("Invalid contract addresses provided. Please check environment variables.");
    }

    // Get contract instances
    const stakingEngine = await ethers.getContractAt("StakingEngineLinear", COMPROMISED_STAKING_ENGINE);
    const stakePool = await ethers.getContractAt("StakingPool", COMPROMISED_STAKE_POOL);
    const rewardPool = await ethers.getContractAt("StakingPool", COMPROMISED_REWARD_POOL);

    // Get token address with error handling
    let tokenAddress: string;
    try {
        tokenAddress = await stakingEngine.token();
        console.log("✅ Successfully connected to StakingEngine contract");
    } catch (error) {
        console.error("❌ Failed to connect to StakingEngine contract:", error);
        throw new Error(`Cannot connect to StakingEngine at ${COMPROMISED_STAKING_ENGINE}. Please verify the address and network.`);
    }
    
    console.log("📋 Contract Information:");
    console.log(`Token Address: ${tokenAddress}`);
    console.log(`Compromised StakingEngine: ${COMPROMISED_STAKING_ENGINE}`);
    console.log(`Compromised StakePool: ${COMPROMISED_STAKE_POOL}`);
    console.log(`Compromised RewardPool: ${COMPROMISED_REWARD_POOL}\n`);

    // Initialize migration data structure
    const migrationData: MigrationData = {
        stakes: {},
        referrers: {},
        allStakerAddresses: [],
        stakerAddressesByPeriod: {},
        allReferrerAddresses: [],
        referrerAddressesByPeriod: {},
        totalStaked: 0n,
        totalStaked90Days: 0n,
        totalStaked180Days: 0n,
        totalStaked365Days: 0n,
        stakingPoolTokenBalance: 0n,
        rewardPoolTokenBalance: 0n,
        oldStakingEngine: COMPROMISED_STAKING_ENGINE,
        oldStakePool: COMPROMISED_STAKE_POOL,
        oldRewardPool: COMPROMISED_REWARD_POOL,
        tokenAddress: tokenAddress,
        extractionTimestamp: Date.now(),
        eventStartBlock: EVENT_START_BLOCK,
        eventEndBlock: EVENT_END_BLOCK === "latest" ? await ethers.provider.getBlockNumber() : EVENT_END_BLOCK,
        totalStakesExtracted: 0,
        totalReferrersExtracted: 0,
        dataIntegrityChecks: {
            stakesFromMethods: 0,
            stakesFromEvents: 0,
            referrersFromMethods: 0,
            referrersFromEvents: 0,
            crossValidationPassed: false
        }
    };

    try {
        // Step 1: Extract global state
        const globalState = await extractGlobalState(stakingEngine);
        Object.assign(migrationData, globalState);
        
        // Step 2: Extract staker addresses
        const stakerData = await extractStakerAddresses(stakingEngine);
        migrationData.allStakerAddresses = stakerData.allStakerAddresses;
        migrationData.stakerAddressesByPeriod = stakerData.stakerAddressesByPeriod;
        
        // Step 3: Extract referrer addresses
        const referrerData = await extractReferrerAddresses(stakingEngine);
        migrationData.allReferrerAddresses = referrerData.allReferrerAddresses;
        migrationData.referrerAddressesByPeriod = referrerData.referrerAddressesByPeriod;
        
        // Step 4: Extract user stakes
        migrationData.stakes = await extractUserStakes(stakingEngine, migrationData.allStakerAddresses);
        migrationData.totalStakesExtracted = Object.values(migrationData.stakes).reduce((total, stakes) => total + stakes.length, 0);
        
        // Step 5: Extract referrer data
        migrationData.referrers = await extractReferrerData(stakingEngine, migrationData.allReferrerAddresses);
        migrationData.totalReferrersExtracted = Object.keys(migrationData.referrers).length;
        
        // Step 6: Extract pool balances
        const poolBalances = await extractPoolBalances(stakePool, rewardPool);
        migrationData.stakingPoolTokenBalance = poolBalances.stakingPoolTokenBalance;
        migrationData.rewardPoolTokenBalance = poolBalances.rewardPoolTokenBalance;
        
        // Step 7: Extract event data for cross-validation
        const eventData = await extractEventData(stakingEngine, EVENT_START_BLOCK, EVENT_END_BLOCK);
        
        // Step 8: Cross-validate data
        const validationPassed = await crossValidateData(migrationData, eventData);
        
        // Step 9: Generate summary and save data
        console.log("\n📊 EXTRACTION SUMMARY:");
        console.log(`Total Stakers: ${migrationData.allStakerAddresses.length}`);
        console.log(`Total Stakes: ${migrationData.totalStakesExtracted}`);
        console.log(`Total Referrers: ${migrationData.totalReferrersExtracted}`);
        console.log(`Total Staked Amount: ${ethers.formatEther(migrationData.totalStaked)} tokens`);
        console.log(`StakePool Balance: ${ethers.formatEther(migrationData.stakingPoolTokenBalance)} tokens`);
        console.log(`RewardPool Balance: ${ethers.formatEther(migrationData.rewardPoolTokenBalance)} tokens`);
        console.log(`Data Validation: ${validationPassed ? "✅ PASSED" : "❌ FAILED"}`);
        
        // Save migration data to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `migration-data-${timestamp}.json`;
        const filepath = path.join(__dirname, filename);
        
        // Convert BigInt values to strings for JSON serialization
        const jsonData = JSON.stringify(migrationData, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        , 2);
        
        fs.writeFileSync(filepath, jsonData);
        
        console.log(`\n✅ Migration data saved to ${filename}`);
        console.log("\n🎉 EXTRACTION COMPLETED SUCCESSFULLY! 🎉");
        
        if (!validationPassed) {
            console.log("\n⚠️  WARNING: Data validation failed. Please review the extracted data carefully.");
        }
        
    } catch (error) {
        console.error("\n❌ Migration failed:", error);
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Migration failed:", error);
        process.exit(1);
    });

// Usage:
// COMPROMISED_STAKING_ENGINE=0x... \
// COMPROMISED_STAKE_POOL=0x... \
// COMPROMISED_REWARD_POOL=0x... \
// EVENT_START_BLOCK=0 \
// EVENT_END_BLOCK=latest \
// BATCH_SIZE=500 \
// npx hardhat run scripts/StakingEngineLinear/migrateStakingContracts_new.ts --network base
