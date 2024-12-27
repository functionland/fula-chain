import { ethers, upgrades } from "hardhat";

async function main() {
    const tokenAddress = process.env.TOKEN_ADDRESS?.trim();
    if (!tokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }

    const StoragePool = await ethers.getContractFactory("StoragePool");
    console.log("Deploying StoragePool...");
    
    const storagePool = await upgrades.deployProxy(StoragePool, [tokenAddress], {
        initializer: "initialize",
        kind: "uups"
    });
    
    await storagePool.waitForDeployment();
    const poolAddress = await storagePool.getAddress();
    console.log("StoragePool deployed to:", poolAddress);

    // Get token contract instance and add pool as authorized contract
    const StorageToken = await ethers.getContractFactory("StorageToken");
    const token = StorageToken.attach(tokenAddress);
    const addPoolTx = await token.addPoolContract(poolAddress);
    await addPoolTx.wait();
    console.log("Pool contract authorized in token contract");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});


// set TOKEN_ADDRESS=0xFd3F71338f422B518e9eb6A76fF0D32093cD5fc8 && yarn hardhat run scripts/deployPool.ts --network sepolia --show-stack-traces
// yarn hardhat verify --network sepolia 0xe91214431dbf3279c27062611df162c16fd35230