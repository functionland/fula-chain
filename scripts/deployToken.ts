import { ethers, upgrades } from "hardhat";
import { StorageToken } from "../typechain-types";
import * as readline from "readline";

// Function to create a readline interface for user input
function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

// Function to prompt for user confirmation
function waitForUserConfirmation(message: string): Promise<void> {
  const rl = createInterface();
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

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
    const TOTAL_SUPPLY = ethers.parseEther("0"); // 2 billion tokens
    const initialMintedTokens = TOTAL_SUPPLY;

    // Get current account balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Current account balance: ${ethers.formatEther(balance)} ETH`);

    // Estimate gas for deployment
    console.log("Estimating gas for deployment...");
    
    try {
        // Get gas price
        const feeData = await ethers.provider.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.parseUnits("50", "gwei"); // Fallback gas price
        
        // Get the bytecode for the implementation contract
        const deployTxFactory = StorageToken.getDeployTransaction();
        const implementationGas = await ethers.provider.estimateGas(deployTxFactory);
        
        // Proxy deployment typically costs more than regular deployments
        // This is a rough estimate that includes both implementation and proxy deployment
        const proxyDeploymentGas = implementationGas * BigInt(3); // Conservative estimate
        
        // Calculate total estimated gas cost in ETH
        const estimatedGasCost = proxyDeploymentGas * BigInt(gasPrice);
        
        console.log(`Estimated implementation gas: ${implementationGas.toString()}`);
        console.log(`Estimated total gas (with proxy): ${proxyDeploymentGas.toString()}`);
        console.log(`Current gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
        console.log(`Estimated deployment cost: ${ethers.formatEther(estimatedGasCost)} ETH`);
        
        // Check if the account has enough balance
        if (balance < BigInt(estimatedGasCost)) {
            console.warn(`WARNING: Account balance (${ethers.formatEther(balance)} ETH) might be insufficient for deployment!`);
        }
    } catch (error) {
        console.warn("Failed to estimate gas accurately:", error);
        console.warn("Proceeding with deployment will require manual gas estimation");
    }

    // Wait for user confirmation
    await waitForUserConfirmation("\nPress Enter to continue with deployment or Ctrl+C to abort...");

    // Deploy the proxy contract
    console.log("Deploying contract...");
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
    console.log(`export TOKEN_ADDRESS(proxy)=${tokenAddress}`);
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