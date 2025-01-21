import { ethers, upgrades } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);

    // Get the contract factory
    const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
    console.log("Deploying TokenDistributionEngine...");

    // Validate environment variables
    const storageTokenAddress = process.env.TOKEN_ADDRESS?.trim();
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    const initialAdmin = process.env.INITIAL_ADMIN?.trim();

    if (!storageTokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }
    if (!initialOwner) {
        throw new Error("INITIAL_OWNER environment variable not set");
    }
    if (!initialAdmin) {
        throw new Error("INITIAL_ADMIN environment variable not set");
    }

    // Deploy the proxy contract
    const distributionEngine = await upgrades.deployProxy(
        TokenDistributionEngine,
        [storageTokenAddress, initialOwner, initialAdmin],
        {
            initializer: "initialize",
            kind: "uups",
            unsafeAllow: ["constructor"]
        }
    );

    await distributionEngine.waitForDeployment();
    const engineAddress = await distributionEngine.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(engineAddress);

    console.log("TokenDistributionEngine proxy deployed to:", engineAddress);
    console.log("Implementation address:", implementationAddress);
    console.log("Storage token address:", storageTokenAddress);
    console.log("Initial owner:", initialOwner);
    console.log("Initial admin:", initialAdmin);

    // Verify contracts
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("Waiting for 6 block confirmations before verification...");
        await distributionEngine.deploymentTransaction()?.wait(6);

        await hre.run("verify:verify", {
            address: implementationAddress,
            contract: "contracts/governance/TokenDistributionEngine.sol:TokenDistributionEngine"
        });
    }

    // Save deployment info
    console.log("\nDeployment addresses for subsequent deployments:");
    console.log(`export DISTRIBUTION_ENGINE_ADDRESS=${engineAddress}`);
    console.log(`export DISTRIBUTION_ENGINE_IMPLEMENTATION=${implementationAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to run:
// TOKEN_ADDRESS=Token_Proxy_address INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/deployTokenDistributionEngine.ts --network sepolia
// npx hardhat verify <contract_address> --network sepolia
// npx hardhat verify --contract contracts/TokenDistributionEngine.sol:TokenDistributionEngine <proxy_address> --network sepolia
