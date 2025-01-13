import { ethers, upgrades } from "hardhat";

async function main() {
    const StorageToken = await ethers.getContractFactory("StorageToken");
    console.log("Deploying StorageToken...");

    // Specify the initial owner and admin addresses
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    const initialAdmin = process.env.INITIAL_ADMIN?.trim();
    if (!initialOwner) {
        throw new Error("INITIAL_OWNER environment variable not set");
    }
    if (!initialAdmin) {
        throw new Error("INITIAL_ADMIN environment variable not set");
    }

    // Calculate initial minted tokens (half of total supply)
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const initialMintedTokens = TOTAL_SUPPLY / BigInt(2);

    const storageToken = await upgrades.deployProxy(StorageToken, [
        initialOwner,
        initialAdmin,
        initialMintedTokens
    ], {
        initializer: "initialize",
        kind: "uups"
    });

    await storageToken.waitForDeployment();
    const tokenAddress = await storageToken.getAddress();
    console.log("StorageToken deployed to:", tokenAddress);
    console.log("Initial owner:", initialOwner);
    console.log("Initial admin:", initialAdmin);
    console.log("Initial minted tokens:", ethers.formatEther(initialMintedTokens), "tokens");

    // Save the address for other deployments
    console.log(`Please set TOKEN_ADDRESS=${tokenAddress} for subsequent deployments`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// Command to run:
// set INITIAL_OWNER=0x... && set INITIAL_ADMIN=0x... && yarn hardhat run scripts/deployToken.ts --network sepolia --show-stack-traces
// yarn hardhat verify --network sepolia CONTRACT_ADDRESS