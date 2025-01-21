import { ethers, upgrades } from "hardhat";
import { StorageToken } from "../typechain-types";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);

    // Get the contract factory
    const StorageToken = await ethers.getContractFactory("StorageToken");
    console.log("Deploying StorageToken...");

    // Validate environment variables
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
    const initialMintedTokens = TOTAL_SUPPLY;

    // Deploy the proxy contract
    const storageToken = await upgrades.deployProxy(
        StorageToken,
        [initialOwner, initialAdmin, initialMintedTokens],
        {
            initializer: "initialize",
            kind: "uups",
            unsafeAllow: ["constructor"]
        }
    ) as StorageToken;

    await storageToken.waitForDeployment();
    const tokenAddress = await storageToken.getAddress();

    // Get the implementation address
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(tokenAddress);

    console.log("StorageToken proxy deployed to:", tokenAddress);
    console.log("Implementation address:", implementationAddress);
    console.log("Initial owner:", initialOwner);
    console.log("Initial admin:", initialAdmin);
    console.log("Initial minted tokens:", ethers.formatEther(initialMintedTokens), "tokens");

    // Verify contracts
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("Waiting for 6 block confirmations before verification...");
        await storageToken.deploymentTransaction()?.wait(6);

        // Verify implementation
        await hre.run("verify:verify", {
            address: implementationAddress,
            contract: "contracts/StorageToken.sol:StorageToken"
        });
    }

    // Save deployment info
    console.log("\nDeployment addresses for subsequent deployments:");
    console.log(`export TOKEN_ADDRESS=${tokenAddress}`);
    console.log(`export TOKEN_IMPLEMENTATION=${implementationAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to run:
// INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/deployToken.ts --network sepolia
// npx hardhat verify <contract_address> --network sepolia
// npx hardhat verify --contract contracts/StorageToken.sol:StorageToken <proxy_address> --network sepolia