// Contract Address Validation Script
// This script validates that the provided contract addresses are correct and accessible

import { ethers } from "hardhat";

async function main() {
    console.log("🔍 CONTRACT ADDRESS VALIDATION SCRIPT 🔍");
    console.log("Validating contract addresses before migration...\n");

    // Get contract addresses from environment variables
    const COMPROMISED_STAKING_ENGINE = process.env.COMPROMISED_STAKING_ENGINE;
    const COMPROMISED_STAKE_POOL = process.env.COMPROMISED_STAKE_POOL;
    const COMPROMISED_REWARD_POOL = process.env.COMPROMISED_REWARD_POOL;

    if (!COMPROMISED_STAKING_ENGINE || !COMPROMISED_STAKE_POOL || !COMPROMISED_REWARD_POOL) {
        console.error("❌ Missing required environment variables:");
        console.error("   COMPROMISED_STAKING_ENGINE");
        console.error("   COMPROMISED_STAKE_POOL");
        console.error("   COMPROMISED_REWARD_POOL");
        console.error("\nPlease set these environment variables before running the migration.");
        process.exit(1);
    }

    console.log("📋 Contract Addresses to Validate:");
    console.log(`StakingEngine: ${COMPROMISED_STAKING_ENGINE}`);
    console.log(`Stake Pool: ${COMPROMISED_STAKE_POOL}`);
    console.log(`Reward Pool: ${COMPROMISED_REWARD_POOL}`);
    console.log("");

    // Validate address format
    console.log("🔍 Step 1: Validating address format...");
    const addresses = [
        { name: "StakingEngine", address: COMPROMISED_STAKING_ENGINE },
        { name: "Stake Pool", address: COMPROMISED_STAKE_POOL },
        { name: "Reward Pool", address: COMPROMISED_REWARD_POOL }
    ];

    for (const { name, address } of addresses) {
        if (!ethers.isAddress(address)) {
            console.error(`❌ Invalid address format for ${name}: ${address}`);
            process.exit(1);
        }
        console.log(`✅ ${name} address format is valid`);
    }

    // Check if contracts exist on the network
    console.log("\n🔍 Step 2: Checking contract existence...");
    const provider = ethers.provider;

    for (const { name, address } of addresses) {
        try {
            const code = await provider.getCode(address);
            if (code === "0x") {
                console.error(`❌ No contract found at ${name} address: ${address}`);
                console.error("   This address does not contain a deployed contract.");
                process.exit(1);
            }
            console.log(`✅ ${name} contract exists at address`);
        } catch (error) {
            console.error(`❌ Error checking ${name} contract:`, error);
            process.exit(1);
        }
    }

    // Validate StakingEngine contract interface
    console.log("\n🔍 Step 3: Validating StakingEngine contract interface...");
    try {
        const stakingEngine = await ethers.getContractAt("StakingEngineLinear", COMPROMISED_STAKING_ENGINE);
        
        // Test critical functions
        const tokenAddress = await stakingEngine.token();
        console.log(`✅ StakingEngine.token() works - Token: ${tokenAddress}`);

        const totalStaked = await stakingEngine.totalStaked();
        console.log(`✅ StakingEngine.totalStaked() works - Total: ${ethers.formatEther(totalStaked)} tokens`);

        // Try to get all staker addresses (this might fail on some networks due to gas limits)
        try {
            const allStakers = await stakingEngine.getAllStakerAddresses();
            console.log(`✅ StakingEngine.getAllStakerAddresses() works - Found ${allStakers.length} stakers`);
        } catch (error) {
            console.log("⚠️  StakingEngine.getAllStakerAddresses() failed - will use event-based extraction");
        }

    } catch (error) {
        console.error("❌ StakingEngine contract validation failed:", error);
        console.error("   The contract may not be a StakingEngineLinear or may be corrupted.");
        process.exit(1);
    }

    // Validate StakingPool contracts
    console.log("\n🔍 Step 4: Validating StakingPool contracts...");
    const poolAddresses = [
        { name: "Stake Pool", address: COMPROMISED_STAKE_POOL },
        { name: "Reward Pool", address: COMPROMISED_REWARD_POOL }
    ];

    for (const { name, address } of poolAddresses) {
        try {
            const pool = await ethers.getContractAt("StakingPool", address);
            
            // Test basic pool functions
            const tokenAddress = await pool.token();
            console.log(`✅ ${name}.token() works - Token: ${tokenAddress}`);

            const balance = await pool.getBalance();
            console.log(`✅ ${name}.getBalance() works - Balance: ${ethers.formatEther(balance)} tokens`);

        } catch (error) {
            console.error(`❌ ${name} contract validation failed:`, error);
            console.error("   The contract may not be a StakingPool or may be corrupted.");
            process.exit(1);
        }
    }

    // Network information
    console.log("\n📊 Network Information:");
    const network = await provider.getNetwork();
    console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);
    
    const blockNumber = await provider.getBlockNumber();
    console.log(`Current Block: ${blockNumber}`);

    console.log("\n🎉 ALL VALIDATIONS PASSED! 🎉");
    console.log("The contract addresses are valid and accessible.");
    console.log("You can now proceed with the migration process.");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Validation failed:", error);
        process.exit(1);
    });

// Usage:
// COMPROMISED_STAKING_ENGINE=0x... \
// COMPROMISED_STAKE_POOL=0x... \
// COMPROMISED_REWARD_POOL=0x... \
// npx hardhat run scripts/StakingEngineLinear/validateContractAddresses.ts --network base
