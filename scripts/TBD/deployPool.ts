import { ethers, upgrades } from "hardhat";

async function main() {
    const tokenAddress = process.env.TOKEN_ADDRESS?.trim();
    if (!tokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }

    // Specify the initial owner address
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    if (!initialOwner) {
        throw new Error("INITIAL_OWNER environment variable not set");
    }

    const StoragePool = await ethers.getContractFactory("StoragePool");
    console.log("Deploying StoragePool...");

    // Pass both tokenAddress and initialOwner to the initializer
    const storagePool = await upgrades.deployProxy(StoragePool, [tokenAddress, initialOwner], {
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



// set TOKEN_ADDRESS=0xed1211C59554c301FBaA2F4ebBD9DF91a21F7E47 && yarn hardhat run scripts/deployPool.ts --network sepolia --show-stack-traces
// yarn hardhat verify --network sepolia 0x...