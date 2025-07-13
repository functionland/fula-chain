import { ethers } from "hardhat";
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
    console.log("Deploying StoragePoolLib library with the account:", deployer.address);

    // Ensure contracts are compiled with viaIR before deployment
    await ensureViaIRCompilation();

    // Validate environment variables (keeping for consistency with other scripts)
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    const initialAdmin = process.env.INITIAL_ADMIN?.trim();

    if (!initialOwner) {
        throw new Error("INITIAL_OWNER environment variable not set");
    }
    if (!initialAdmin) {
        throw new Error("INITIAL_ADMIN environment variable not set");
    }

    // Get current account balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Current account balance: ${ethers.formatEther(balance)} ETH`);

    // Display deployment parameters
    console.log("\n=== Deployment Parameters ===");
    console.log(`Initial Owner: ${initialOwner}`);
    console.log(`Initial Admin: ${initialAdmin}`);
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Network: ${hre.network.name}`);

    // Wait for user confirmation
    await waitForUserConfirmation("\nPress Enter to continue with StoragePoolLib deployment or Ctrl+C to abort...");

    // Deploy StoragePoolLib library
    console.log("Deploying StoragePoolLib library...");

    try {
        const StoragePoolLib = await ethers.getContractFactory("StoragePoolLib");
        console.log("Contract factory created successfully");

        // Deploy the library
        console.log("Sending deployment transaction...");
        const deployTx = await StoragePoolLib.deploy();
        console.log("Deployment transaction sent, waiting for confirmation...");

        // Wait for the transaction to be mined
        const receipt = await deployTx.deploymentTransaction()?.wait();
        if (!receipt) {
            throw new Error("Failed to get deployment transaction receipt");
        }

        const libAddress = receipt.contractAddress;
        if (!libAddress) {
            throw new Error("Failed to get contract address from receipt");
        }

        console.log("Library deployment confirmed!");
        console.log("✅ StoragePoolLib library deployed successfully!");
        console.log("StoragePoolLib library address:", libAddress);

        // Verify deployment by checking if the contract exists
        console.log("\n=== Verifying Deployment ===");
        const code = await ethers.provider.getCode(libAddress);
        if (code === "0x") {
            throw new Error("No contract code found at deployed address");
        }

        console.log(`Contract code size: ${(code.length - 2) / 2} bytes`);
        console.log("✅ Library deployment verification successful!");

        // Important post-deployment instructions
        console.log("\n=== Post-Deployment Instructions ===");
        console.log("✅ StoragePoolLib library is now deployed and ready to use!");
        console.log("📝 To deploy StoragePool contract that uses this library:");
        console.log(`   1. Set STORAGE_POOL_LIB_ADDRESS=${libAddress}`);
        console.log("   2. Run the StoragePool deployment script with library linking");
        console.log("\n=== Deployed Address ===");
        console.log(`StoragePoolLib Library: ${libAddress}`);

        // Verify contracts on Etherscan if API key is available
        if (process.env.ETHERSCAN_API_KEY) {
            console.log("\nWaiting for 6 block confirmations before verification...");
            await deployTx.deploymentTransaction()?.wait(6);

            try {
                console.log("Verifying StoragePoolLib library contract...");
                await hre.run("verify:verify", {
                    address: libAddress,
                    contract: "contracts/libraries/StoragePoolLib.sol:StoragePoolLib",
                    constructorArguments: []
                });
                console.log("✅ StoragePoolLib library verified successfully on Etherscan");
            } catch (error: any) {
                if (error.message.includes("Already Verified")) {
                    console.log("✅ StoragePoolLib library already verified on Etherscan");
                } else {
                    console.error("❌ Error verifying StoragePoolLib library:", error);
                }
            }
        } else {
            console.log("\n📝 To verify the library contract manually:");
            console.log(`npx hardhat verify ${libAddress} --contract contracts/libraries/StoragePoolLib.sol:StoragePoolLib --network ${hre.network.name}`);
        }

    } catch (error) {
        console.error("❌ Library deployment failed:", error);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to deploy:
// set TOKEN_ADDRESS=0x9e12735d77c72c5C3670636D428f2F3815d8A4cB & set INITIAL_OWNER=0x383a6A34C623C02dcf9BB7069FAE4482967fb713 & set INITIAL_ADMIN=0xFa8b02596a84F3b81B4144eA2F30482f8C33D446 & npx hardhat run scripts/StoragePool/deployStoragePoolLib.ts --network base
// 
// Note: This script deploys only the StoragePoolLib library contract.
// The library deployment requires viaIR compilation to be enabled.
// After deployment, use the library address to deploy StoragePool contract with proper linking.
//
// Manual verification command (if needed):
// npx hardhat verify <library_address> --contract contracts/StoragePoolLib.sol:StoragePoolLib --network base
