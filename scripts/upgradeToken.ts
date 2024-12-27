import { ethers, upgrades } from "hardhat";

async function main() {
    const PROXY_ADDRESS = process.env.PROXY_ADDRESS?.trim();
    if (!PROXY_ADDRESS) {
        throw new Error("PROXY_ADDRESS environment variable not set");
    }

    console.log("Upgrading StorageToken...");
    
    // Get the contract factory for the new implementation
    const StorageTokenV1 = await ethers.getContractFactory("StorageTokenV1");
    
    // Upgrade the proxy to use the new implementation
    const upgraded = await upgrades.upgradeProxy(PROXY_ADDRESS, StorageTokenV1);
    
    await upgraded.waitForDeployment();
    console.log("StorageToken upgraded to:", await upgraded.getAddress());
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// set PROXY_ADDRESS=0xFd3F71338f422B518e9eb6A76fF0D32093cD5fc8 && yarn hardhat run scripts/upgradeToken.ts --network sepolia