import { ethers, upgrades } from "hardhat";
import { StorageToken, TokenDistributionEngine } from "../typechain-types";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);

    // First get the StorageToken address - assuming it's already deployed
    const storageTokenAddress = "STORAGE_TOKEN_ADDRESS_HERE"; // Replace with actual address
    
    console.log("StorageToken address:", storageTokenAddress);

    // Deploy TokenDistributionEngine
    console.log("Deploying TokenDistributionEngine...");
    const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
    
    const tokenDistributionEngine = await upgrades.deployProxy(
        TokenDistributionEngine,
        [
            storageTokenAddress,
            deployer.address, // owner
            deployer.address  // admin - can be different address if needed
        ],
        {
            kind: 'uups',
            initializer: 'initialize'
        }
    );

    await tokenDistributionEngine.waitForDeployment();
    console.log("TokenDistributionEngine deployed to:", await tokenDistributionEngine.getAddress());

    // Verify contract on Etherscan
    console.log("Verifying contract on Etherscan...");
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(
        await tokenDistributionEngine.getAddress()
    );
    
    try {
        await run("verify:verify", {
            address: implementationAddress,
            constructorArguments: []
        });
        console.log("Contract verified on Etherscan");
    } catch (error) {
        console.log("Error verifying contract:", error);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// npx hardhat run scripts/deploy-distribution.ts --network <your-network>