import { ethers, upgrades, run } from "hardhat";
import { FulaFileNFT } from "../typechain-types";
import * as readline from "readline";

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

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

    // MetaTxLib has all internal functions — compiler inlines them into FulaFileNFT.
    // No separate deployment or linking needed.
    const FulaFileNFT = await ethers.getContractFactory("FulaFileNFT");
    console.log("Deploying FulaFileNFT...");

    // Validate environment variables
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    const initialAdmin = process.env.INITIAL_ADMIN?.trim();
    const storageTokenAddr = process.env.STORAGE_TOKEN_ADDRESS?.trim();
    const baseUri = process.env.BASE_URI?.trim() || "https://ipfs.cloud.fx.land/gateway/";

    if (!initialOwner) {
        throw new Error("INITIAL_OWNER environment variable not set");
    }
    if (!initialAdmin) {
        throw new Error("INITIAL_ADMIN environment variable not set");
    }
    if (!storageTokenAddr) {
        throw new Error("STORAGE_TOKEN_ADDRESS environment variable not set");
    }

    // Get current account balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Current account balance: ${ethers.formatEther(balance)} ETH`);

    // Estimate gas for deployment
    console.log("Estimating gas for deployment...");

    try {
        const feeData = await ethers.provider.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.parseUnits("50", "gwei");

        const deployTxFactory = FulaFileNFT.getDeployTransaction();
        const implementationGas = await ethers.provider.estimateGas(deployTxFactory);

        const proxyDeploymentGas = implementationGas * BigInt(3);
        const estimatedGasCost = proxyDeploymentGas * BigInt(gasPrice);

        console.log(`Estimated implementation gas: ${implementationGas.toString()}`);
        console.log(`Estimated total gas (with proxy): ${proxyDeploymentGas.toString()}`);
        console.log(`Current gas price: ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
        console.log(`Estimated deployment cost: ${ethers.formatEther(estimatedGasCost)} ETH`);

        if (balance < BigInt(estimatedGasCost)) {
            console.warn(`WARNING: Account balance (${ethers.formatEther(balance)} ETH) might be insufficient for deployment!`);
        }
    } catch (error) {
        console.warn("Failed to estimate gas accurately:", error);
        console.warn("Proceeding with deployment will require manual gas estimation");
    }

    console.log("\nDeployment parameters:");
    console.log(`  Initial Owner: ${initialOwner}`);
    console.log(`  Initial Admin: ${initialAdmin}`);
    console.log(`  Storage Token: ${storageTokenAddr}`);
    console.log(`  Base URI:      ${baseUri}`);

    await waitForUserConfirmation("\nPress Enter to continue with deployment or Ctrl+C to abort...");

    console.log("Deploying contract...");
    const fulaFileNFT = await upgrades.deployProxy(
        FulaFileNFT,
        [initialOwner, initialAdmin, storageTokenAddr, baseUri],
        {
            initializer: "initialize",
            kind: "uups",
            unsafeAllow: ["constructor"],
            redeployImplementation: "always",
        }
    ) as FulaFileNFT;

    await fulaFileNFT.waitForDeployment();
    const proxyAddress = await fulaFileNFT.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log("FulaFileNFT proxy deployed to:", proxyAddress);
    console.log("Implementation address:", implementationAddress);
    console.log("Initial owner:", initialOwner);
    console.log("Initial admin:", initialAdmin);
    console.log("Storage token:", storageTokenAddr);
    console.log("Base URI:", baseUri);

    // Verify contracts
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("Waiting for 6 block confirmations before verification...");
        await fulaFileNFT.deploymentTransaction()?.wait(6);

        await run("verify:verify", {
            address: implementationAddress,
            contract: "contracts/core/FulaFileNFT.sol:FulaFileNFT"
        });
    }

    console.log("\nDeployment addresses:");
    console.log(`export NFT_CONTRACT_ADDRESS=${proxyAddress}`);
    console.log(`export NFT_IMPLEMENTATION=${implementationAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to run:
// INITIAL_OWNER=0x... INITIAL_ADMIN=0x... STORAGE_TOKEN_ADDRESS=0x... BASE_URI=https://ipfs.cloud.fx.land/gateway/ npx hardhat run scripts/deployFulaFileNFT.ts --network sepolia
