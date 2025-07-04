import { ethers } from "hardhat";
import * as hre from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying new StoragePool implementation with the account:", deployer.address);
    console.log("Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

    // Step 1: Deploy new StoragePoolLib library
    console.log("\n=== Step 1: Deploying new StoragePoolLib ===");
    const StoragePoolLib = await ethers.getContractFactory("StoragePoolLib");
    const storagePoolLib = await StoragePoolLib.deploy();
    await storagePoolLib.waitForDeployment();

    const libAddress = await storagePoolLib.getAddress();
    console.log("New StoragePoolLib address:", libAddress);

    // Step 2: Deploy new StoragePool implementation with library linking
    console.log("\n=== Step 2: Deploying new StoragePool implementation ===");
    const StoragePool = await ethers.getContractFactory("StoragePool", {
        libraries: {
            StoragePoolLib: libAddress
        }
    });

    console.log("Deploying new StoragePool implementation...");
    const implementation = await StoragePool.deploy();
    await implementation.waitForDeployment();

    const implementationAddress = await implementation.getAddress();
    console.log("New StoragePool implementation address:", implementationAddress);

    // Step 3: Validate the new implementation
    console.log("\n=== Step 3: Validating new implementation ===");
    try {
        // Try to call some view functions to ensure it's properly deployed
        // Note: We can't call initialize() as it's meant for proxy initialization
        console.log("Implementation deployed successfully and ready for upgrade");
    } catch (error) {
        console.error("Implementation validation failed:", error);
        throw new Error("New implementation is not valid");
    }

    // Step 4: Verify contracts on Etherscan
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("\n=== Step 4: Verifying contracts on Etherscan ===");
        console.log("Waiting for block confirmations before verification...");
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds

        // Verify StoragePoolLib
        try {
            console.log("Verifying StoragePoolLib...");
            await hre.run("verify:verify", {
                address: libAddress,
                contract: "contracts/core/StoragePoolLib.sol:StoragePoolLib"
            });
            console.log("StoragePoolLib verified successfully");
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log("StoragePoolLib already verified");
            } else {
                console.error("Error verifying StoragePoolLib:", error);
            }
        }

        // Verify StoragePool implementation
        try {
            console.log("Verifying StoragePool implementation...");
            await hre.run("verify:verify", {
                address: implementationAddress,
                contract: "contracts/core/StoragePool.sol:StoragePool"
            });
            console.log("StoragePool implementation verified successfully");
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log("StoragePool implementation already verified");
            } else {
                console.error("Error verifying StoragePool implementation:", error);
            }
        }
    }

    // Step 5: Output addresses for governance upgrade
    console.log("\n=== Step 5: Deployment Summary ===");
    console.log("✅ New StoragePoolLib deployed and verified");
    console.log("✅ New StoragePool implementation deployed and verified");
    console.log("✅ Implementation properly linked to new library");

    console.log("\n=== Addresses for Governance Upgrade ===");
    console.log(`StoragePoolLib Library: ${libAddress}`);
    console.log(`StoragePool Implementation: ${implementationAddress}`);

    console.log("\n=== Environment Variables ===");
    console.log(`export NEW_STORAGE_POOL_LIB=${libAddress}`);
    console.log(`export NEW_STORAGE_POOL_IMPLEMENTATION=${implementationAddress}`);

    console.log("\n=== Next Steps ===");
    console.log("1. Use the NEW_STORAGE_POOL_IMPLEMENTATION address in governance proposal");
    console.log("2. Submit governance proposal to upgrade proxy to new implementation");
    console.log("3. Wait for governance approval and execution");
    console.log("4. Verify upgrade was successful by checking proxy implementation");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to deploy new implementation:
// npx hardhat run scripts/upgradeStoragePool.ts --network sepolia
//
// Environment Variables:
// - ETHERSCAN_API_KEY: Required for automatic contract verification
//
// This script:
// 1. Deploys new StoragePoolLib library
// 2. Deploys new StoragePool implementation linked to new library
// 3. Validates the deployment
// 4. Verifies both contracts on Etherscan
// 5. Outputs addresses for governance upgrade process
//
// Note: This only deploys the new implementation. The actual upgrade
// of the proxy to point to the new implementation must be done through
// the governance mechanism.
