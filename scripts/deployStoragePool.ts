import { ethers, upgrades } from "hardhat";
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

    // Deploy StoragePoolLib library first
    console.log("Deploying StoragePoolLib library...");
    const StoragePoolLib = await ethers.getContractFactory("StoragePoolLib");
    const storagePoolLib = await StoragePoolLib.deploy();
    await storagePoolLib.waitForDeployment();
    const libAddress = await storagePoolLib.getAddress();
    console.log("StoragePoolLib deployed to:", libAddress);

    // Get the contract factory with library linking
    const StoragePool = await ethers.getContractFactory("StoragePool", {
        libraries: {
            StoragePoolLib: libAddress
        }
    });
    console.log("Deploying StoragePool...");

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

    // Validate that the token address is a valid contract
    console.log("Validating StorageToken contract...");
    try {
        const StorageToken = await ethers.getContractFactory("StorageToken");
        const storageToken = StorageToken.attach(storageTokenAddress);
        
        // Try to call a view function to verify it's a valid StorageToken contract
        const tokenName = await storageToken.name();
        const tokenSymbol = await storageToken.symbol();
        console.log(`Connected to StorageToken: ${tokenName} (${tokenSymbol})`);
        console.log(`Token contract address: ${storageTokenAddress}`);
    } catch (error) {
        console.error("Failed to validate StorageToken contract:", error);
        throw new Error("Invalid TOKEN_ADDRESS - not a valid StorageToken contract");
    }

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
        const deployTxFactory = StoragePool.getDeployTransaction();
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

    // Display deployment parameters
    console.log("\n=== Deployment Parameters ===");
    console.log(`StorageToken Address: ${storageTokenAddress}`);
    console.log(`Initial Owner: ${initialOwner}`);
    console.log(`Initial Admin: ${initialAdmin}`);
    console.log(`Deployer: ${deployer.address}`);

    // Wait for user confirmation
    await waitForUserConfirmation("\nPress Enter to continue with deployment or Ctrl+C to abort...");

    // Deploy the proxy contract
    const storagePool = await upgrades.deployProxy(
        StoragePool,
        [storageTokenAddress, initialOwner, initialAdmin],
        {
            initializer: "initialize",
            kind: "uups",
            unsafeAllow: ["external-library-linking", "constructor"]
        }
    );

    await storagePool.waitForDeployment();
    const contractAddress = await storagePool.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(contractAddress);

    console.log("StoragePoolLib library deployed to:", libAddress);
    console.log("StoragePool proxy deployed to:", contractAddress);
    console.log("Implementation address:", implementationAddress);
    console.log("Storage token address:", storageTokenAddress);
    console.log("Initial owner:", initialOwner);
    console.log("Initial admin:", initialAdmin);

    // Verify deployment by calling some view functions
    console.log("\n=== Verifying Deployment ===");
    try {
        const tokenAddress = await storagePool.token();
        const poolCreationRequirement = await storagePool.dataPoolCreationTokens();
        const poolCounter = await storagePool.poolCounter();
        
        console.log(`Linked token address: ${tokenAddress}`);
        console.log(`Pool creation requirement: ${ethers.formatEther(poolCreationRequirement)} tokens`);
        console.log(`Initial pool counter: ${poolCounter}`);
        
        // Verify token address matches
        if (tokenAddress.toLowerCase() !== storageTokenAddress.toLowerCase()) {
            throw new Error("Token address mismatch in deployed contract");
        }
        
        console.log("✅ Deployment verification successful!");
    } catch (error) {
        console.error("❌ Deployment verification failed:", error);
        throw error;
    }

    // Important post-deployment instructions
    console.log("\n=== Post-Deployment Instructions ===");
    console.log("⚠️  IMPORTANT: Complete these steps to fully activate the StoragePool:");
    console.log("1. Add this StoragePool contract as an authorized pool in the StorageToken contract:");
    console.log(`   Call: StorageToken.addPoolContract("${contractAddress}")`);
    console.log("2. Set up governance parameters (quorum, transaction limits) if needed");
    console.log("3. Grant POOL_CREATOR_ROLE to addresses that should be able to create pools");
    console.log("\n=== Deployed Addresses ===");
    console.log(`StoragePoolLib Library: ${libAddress}`);
    console.log(`StoragePool Proxy: ${contractAddress}`);
    console.log(`StoragePool Implementation: ${implementationAddress}`);
    console.log("4. Consider setting custom pool creation token requirements if 500K tokens is not suitable");

    // Verify contracts on Etherscan if API key is available
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("\nWaiting for 6 block confirmations before verification...");
        await storagePool.deploymentTransaction()?.wait(6);

        try {
            console.log("Verifying implementation contract...");
            await hre.run("verify:verify", {
                address: implementationAddress,
                constructorArguments: []
            });
            console.log("Implementation contract verified successfully");
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log("Implementation contract already verified");
            } else {
                console.error("Error verifying implementation contract:", error);
            }
        }

        try {
            console.log("Verifying proxy contract...");
            await hre.run("verify:verify", {
                address: contractAddress,
                constructorArguments: []
            });
            console.log("Proxy contract verified successfully");
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log("Proxy contract already verified");
            } else {
                console.error("Error verifying proxy contract:", error);
            }
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to deploy:
// TOKEN_ADDRESS=<Token_Proxy_address> INITIAL_OWNER=<owner_address> INITIAL_ADMIN=<admin_address> npx hardhat run scripts/deployStoragePool.ts --network sepolia
// Note: Both proxy and implementation contract verification are handled automatically if ETHERSCAN_API_KEY environment variable is set
// Manual verification commands (if needed):
// npx hardhat verify <implementation_address> --network sepolia
// npx hardhat verify <proxy_address> --network sepolia
