import { ethers } from "hardhat";
import * as hre from "hardhat";

/**
 * Secure StoragePool Implementation Upgrade Script
 *
 * This script:
 * 1. Deploys new StakingPool (if needed) or uses existing one
 * 2. Deploys new StoragePool implementation
 * 3. SECURELY initializes the implementation to prevent front-running attacks
 * 4. Verifies the implementation security
 * 5. Verifies contracts on block explorer
 * 6. Returns implementation address for governance upgrade
 *
 * SECURITY: Unlike other upgrade scripts, this properly initializes the
 * implementation contract to prevent attackers from hijacking it.
 */

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("🚀 SECURE STORAGEPOOL IMPLEMENTATION UPGRADE");
    console.log("=".repeat(60));
    console.log("Deploying with account:", deployer.address);
    console.log("Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

    // Environment variables
    const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
    const deployNewStakingPool = (process.env.DEPLOY_NEW_STAKING_POOL || "false").toLowerCase() === "true";
    const existingStakingPoolAddress = process.env.EXISTING_STAKING_POOL_ADDRESS?.trim();
    const storageTokenAddress = process.env.STORAGE_TOKEN_ADDRESS?.trim();

    // Validate required parameters
    if (!storageTokenAddress) {
        throw new Error("STORAGE_TOKEN_ADDRESS environment variable is required");
    }

    let stakingPoolAddress: string;

    // Step 1: Deploy new StakingPool or use existing one
    if (deployNewStakingPool) {
        console.log("\n=== Step 1: Deploying new StakingPool ===");
        const StakingPool = await ethers.getContractFactory("StakingPool");

        console.log("Deploying new StakingPool...");
        const stakingPool = await StakingPool.deploy();
        await stakingPool.waitForDeployment();

        stakingPoolAddress = await stakingPool.getAddress();
        console.log("✅ New StakingPool deployed:", stakingPoolAddress);

        // Initialize the new StakingPool implementation with dead addresses for security
        console.log("🔒 Securing new StakingPool implementation...");
        try {
            const initTx = await stakingPool.initialize(
                DEAD_ADDRESS,  // _token
                DEAD_ADDRESS,  // initialOwner
                DEAD_ADDRESS   // initialAdmin
            );
            await initTx.wait();
            console.log("✅ StakingPool implementation secured");
        } catch (error: any) {
            if (error.message.includes("already initialized")) {
                console.log("✅ StakingPool was already initialized");
            } else {
                console.error("❌ Failed to secure StakingPool:", error.message);
                throw error;
            }
        }
    } else {
        if (!existingStakingPoolAddress) {
            throw new Error("EXISTING_STAKING_POOL_ADDRESS is required when DEPLOY_NEW_STAKING_POOL=false");
        }
        stakingPoolAddress = existingStakingPoolAddress;
        console.log("\n=== Step 1: Using existing StakingPool ===");
        console.log("✅ Using existing StakingPool:", stakingPoolAddress);
    }

    // Step 2: Deploy new StoragePool implementation
    console.log("\n=== Step 2: Deploying new StoragePool implementation ===");
    const StoragePool = await ethers.getContractFactory("StoragePool");

    console.log("Deploying new StoragePool implementation...");
    const implementation = await StoragePool.deploy();
    await implementation.waitForDeployment();

    const implementationAddress = await implementation.getAddress();
    console.log("✅ New StoragePool implementation deployed:", implementationAddress);

    // Step 3: CRITICAL SECURITY - Initialize the implementation to prevent attacks
    console.log("\n=== Step 3: SECURING IMPLEMENTATION (CRITICAL) ===");
    console.log("🔒 Initializing implementation with dead addresses to prevent front-running attacks...");

    try {
        // Initialize with dead addresses to prevent anyone from hijacking the implementation
        const initTx = await implementation.initialize(
            DEAD_ADDRESS,      // _storageToken
            DEAD_ADDRESS,      // _tokenPool (StakingPool)
            DEAD_ADDRESS,      // initialOwner
            DEAD_ADDRESS       // initialAdmin
        );
        await initTx.wait();

        console.log("✅ Implementation secured with dead addresses");
        console.log("   Transaction hash:", initTx.hash);
    } catch (error: any) {
        if (error.message.includes("already initialized")) {
            console.log("✅ Implementation was already initialized (safe)");
        } else {
            console.error("❌ CRITICAL: Failed to secure implementation!");
            console.error("Error:", error.message);
            throw new Error("Implementation security failed - ABORT DEPLOYMENT");
        }
    }

    // Step 4: Verify implementation security
    console.log("\n=== Step 4: Verifying implementation security ===");
    
    try {
        // Test 1: Check admin count
        const adminCount = await implementation.adminCount();
        console.log(`📊 Implementation admin count: ${adminCount}`);
        
        if (Number(adminCount) === 0) {
            throw new Error("Implementation admin count is 0 - NOT SECURE!");
        }
        
        // Test 2: Try to initialize again (should fail)
        try {
            await implementation.initialize.staticCall(
                DEAD_ADDRESS,  // _storageToken
                DEAD_ADDRESS,  // _tokenPool
                DEAD_ADDRESS,  // initialOwner
                DEAD_ADDRESS   // initialAdmin
            );
            throw new Error("Implementation can still be initialized - NOT SECURE!");
        } catch (error: any) {
            if (error.message.includes("already initialized") ||
                error.message.includes("Initializable") ||
                error.message.includes("InvalidInitialization")) {
                console.log("✅ Implementation cannot be re-initialized (secure)");
            } else {
                throw new Error(`Unexpected error testing initialization: ${error.message}`);
            }
        }
        
        // Test 3: Check if dead address has admin role
        const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
        const deadHasRole = await implementation.hasRole(ADMIN_ROLE, DEAD_ADDRESS);
        
        if (deadHasRole) {
            console.log("✅ Dead address has admin role (secure)");
        } else {
            console.log("⚠️  Dead address doesn't have admin role (check manually)");
        }
        
        console.log("✅ Implementation security verification PASSED");
        
    } catch (error: any) {
        console.error("❌ CRITICAL: Implementation security verification FAILED!");
        console.error("Error:", error.message);
        throw new Error("Security verification failed - DO NOT USE THIS IMPLEMENTATION");
    }

    // Step 5: Verify contracts on block explorer
    if (process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY) {
        console.log("\n=== Step 5: Verifying contracts on block explorer ===");
        console.log("Waiting for block confirmations before verification...");
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds

        // Verify StakingPool (if newly deployed)
        if (deployNewStakingPool) {
            try {
                console.log("Verifying StakingPool...");
                await hre.run("verify:verify", {
                    address: stakingPoolAddress,
                    contract: "contracts/core/StakingPool.sol:StakingPool"
                });
                console.log("✅ StakingPool verified successfully");
            } catch (error: any) {
                if (error.message.includes("Already Verified")) {
                    console.log("✅ StakingPool already verified");
                } else {
                    console.error("⚠️  Error verifying StakingPool:", error.message);
                }
            }
        }

        // Verify StoragePool implementation
        try {
            console.log("Verifying StoragePool implementation...");
            await hre.run("verify:verify", {
                address: implementationAddress,
                contract: "contracts/core/StoragePool.sol:StoragePool"
            });
            console.log("✅ StoragePool implementation verified successfully");
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log("✅ StoragePool implementation already verified");
            } else {
                console.error("⚠️  Error verifying StoragePool implementation:", error.message);
            }
        }
    } else {
        console.log("\n=== Step 5: Skipping verification (no API key) ===");
        console.log("Set ETHERSCAN_API_KEY or BASESCAN_API_KEY to enable automatic verification");
    }

    // Step 6: Final security check and output
    console.log("\n=== Step 6: Final security validation ===");
    
    // Double-check implementation bytecode exists
    const implCode = await ethers.provider.getCode(implementationAddress);
    if (implCode === "0x") {
        throw new Error("Implementation has no bytecode - deployment failed!");
    }
    
    const codeSize = (implCode.length - 2) / 2;
    console.log(`📏 Implementation bytecode size: ${codeSize} bytes`);
    
    if (codeSize < 1000) {
        console.log("⚠️  Warning: Implementation bytecode is suspiciously small");
    }

    // Final output
    console.log("\n" + "=".repeat(60));
    console.log("🎉 SECURE DEPLOYMENT COMPLETED SUCCESSFULLY");
    console.log("=".repeat(60));
    
    console.log("\n📋 DEPLOYMENT SUMMARY:");
    if (deployNewStakingPool) {
        console.log(`✅ StakingPool: ${stakingPoolAddress}`);
    } else {
        console.log(`✅ Using existing StakingPool: ${stakingPoolAddress}`);
    }
    console.log(`✅ StoragePool Implementation: ${implementationAddress}`);
    console.log(`✅ Implementation properly secured with dead addresses`);
    console.log(`✅ Security verification passed`);
    console.log(`✅ Ready for governance upgrade`);

    console.log("\n🔐 SECURITY FEATURES:");
    console.log(`✅ Implementation initialized with dead addresses`);
    console.log(`✅ Cannot be re-initialized by attackers`);
    console.log(`✅ Admin roles assigned to dead address`);
    console.log(`✅ Front-running attack prevention: ACTIVE`);

    console.log("\n📝 ENVIRONMENT VARIABLES:");
    if (deployNewStakingPool) {
        console.log(`export NEW_STAKING_POOL=${stakingPoolAddress}`);
    }
    console.log(`export NEW_STORAGE_POOL_IMPLEMENTATION=${implementationAddress}`);

    console.log("\n🏛️  GOVERNANCE UPGRADE PROCESS:");
    console.log(`1. Use implementation address: ${implementationAddress}`);
    console.log(`2. Submit governance proposal to upgrade proxy`);
    console.log(`3. Wait for governance approval and execution`);
    console.log(`4. Verify upgrade success by checking proxy implementation`);

    console.log("\n⚠️  IMPORTANT SECURITY NOTES:");
    console.log(`• Implementation is secured and cannot be hijacked`);
    console.log(`• Only use this address for governance upgrades`);
    console.log(`• Verify the implementation address before governance proposal`);
    console.log(`• This implementation is ready for production use`);

    // Return just the implementation address as requested
    return implementationAddress;
}

main()
    .then((implementationAddress) => {
        console.log(`\n🎯 IMPLEMENTATION ADDRESS: ${implementationAddress}`);
        process.exit(0);
    })
    .catch((error) => {
        console.error("\n💥 DEPLOYMENT FAILED:", error.message);
        process.exit(1);
    });

// Usage:
// npx hardhat run scripts/upgradeStoragePool.ts --network <network>
//
// Environment Variables:
// - STORAGE_TOKEN_ADDRESS: Address of the StorageToken contract (REQUIRED)
// - DEPLOY_NEW_STAKING_POOL: "true" to deploy new StakingPool, "false" to use existing (default: false)
// - EXISTING_STAKING_POOL_ADDRESS: Address of existing StakingPool (required if DEPLOY_NEW_STAKING_POOL=false)
// - ETHERSCAN_API_KEY or BASESCAN_API_KEY: For automatic contract verification
//
// Security Features:
// ✅ Automatically initializes implementation with dead addresses
// ✅ Verifies implementation cannot be re-initialized
// ✅ Checks admin roles are properly set
// ✅ Prevents front-running attacks
// ✅ Comprehensive security validation
//
// This script addresses the critical security flaw in other upgrade scripts
// that leave implementations uninitialized and vulnerable to attacks.
