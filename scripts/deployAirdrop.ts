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
    const AirdropContract = await ethers.getContractFactory("AirdropContract");
    console.log("Deploying AirdropContract...");

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
        const deployTxFactory = AirdropContract.getDeployTransaction();
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
    const airdropContract = await upgrades.deployProxy(
        AirdropContract,
        [storageTokenAddress, initialOwner, initialAdmin],
        {
            initializer: "initialize",
            kind: "uups",
            unsafeAllow: ["constructor"]
        }
    );

    await airdropContract.waitForDeployment();
    const contractAddress = await airdropContract.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(contractAddress);

    console.log("AirdropContract proxy deployed to:", contractAddress);
    console.log("Implementation address:", implementationAddress);
    console.log("Storage token address:", storageTokenAddress);
    console.log("Initial owner:", initialOwner);
    console.log("Initial admin:", initialAdmin);

    // Verify contracts
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("Waiting for 6 block confirmations before verification...");
        await airdropContract.deploymentTransaction()?.wait(6);

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
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to deploy:
// TOKEN_ADDRESS=<Token_Proxy_address> INITIAL_OWNER=<owner_address> INITIAL_ADMIN=<admin_address> npx hardhat run scripts/deployAirdrop.ts --network sepolia
// Note: Contract verification is handled automatically if ETHERSCAN_API_KEY environment variable is set
// npx hardhat verify <contract_address> --network sepolia
// npx hardhat verify --contract contracts/AirdropContract.sol:AirdropContract <proxy_address> --network sepolia
