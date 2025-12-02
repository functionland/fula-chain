import { ethers, upgrades } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// Import hardhat globally for verification
declare const hre: HardhatRuntimeEnvironment;

/**
 * RewardEngine Implementation Upgrade Script
 * 
 * This script:
 * 1. Deploys a NEW RewardEngine implementation contract (not a proxy)
 * 2. Secures the implementation by initializing it (prevents front-running attacks)
 * 3. Verifies the implementation on block explorer
 * 4. Outputs the implementation address for use in governance upgrade proposal
 * 
 * IMPORTANT: After running this script, you must:
 * 1. Create an Upgrade proposal via governance with the new implementation address
 * 2. Get the required approvals (quorum >= 2)
 * 3. Wait for the execution delay
 * 4. Execute the upgrade via governance
 * 
 * The proxy address remains unchanged - only the implementation is upgraded.
 */

async function waitForUserConfirmation(message: string): Promise<void> {
    console.log(message);
    return new Promise((resolve) => {
        process.stdin.once('data', () => {
            resolve();
        });
    });
}

async function verifyWithTimeout(contractAddress: string, constructorArgs: any[] = [], timeoutMs: number = 60000): Promise<void> {
    return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => {
            console.log(`⏰ Verification timeout (${timeoutMs/1000}s) reached for ${contractAddress}`);
            resolve(); // Resolve instead of reject to continue
        }, timeoutMs);

        try {
            await hre.run("verify:verify", {
                address: contractAddress,
                constructorArguments: constructorArgs
            });
            clearTimeout(timeout);
            resolve();
        } catch (error: any) {
            clearTimeout(timeout);
            if (error.message.includes("Already Verified") || 
                error.message.includes("already verified")) {
                console.log("✅ Contract already verified");
                resolve();
            } else {
                reject(error);
            }
        }
    });
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log("🚀 REWARDENGINE IMPLEMENTATION UPGRADE");
    console.log("=".repeat(50));
    console.log("This script deploys a NEW implementation contract.");
    console.log("The proxy will be upgraded via governance proposal.\n");
    
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
    console.log("Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

    // Environment variables
    const proxyAddress = process.env.PROXY_ADDRESS?.trim();
    const storageTokenAddress = process.env.TOKEN_ADDRESS?.trim();
    const storagePoolAddress = process.env.STORAGE_POOL_ADDRESS?.trim();
    const stakingPoolAddress = process.env.STAKING_POOL_ADDRESS?.trim();

    console.log("\nConfiguration:");
    console.log("- Proxy Address (existing):", proxyAddress || "Not provided");
    console.log("- Storage Token:", storageTokenAddress || "Not provided");
    console.log("- Storage Pool:", storagePoolAddress || "Not provided");
    console.log("- Staking Pool:", stakingPoolAddress || "Not provided");

    // Validate required parameters
    if (!proxyAddress) {
        throw new Error("PROXY_ADDRESS environment variable is required (existing RewardEngine proxy address)");
    }

    // Validate proxy address is a contract
    console.log("\nValidating proxy address...");
    const proxyCode = await ethers.provider.getCode(proxyAddress);
    if (proxyCode === "0x") {
        throw new Error(`No contract found at proxy address ${proxyAddress}`);
    }
    console.log("✅ Proxy address validated");

    // Get current implementation address for reference
    console.log("\nGetting current implementation address...");
    let currentImplAddress: string;
    try {
        currentImplAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
        console.log("Current implementation:", currentImplAddress);
    } catch (error) {
        console.warn("⚠️  Could not get current implementation address");
        currentImplAddress = "unknown";
    }

    // Get contract factory
    const RewardEngine = await ethers.getContractFactory("RewardEngine");

    // Estimate gas costs
    console.log("\nEstimating deployment costs...");
    const deploymentData = RewardEngine.interface.encodeDeploy([]);
    const gasEstimate = await ethers.provider.estimateGas({
        data: deploymentData
    });
    const gasPrice = await ethers.provider.getFeeData();
    const estimatedCost = gasEstimate * (gasPrice.gasPrice || 0n);
    console.log("Estimated gas:", gasEstimate.toString());
    console.log("Estimated cost:", ethers.formatEther(estimatedCost), "ETH");

    // Check deployer balance
    const deployerBalance = await ethers.provider.getBalance(deployer.address);
    if (deployerBalance < estimatedCost * 2n) {
        console.warn("⚠️  Warning: Deployer balance may be insufficient for deployment");
    }

    await waitForUserConfirmation("\nPress Enter to deploy new implementation or Ctrl+C to cancel...");

    try {
        // Deploy new implementation using OpenZeppelin's deployImplementation
        // This ensures the implementation is compatible with UUPS proxy pattern
        console.log("\n📦 Deploying new RewardEngine implementation...");
        
        const newImplAddress = await upgrades.deployImplementation(RewardEngine, {
            kind: "uups",
            timeout: 120000
        }) as string;
        
        console.log("✅ New implementation deployed to:", newImplAddress);

        // CRITICAL SECURITY: Initialize the implementation to prevent front-running attacks
        console.log("\n🔒 SECURING IMPLEMENTATION CONTRACT...");
        console.log("Initializing implementation to prevent front-running/backdoor attacks...");

        try {
            const newImpl = await ethers.getContractAt("RewardEngine", newImplAddress);

            // Get addresses from environment or use proxy address as dummy
            const tokenAddr = storageTokenAddress || proxyAddress;
            const storagePoolAddr = storagePoolAddress || proxyAddress;
            const stakingPoolAddr = stakingPoolAddress || proxyAddress;

            // Initialize with dummy values (proxy addresses) to secure the implementation
            // This prevents attackers from initializing it with malicious values
            const initTx = await newImpl.initialize(
                tokenAddr,           // _token
                storagePoolAddr,     // _storagePool
                stakingPoolAddr,     // _stakingPool
                newImplAddress,      // initialOwner (use impl address as dummy - can't be used anyway)
                newImplAddress       // initialAdmin (use impl address as dummy - can't be used anyway)
            );
            await initTx.wait();
            console.log("✅ Implementation secured (initialized with dummy values)");
        } catch (error: any) {
            if (error.message.includes("already initialized") ||
                error.message.includes("InvalidInitialization")) {
                console.log("✅ Implementation was already initialized (secured)");
            } else {
                console.warn("⚠️  Failed to secure implementation automatically");
                console.warn("Error:", error.message);
                console.log("\n📋 MANUAL SECURITY REQUIRED:");
                console.log("Please initialize the implementation manually to prevent attacks:");
                console.log(`Implementation address: ${newImplAddress}`);
            }
        }

        // Verify implementation on block explorer
        console.log("\n📋 VERIFYING IMPLEMENTATION ON BLOCK EXPLORER...");
        console.log("⏳ Waiting 10 seconds for deployment to propagate...");
        await delay(10000);

        try {
            await verifyWithTimeout(newImplAddress, [], 60000);
            console.log("✅ Implementation verified on block explorer");
        } catch (error: any) {
            console.warn("⚠️  Verification failed:", error.message);
            console.log("You can verify manually later using:");
            console.log(`npx hardhat verify --network <network> ${newImplAddress}`);
        }

        // Output summary
        console.log("\n" + "=".repeat(60));
        console.log("📋 IMPLEMENTATION DEPLOYMENT SUMMARY");
        console.log("=".repeat(60));
        console.log("Proxy Address (unchanged):", proxyAddress);
        console.log("Current Implementation:", currentImplAddress);
        console.log("NEW Implementation:", newImplAddress);
        console.log("=".repeat(60));

        console.log("\n📋 NEXT STEPS FOR GOVERNANCE UPGRADE:");
        console.log("=".repeat(60));
        console.log("1. Create an Upgrade proposal via governance:");
        console.log(`   - Target: ${newImplAddress}`);
        console.log("   - Proposal Type: Upgrade");
        console.log("");
        console.log("2. Get required approvals (quorum >= 2 for ADMIN_ROLE)");
        console.log("");
        console.log("3. Wait for execution delay to pass");
        console.log("");
        console.log("4. Execute the upgrade - the proxy will call:");
        console.log(`   upgradeToAndCall(${newImplAddress}, "")`);
        console.log("");
        console.log("5. Verify the upgrade was successful:");
        console.log(`   - Check implementation: await upgrades.erc1967.getImplementationAddress("${proxyAddress}")`);
        console.log(`   - Should return: ${newImplAddress}`);
        console.log("=".repeat(60));

        // Save deployment info to file
        const deploymentInfo = {
            timestamp: new Date().toISOString(),
            network: hre.network.name,
            deployer: deployer.address,
            proxyAddress: proxyAddress,
            previousImplementation: currentImplAddress,
            newImplementation: newImplAddress,
            status: "PENDING_GOVERNANCE_UPGRADE"
        };

        const fs = require('fs');
        const path = require('path');
        const deploymentsDir = path.join(__dirname, '../../deployments');
        if (!fs.existsSync(deploymentsDir)) {
            fs.mkdirSync(deploymentsDir, { recursive: true });
        }
        const filename = `RewardEngine_upgrade_${hre.network.name}_${Date.now()}.json`;
        fs.writeFileSync(
            path.join(deploymentsDir, filename),
            JSON.stringify(deploymentInfo, null, 2)
        );
        console.log(`\n📁 Deployment info saved to: deployments/${filename}`);

        console.log("\n✅ IMPLEMENTATION DEPLOYMENT COMPLETED!");
        console.log("⚠️  Remember: The proxy is NOT upgraded yet. Complete the governance process.");

    } catch (error) {
        console.error("❌ Deployment failed:", error);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Usage:
//
// Required environment variables:
// - PROXY_ADDRESS: The existing RewardEngine proxy address
//
// Optional environment variables (for securing implementation):
// - TOKEN_ADDRESS: StorageToken address (uses proxy as dummy if not provided)
// - STORAGE_POOL_ADDRESS: StoragePool address (uses proxy as dummy if not provided)
// - STAKING_POOL_ADDRESS: StakingPool address (uses proxy as dummy if not provided)
//
// Example:
// set PROXY_ADDRESS=0x1234...
// set TOKEN_ADDRESS=0x9e12735d77c72c5C3670636D428f2F3815d8A4cB
// set STORAGE_POOL_ADDRESS=0xf293A6902662DcB09E310254A5e418cb28D71b6b
// set STAKING_POOL_ADDRESS=0x5678...
// npx hardhat run scripts/RewardEngine/upgradeRewardEngineImplementation.ts --network base
//
// After deployment, create governance proposal to upgrade:
// 1. Call createProposal with type=Upgrade and target=newImplementationAddress
// 2. Get approvals from ADMIN_ROLE holders
// 3. Execute after timelock period
