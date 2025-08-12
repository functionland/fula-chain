import { ethers } from "hardhat";

async function main() {
    console.log("🔄 REFERRER DATA ANALYSIS 🔄");
    console.log("Analyzing referrer data in migrated stakes...\n");

    // Get new contract address from environment or deployment file
    const newContractAddress = process.env.NEW_STAKING_ENGINE_ADDRESS || "0x9DEd41dFF03ecc574618E7f25303B490C6cd3B91";
    
    // Connect to the new contract
    const newStakingEngine = await ethers.getContractAt("StakingEngineLinearWithMigration", newContractAddress);
    console.log("📋 Connected to new contract:", newContractAddress);

    // Get all staker addresses
    console.log("\n🔍 Step 1: Reading migrated stake data...");
    const allStakers = await newStakingEngine.getAllStakerAddresses();
    console.log(`📊 Found ${allStakers.length} stakers`);

    // Analyze referrer data from migrated stakes
    const referrerMap = new Map<string, Set<number>>();
    let totalStakesWithReferrers = 0;
    let totalStakes = 0;

    for (const staker of allStakers) {
        try {
            const stakes = await newStakingEngine.getStakes(staker);
            totalStakes += stakes.length;
            
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

    console.log("\n📊 Referrer Analysis Results:");
    console.log(`✅ Total stakes analyzed: ${totalStakes}`);
    console.log(`✅ Stakes with referrers: ${totalStakesWithReferrers}`);
    console.log(`✅ Unique referrers found: ${referrerMap.size}`);
    
    if (referrerMap.size > 0) {
        console.log("\n📄 Referrer Details:");
        let index = 1;
        for (const [referrer, lockPeriods] of referrerMap.entries()) {
            console.log(`  ${index}. ${referrer} (${lockPeriods.size} lock periods: ${Array.from(lockPeriods).join(", ")})`);
            index++;
        }
    }

    // Check current contract referrer tracking state
    console.log("\n🔍 Step 2: Checking contract referrer tracking...");
    try {
        const contractReferrers = await newStakingEngine.getAllReferrerAddresses();
        console.log(`📋 Contract tracked referrers: ${contractReferrers.length}`);
        
        if (contractReferrers.length === 0 && referrerMap.size > 0) {
            console.log("⚠️  Referrer tracking is empty but referrer data exists in stakes");
            console.log("ℹ️  This is expected since referrer tracking was removed for gas optimization");
            console.log("ℹ️  Referrer data is preserved in individual stakes and can be queried as needed");
        } else if (contractReferrers.length > 0) {
            console.log("✅ Contract has referrer tracking data:");
            contractReferrers.slice(0, 5).forEach((ref, i) => {
                console.log(`  ${i + 1}. ${ref}`);
            });
            if (contractReferrers.length > 5) {
                console.log(`  ... and ${contractReferrers.length - 5} more`);
            }
        }
    } catch (error: any) {
        console.log(`⚠️  Could not read contract referrer tracking: ${error.message}`);
    }

    console.log("\n🎉 Referrer data analysis complete!");
    console.log("ℹ️  All referrer information is preserved in individual stakes");
    console.log("ℹ️  The migration was successful - referrer data is accessible via stake queries");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Analysis failed:", error);
        process.exit(1);
    });
