import { ethers } from "hardhat";

async function main() {
    // Get environment variables
    const proxyAddress = process.env.STORAGE_POOL_PROXY;
    const expectedImplementationAddress = process.env.EXPECTED_IMPLEMENTATION;

    if (!proxyAddress) {
        throw new Error("STORAGE_POOL_PROXY environment variable is required");
    }

    if (!expectedImplementationAddress) {
        throw new Error("EXPECTED_IMPLEMENTATION environment variable is required");
    }

    console.log("=== Validating StoragePool Upgrade ===");
    console.log(`Proxy Address: ${proxyAddress}`);
    console.log(`Expected Implementation: ${expectedImplementationAddress}`);

    // Get the current implementation address from the proxy
    const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const currentImplementationHex = await ethers.provider.getStorage(proxyAddress, implementationSlot);
    const currentImplementationAddress = ethers.getAddress("0x" + currentImplementationHex.slice(-40));

    console.log(`Current Implementation: ${currentImplementationAddress}`);

    // Check if upgrade was successful
    if (currentImplementationAddress.toLowerCase() === expectedImplementationAddress.toLowerCase()) {
        console.log("✅ Upgrade successful! Implementation address matches expected address.");
    } else {
        console.log("❌ Upgrade failed! Implementation address does not match expected address.");
        process.exit(1);
    }

    // Test basic functionality
    console.log("\n=== Testing Basic Functionality ===");
    try {
        const StoragePool = await ethers.getContractFactory("StoragePool");
        const storagePool = StoragePool.attach(proxyAddress);

        // Test some basic view functions
        const tokenAddress = await storagePool.token();
        const poolCounter = await storagePool.poolCounter();
        const poolCreationTokens = await storagePool.dataPoolCreationTokens();

        console.log(`Token Address: ${tokenAddress}`);
        console.log(`Pool Counter: ${poolCounter}`);
        console.log(`Pool Creation Tokens: ${ethers.formatEther(poolCreationTokens)}`);

        console.log("✅ Basic functionality test passed!");
    } catch (error) {
        console.error("❌ Basic functionality test failed:", error);
        process.exit(1);
    }

    console.log("\n✅ StoragePool upgrade validation completed successfully!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to validate upgrade:
// STORAGE_POOL_PROXY=<proxy_address> EXPECTED_IMPLEMENTATION=<new_implementation_address> npx hardhat run scripts/validateStoragePoolUpgrade.ts --network sepolia
//
// This script validates that:
// 1. The proxy is pointing to the expected new implementation
// 2. Basic functionality still works after upgrade
