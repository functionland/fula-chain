import { ethers, upgrades } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Upgrading contracts with the account:", deployer.address);

    // Validate environment variables
    const proxyAddress = process.env.PROXY_ADDRESS?.trim();
    if (!proxyAddress) {
        throw new Error("PROXY_ADDRESS environment variable not set");
    }

    // Get the contract factory for the new implementation
    const ContractFactory = await ethers.getContractFactory("StorageTokenV1");
    console.log("Preparing upgrade...");

    // Deploy new implementation and upgrade proxy
    const upgradedContract = await upgrades.upgradeProxy(
        proxyAddress,
        ContractFactory,
        {
            kind: "uups",
            unsafeAllow: ["constructor"]
        }
    );

    await upgradedContract.waitForDeployment();
    const newImplementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log("Proxy address:", proxyAddress);
    console.log("New implementation address:", newImplementationAddress);
    console.log("Upgrade complete");

    // Verify the new implementation
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("Waiting for 6 block confirmations before verification...");
        await upgradedContract.deploymentTransaction()?.wait(6);

        await hre.run("verify:verify", {
            address: newImplementationAddress,
            contract: "contracts/StorageToken.sol:StorageToken"
        });
    }

    // Save deployment info
    console.log("\nUpgrade addresses for reference:");
    console.log(`export NEW_IMPLEMENTATION=${newImplementationAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to run:
// PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade.ts --network sepolia
