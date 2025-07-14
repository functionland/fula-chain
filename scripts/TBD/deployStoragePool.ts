import { ethers, upgrades } from "hardhat";
import hre from "hardhat";
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

  // Function to ensure contracts are compiled with viaIR
  async function ensureViaIRCompilation() {
    console.log("Ensuring contracts are compiled with viaIR enabled...");

    // Force recompilation to ensure viaIR is used
    try {
      await hre.run("compile", { force: true });
      console.log("✅ Contracts compiled successfully with viaIR");
    } catch (error) {
      console.error("❌ Compilation failed:", error);
      throw new Error("Failed to compile contracts with viaIR. Please check your hardhat.config.ts");
    }
  }

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);

    // Ensure contracts are compiled with viaIR before deployment
    await ensureViaIRCompilation();

    // Check if StoragePoolLib address is provided via environment variable
    const preDeployedLibAddress = process.env.STORAGE_POOL_LIB_ADDRESS?.trim();
    const preDeployedImplAddress = process.env.STORAGE_POOL_IMPL_ADDRESS?.trim();
    let libAddress: string;

    if (preDeployedLibAddress) {
        console.log("Using pre-deployed StoragePoolLib library at:", preDeployedLibAddress);

        // Validate that the provided address has contract code
        const code = await ethers.provider.getCode(preDeployedLibAddress);
        if (code === "0x") {
            throw new Error(`No contract found at provided STORAGE_POOL_LIB_ADDRESS: ${preDeployedLibAddress}`);
        }

        libAddress = preDeployedLibAddress;
        console.log("✅ Pre-deployed StoragePoolLib library validated");
    } else {
        // Deploy StoragePoolLib library first
        console.log("Deploying new StoragePoolLib library...");
        const StoragePoolLib = await ethers.getContractFactory("StoragePoolLib");
        const storagePoolLib = await StoragePoolLib.deploy();
        await storagePoolLib.waitForDeployment();
        libAddress = await storagePoolLib.getAddress();
        console.log("StoragePoolLib deployed to:", libAddress);
    }

    // Get the contract factory with library linking
    const StoragePool = await ethers.getContractFactory("StoragePool", {
        libraries: {
            StoragePoolLib: libAddress
        }
    });

    // Check if implementation is pre-deployed
    if (preDeployedImplAddress) {
        console.log("Using pre-deployed StoragePool implementation at:", preDeployedImplAddress);

        // Validate that the provided address has contract code
        const implCode = await ethers.provider.getCode(preDeployedImplAddress);
        if (implCode === "0x") {
            throw new Error(`No contract found at provided STORAGE_POOL_IMPL_ADDRESS: ${preDeployedImplAddress}`);
        }
        console.log("✅ Pre-deployed StoragePool implementation validated");
        console.log("Proceeding directly to proxy deployment...");
    } else {
        console.log("Deploying StoragePool implementation...");
    }

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
    console.log(`StoragePoolLib Address: ${libAddress}`);
    console.log(`Library Source: ${preDeployedLibAddress ? 'Pre-deployed' : 'Newly deployed'}`);
    if (preDeployedImplAddress) {
        console.log(`StoragePool Implementation: ${preDeployedImplAddress} (Pre-deployed)`);
    }
    console.log(`Initial Owner: ${initialOwner}`);
    console.log(`Initial Admin: ${initialAdmin}`);
    console.log(`Deployer: ${deployer.address}`);

    // Wait for user confirmation
    await waitForUserConfirmation("\nPress Enter to continue with deployment or Ctrl+C to abort...");

    let storagePool: any;
    let contractAddress: string;
    let implementationAddress: string;

    if (preDeployedImplAddress) {
        // Deploy proxy using pre-deployed implementation
        console.log("Deploying proxy with pre-deployed implementation...");

        // First, force import the existing implementation to register it with OpenZeppelin
        await upgrades.forceImport(preDeployedImplAddress, StoragePool, {
            kind: "uups",
            unsafeAllow: ["external-library-linking"]
        });

        // Now deploy the proxy using the imported implementation
        storagePool = await upgrades.deployProxy(
            StoragePool,
            [storageTokenAddress, initialOwner, initialAdmin],
            {
                initializer: "initialize",
                kind: "uups",
                unsafeAllow: ["external-library-linking"]
            }
        );

        await storagePool.waitForDeployment();
        contractAddress = await storagePool.getAddress();
        implementationAddress = preDeployedImplAddress;
    } else {
        // Deploy both implementation and proxy
        console.log("Deploying implementation and proxy...");

        storagePool = await upgrades.deployProxy(
            StoragePool,
            [storageTokenAddress, initialOwner, initialAdmin],
            {
                initializer: "initialize",
                kind: "uups",
                unsafeAllow: ["external-library-linking"]
            }
        );

        await storagePool.waitForDeployment();
        contractAddress = await storagePool.getAddress();
        implementationAddress = await upgrades.erc1967.getImplementationAddress(contractAddress);
    }

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

        // Only verify the library if it was newly deployed
        if (!preDeployedLibAddress) {
            try {
                console.log("Verifying StoragePoolLib library contract...");
                await hre.run("verify:verify", {
                    address: libAddress,
                    contract: "contracts/libraries/StoragePoolLib.sol:StoragePoolLib",
                    constructorArguments: []
                });
                console.log("✅ StoragePoolLib library verified successfully");
            } catch (error: any) {
                if (error.message.includes("Already Verified")) {
                    console.log("✅ StoragePoolLib library already verified");
                } else {
                    console.error("❌ Error verifying StoragePoolLib library:", error);
                }
            }
        } else {
            console.log("ℹ️  Skipping StoragePoolLib verification (using pre-deployed library)");
        }

        // Only verify the implementation if it was newly deployed
        if (!preDeployedImplAddress) {
            try {
                console.log("Verifying implementation contract...");
                await hre.run("verify:verify", {
                    address: implementationAddress,
                    constructorArguments: []
                });
                console.log("✅ Implementation contract verified successfully");
            } catch (error: any) {
                if (error.message.includes("Already Verified")) {
                    console.log("✅ Implementation contract already verified");
                } else {
                    console.error("❌ Error verifying implementation contract:", error);
                }
            }
        } else {
            console.log("ℹ️  Skipping implementation verification (using pre-deployed implementation)");
        }

        try {
            console.log("Verifying proxy contract...");
            await hre.run("verify:verify", {
                address: contractAddress,
                constructorArguments: []
            });
            console.log("✅ Proxy contract verified successfully");
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log("✅ Proxy contract already verified");
            } else {
                console.error("❌ Error verifying proxy contract:", error);
            }
        }
    } else {
        console.log("\n📝 To verify contracts manually:");
        if (!preDeployedLibAddress) {
            console.log(`npx hardhat verify ${libAddress} --contract contracts/libraries/StoragePoolLib.sol:StoragePoolLib --network ${hre.network.name}`);
        }
        if (!preDeployedImplAddress) {
            console.log(`npx hardhat verify ${implementationAddress} --network ${hre.network.name}`);
        }
        console.log(`npx hardhat verify ${contractAddress} --network ${hre.network.name}`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to deploy:
// TOKEN_ADDRESS=<Token_Proxy_address> INITIAL_OWNER=<owner_address> INITIAL_ADMIN=<admin_address> npx hardhat run scripts/StoragePool/deployStoragePool.ts --network sepolia
//
// Optional: Use pre-deployed StoragePoolLib library:
// TOKEN_ADDRESS=<Token_Proxy_address> INITIAL_OWNER=<owner_address> INITIAL_ADMIN=<admin_address> STORAGE_POOL_LIB_ADDRESS=<Library_address> npx hardhat run scripts/StoragePool/deployStoragePool.ts --network sepolia
//
// Optional: Use pre-deployed StoragePool implementation:
// TOKEN_ADDRESS=<Token_Proxy_address> INITIAL_OWNER=<owner_address> INITIAL_ADMIN=<admin_address> STORAGE_POOL_LIB_ADDRESS=<Library_address> STORAGE_POOL_IMPL_ADDRESS=<Implementation_address> npx hardhat run scripts/StoragePool/deployStoragePool.ts --network sepolia
//
// Environment Variables:
// - TOKEN_ADDRESS: Required - Address of deployed StorageToken contract
// - INITIAL_OWNER: Required - Address that will own the contract
// - INITIAL_ADMIN: Required - Address that will have admin role
// - STORAGE_POOL_LIB_ADDRESS: Optional - Address of pre-deployed StoragePoolLib library (if not provided, deploys new one)
// - STORAGE_POOL_IMPL_ADDRESS: Optional - Address of pre-deployed StoragePool implementation (if not provided, deploys new one)
// - ETHERSCAN_API_KEY: Optional - For automatic contract verification
//
// Note: Contract verification is handled automatically if ETHERSCAN_API_KEY environment variable is set
// Only newly deployed contracts are verified (pre-deployed contracts are skipped)
// Manual verification commands (if needed):
// npx hardhat verify <library_address> --contract contracts/libraries/StoragePoolLib.sol:StoragePoolLib --network sepolia
// npx hardhat verify <implementation_address> --network sepolia
// npx hardhat verify <proxy_address> --network sepolia
