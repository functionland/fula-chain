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

    // Get the contract factory
    const TestnetMiningRewards = await ethers.getContractFactory("TestnetMiningRewards");
    console.log("Deploying TestnetMiningRewards...");

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

    console.log("Using parameters:");
    console.log("- Storage Token:", storageTokenAddress);
    console.log("- Initial Owner:", initialOwner);
    console.log("- Initial Admin:", initialAdmin);
    
    // Check token contract before proceeding
    try {
        const tokenContract = await ethers.getContractAt("IERC20", storageTokenAddress);
        // IERC20 doesn't include name() and symbol(), so just check balanceOf
        const balance = await tokenContract.balanceOf(deployer.address);
        console.log(`Token verified with balance: ${ethers.formatEther(balance)}`);
        
        // Optionally try to get name and symbol if available (might not be in IERC20)
        try {
            // We can try to get name and symbol using a dynamic approach
            const tokenWithMetadata = new ethers.Contract(
                storageTokenAddress,
                [
                    "function name() view returns (string)",
                    "function symbol() view returns (string)"
                ],
                ethers.provider
            );
            const name = await tokenWithMetadata.name();
            const symbol = await tokenWithMetadata.symbol();
            console.log(`Token details: ${name} (${symbol})`);
        } catch (metadataError) {
            console.log("Token metadata (name/symbol) not available");
        }
    } catch (error) {
        console.error("⚠️ Token contract validation failed:", error.message);
        console.log("This could indicate the token address is invalid or not accessible");
        console.log("Proceeding anyway...");
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
        const deployTxFactory = TestnetMiningRewards.getDeployTransaction();
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
    console.log("Deploying TestnetMiningRewards...");

    // Deploy the proxy contract
    const currentNonce = await ethers.provider.getTransactionCount(deployer.address);
    console.log(`Current account nonce: ${currentNonce}`);
    try {
        const miningRewards = await upgrades.deployProxy(
            TestnetMiningRewards,
            [storageTokenAddress, initialOwner, initialAdmin],
            {
                initializer: "initialize",
                kind: "uups",
                unsafeAllow: ["constructor"],
                useDeployedImplementation: false,
                txOverrides: {
                    nonce: currentNonce
                }
            }
        );
        console.log("TestnetMiningRewards proxy deployment transaction:", miningRewards.deploymentTransaction()?.hash);

        await miningRewards.waitForDeployment();
        const contractAddress = await miningRewards.getAddress();
        const implementationAddress = await upgrades.erc1967.getImplementationAddress(contractAddress);

        console.log("TestnetMiningRewards proxy deployed to:", contractAddress);
        console.log("Implementation address:", implementationAddress);
        console.log("Storage token address:", storageTokenAddress);
        console.log("Initial owner:", initialOwner);
        console.log("Initial admin:", initialAdmin);

        // Verify contracts
        if (process.env.ETHERSCAN_API_KEY) {
            console.log("Waiting for 6 block confirmations before verification...");
            await miningRewards.deploymentTransaction()?.wait(6);

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
        }
    } catch (error) {
        console.error("Deployment failed:", error);
        
        // Detailed error analysis
        if (error.message.includes("nonce too low")) {
            const match = error.message.match(/next nonce (\d+), tx nonce (\d+)/);
            if (match) {
                const nextNonce = parseInt(match[1]);
                console.log(`\nNonce error detected. Try using: NONCE=${nextNonce} npx hardhat run scripts/deploy.ts --network your-network`);
            }
        } 
        else if (error.message.includes("insufficient funds")) {
            console.log("\nInsufficient funds error. Make sure your account has enough native tokens for gas.");
        }
        else if (error.message.includes("execution reverted")) {
            console.log("\nContract execution reverted. This might be due to:");
            console.log("1. Invalid parameters passed to the initialize function");
            console.log("2. Initialization logic failing (e.g., token contract issues)");
            console.log("3. Network-specific limitations");
            
            console.log("\nTry with an explicit high gas limit: GAS_PRICE=100 npx hardhat run scripts/deploy.ts --network your-network");
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
// TOKEN_ADDRESS=<Token_Proxy_address> INITIAL_OWNER=<owner_address> INITIAL_ADMIN=<admin_address> npx hardhat run scripts/deployTestnetMining.ts --network sepolia
// Note: Contract verification is handled automatically if ETHERSCAN_API_KEY environment variable is set
