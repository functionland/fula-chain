import { ethers } from "hardhat";
import * as hre from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying new TestnetMiningRewards implementation with the account:", deployer.address);

    // Get the contract factory
    const TestnetMiningRewards = await ethers.getContractFactory("TestnetMiningRewards");
    
    // Deploy the implementation directly (not through upgrades plugin)
    console.log("Deploying new implementation...");
    const implementation = await TestnetMiningRewards.deploy();
    await implementation.waitForDeployment();
    
    const implementationAddress = await implementation.getAddress();
    console.log("New implementation address:", implementationAddress);
    console.log("Implementation deployment complete");

    // Verify the implementation
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("Waiting for block confirmations before verification...");
        // Wait for a few blocks to ensure the contract is deployed
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds

        await hre.run("verify:verify", {
            address: implementationAddress,
            contract: "contracts/core/TestnetMiningRewards.sol:TestnetMiningRewards"
        });
    }

    // Save deployment info
    console.log("\nImplementation address for reference:");
    console.log(`export NEW_IMPLEMENTATION=${implementationAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to deploy new implementation:
// npx hardhat run scripts/upgradeTestnetMining.ts --network sepolia
// Note: Contract verification is handled automatically if ETHERSCAN_API_KEY environment variable is set
