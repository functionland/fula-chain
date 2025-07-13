import { ethers } from "hardhat";
import hre from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying StoragePoolLib library with account:", deployer.address);

    // Force compilation with viaIR
    await hre.run("compile", { force: true });
    console.log("✅ Contracts compiled successfully with viaIR");

    try {
        // Get contract factory
        const StoragePoolLib = await ethers.getContractFactory("StoragePoolLib");
        console.log("Contract factory created successfully");

        // Deploy library
        console.log("Deploying library...");
        const deployTx = await StoragePoolLib.deploy();
        console.log("Deployment transaction hash:", deployTx.deploymentTransaction()?.hash);

        // Wait for deployment
        const receipt = await deployTx.deploymentTransaction()?.wait();
        console.log("✅ Library deployed successfully!");
        console.log("Contract address:", receipt?.contractAddress);
        console.log("Block number:", receipt?.blockNumber);
        console.log("Gas used:", receipt?.gasUsed?.toString());

        // Manual verification command
        console.log("\n=== Manual Verification Command ===");
        console.log(`npx hardhat verify ${receipt?.contractAddress} --contract contracts/libraries/StoragePoolLib.sol:StoragePoolLib --network ${hre.network.name}`);

    } catch (error) {
        console.error("Deployment failed:", error);
        
        // If it's the ethers error, the contract might still be deployed
        if (error instanceof Error && error.message.includes("invalid value for value.to")) {
            console.log("\n⚠️  The contract might still be deployed despite the error.");
            console.log("Check the transaction hash in the blockchain explorer.");
        }
        
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
// npx hardhat run scripts/StoragePool/deployStoragePoolLibSimple.ts --network base
