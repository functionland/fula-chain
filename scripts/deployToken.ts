import { ethers, upgrades } from "hardhat";

async function main() {
    const StorageToken = await ethers.getContractFactory("StorageToken");
    console.log("Deploying StorageToken...");
    
    const storageToken = await upgrades.deployProxy(StorageToken, [], {
        initializer: "initialize",
        kind: "uups"
    });
    
    await storageToken.waitForDeployment();
    const tokenAddress = await storageToken.getAddress();
    console.log("StorageToken deployed to:", tokenAddress);
    
    // Save the address for other deployments
    console.log(`Please set TOKEN_ADDRESS=${tokenAddress} for subsequent deployments`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});


// yarn hardhat run scripts/deployToken.ts --network sepolia --show-stack-traces
// yarn hardhat verify --network sepolia 0xFd3F71338f422B518e9eb6A76fF0D32093cD5fc8