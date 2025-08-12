import { ethers } from "hardhat";

async function main() {
    console.log("🔄 POPULATING GLOBAL REFERRER TRACKING 🔄");
    console.log("Adding referrers to global tracking arrays...\n");

    // Get signers
    const [deployer] = await ethers.getSigners();
    console.log("Using account:", deployer.address);

    // Get contract address
    const contractAddress = process.env.NEW_STAKING_ENGINE_ADDRESS || "0x9DEd41dFF03ecc574618E7f25303B490C6cd3B91";
    const stakingEngine = await ethers.getContractAt("StakingEngineLinearWithMigration", contractAddress);
    console.log("📋 Connected to contract:", contractAddress);

    // Get all stakers and analyze their stakes
    console.log("\n🔍 Step 1: Reading all stakes to find referrers...");
    const allStakers = await stakingEngine.getAllStakerAddresses();
    console.log(`📊 Found ${allStakers.length} stakers`);

    const referrerData = new Map<string, Set<number>>();

    for (const staker of allStakers) {
        try {
            const stakes = await stakingEngine.getStakes(staker);
            
            for (const stake of stakes) {
                if (stake.referrer && stake.referrer !== "0x0000000000000000000000000000000000000000") {
                    if (!referrerData.has(stake.referrer)) {
                        referrerData.set(stake.referrer, new Set());
                    }
                    referrerData.get(stake.referrer)!.add(Number(stake.lockPeriod));
                }
            }
        } catch (error: any) {
            console.log(`⚠️  Could not read stakes for ${staker}: ${error.message}`);
        }
    }

    console.log(`📊 Found ${referrerData.size} unique referrers to add to global tracking`);

    if (referrerData.size === 0) {
        console.log("ℹ️  No referrers found to add");
        return;
    }

    // Add referrers to global tracking one by one
    console.log("\n🚀 Step 2: Adding referrers to global tracking...");

    let addedCount = 0;
    for (const [referrer, lockPeriods] of referrerData.entries()) {
        for (const lockPeriod of lockPeriods) {
            try {
                console.log(`  Adding ${referrer} for period ${lockPeriod}...`);
                
                const tx = await stakingEngine.addReferrer(referrer, lockPeriod, {
                    gasLimit: 200000
                });
                
                await tx.wait();
                addedCount++;
                console.log(`    ✅ Added successfully`);
                
                // Small delay to avoid overwhelming the network
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error: any) {
                console.log(`    ⚠️  Error adding ${referrer}: ${error.message}`);
            }
        }
    }

    // Verify the results
    console.log("\n🔍 Step 3: Verifying referrer tracking...");
    try {
        const allReferrers = await stakingEngine.getAllReferrerAddresses();
        console.log(`✅ Total referrers in global tracking: ${allReferrers.length}`);
        
        if (allReferrers.length > 0) {
            console.log("📄 Referrers in global tracking:");
            allReferrers.forEach((ref, i) => {
                console.log(`  ${i + 1}. ${ref}`);
            });
        }
    } catch (error: any) {
        console.log(`⚠️  Could not verify referrer tracking: ${error.message}`);
    }

    console.log("\n🎉 Referrer tracking population complete!");
    console.log(`✅ Successfully added ${addedCount} referrer-period combinations`);
    console.log("ℹ️  Global referrer tracking is now populated and functional");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Analysis failed:", error);
        process.exit(1);
    });
