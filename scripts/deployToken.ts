import { ethers, upgrades } from "hardhat";

async function main() {
    const StorageToken = await ethers.getContractFactory("StorageToken");
    console.log("Deploying StorageToken...");

    // Specify the initial owner address
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    if (!initialOwner) {
        throw new Error("INITIAL_OWNER environment variable not set");
    }

    const storageToken = await upgrades.deployProxy(StorageToken, [initialOwner], {
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

// set INITIAL_OWNER=0x7cCd79636f39eeCC7D39F11E959b2928069b8D2D && yarn hardhat run scripts/deployToken.ts --network sepolia --show-stack-traces
// yarn hardhat verify --network sepolia 0xed1211C59554c301FBaA2F4ebBD9DF91a21F7E47