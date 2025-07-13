import { ethers, upgrades } from "hardhat";
import * as readline from "readline";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// Import hardhat globally for verification
declare const hre: HardhatRuntimeEnvironment;

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

    // Get the contract factories
    const StakingPool = await ethers.getContractFactory("StakingPool");
    const StoragePool = await ethers.getContractFactory("StoragePool");
    
    // Validate environment variables
    const storageTokenAddress = process.env.TOKEN_ADDRESS?.trim();
    const initialOwner = process.env.INITIAL_OWNER?.trim() || deployer.address;
    const initialAdmin = process.env.INITIAL_ADMIN?.trim() || deployer.address;
    const deployStakingPool = (process.env.DEPLOY_STAKING_POOL || "true").trim().toLowerCase() === "true";
    const stakingPoolAddressEnv = process.env.STAKING_POOL_ADDRESS?.trim();
    
    console.log("Using parameters:");
    console.log("- Storage Token Address:", storageTokenAddress);
    console.log("- Initial Owner:", initialOwner);
    console.log("- Initial Admin:", initialAdmin);
    console.log("- Deploy New StakingPool:", deployStakingPool);
    
    // Constants for governance roles
    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

    // Validate required parameters
    if (!storageTokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }
    
    // Only check staking pool address if we're not deploying a new one
    if (!deployStakingPool && !stakingPoolAddressEnv) {
        throw new Error("STAKING_POOL_ADDRESS environment variable not set and DEPLOY_STAKING_POOL is not true");
    }
    
    if (!deployStakingPool) {
        console.log("- Staking Pool Address:", stakingPoolAddressEnv);
    }

    // Check token contract before proceeding
    try {
        const tokenContract = await ethers.getContractAt("IERC20", storageTokenAddress);
        const balance = await tokenContract.balanceOf(deployer.address);
        console.log(`Token verified with deployer balance: ${ethers.formatEther(balance)}`);
        
        // Check staking pool balance if using existing pool
        if (!deployStakingPool && stakingPoolAddressEnv) {
            const stakingPoolBalance = await tokenContract.balanceOf(stakingPoolAddressEnv);
            console.log(`Staking Pool balance: ${ethers.formatEther(stakingPoolBalance)}`);
        }
        
    } catch (error: any) {
        console.error("⚠️ Token contract validation failed:", error.message);
        console.log("This could indicate the token address is invalid or not accessible");
        console.log("Proceeding anyway...");
    }

    // Get current account balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Current account balance: ${ethers.formatEther(balance)} ETH`);

    // Wait for user confirmation
    await waitForUserConfirmation("\nPress Enter to continue with deployment or Ctrl+C to abort...");
    console.log("Deploying StoragePool and related contracts...");

    let stakingPool: any;
    let stakingPoolAddress: string;

    try {
        // Deploy new staking pool if requested
        if (deployStakingPool) {
            console.log("\nDeploying StakingPool as UUPS proxy...");
            stakingPool = await upgrades.deployProxy(
                StakingPool,
                [storageTokenAddress, initialOwner, initialAdmin],
                {
                    initializer: "initialize",
                    kind: "uups"
                }
            );

            await stakingPool.waitForDeployment();
            stakingPoolAddress = await stakingPool.getAddress();
            console.log("StakingPool proxy deployed to:", stakingPoolAddress);
            
            // Get the implementation address
            const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);
            console.log("StakingPool implementation address:", stakingPoolImplAddress);

        } else {
            // Use provided address and get reference
            stakingPoolAddress = stakingPoolAddressEnv!;
            stakingPool = await ethers.getContractAt("StakingPool", stakingPoolAddress);
            console.log("Using existing StakingPool at:", stakingPoolAddress);
        }

        // Deploy StoragePool as UUPS proxy
        console.log("\nDeploying StoragePool as UUPS proxy...");
        const storagePool = await upgrades.deployProxy(
            StoragePool,
            [storageTokenAddress, stakingPoolAddress, initialOwner, initialAdmin],
            {
                initializer: "initialize",
                kind: "uups"
            }
        );

        await storagePool.waitForDeployment();
        const storagePoolAddress = await storagePool.getAddress();
        
        // Get the implementation address
        const storagePoolImplAddress = await upgrades.erc1967.getImplementationAddress(storagePoolAddress);
        console.log("StoragePool proxy deployed to:", storagePoolAddress);
        console.log("StoragePool implementation address:", storagePoolImplAddress);

        console.log("\nDeployment Summary:");
        console.log("- Storage Token:", storageTokenAddress);
        console.log("- Staking Pool:", stakingPoolAddress);
        console.log("- Storage Pool:", storagePoolAddress);
        console.log("- Initial Owner:", initialOwner);
        console.log("- Initial Admin:", initialAdmin);

        // Set up permissions - Configure StakingPool to interact with StoragePool
        console.log("\nSetting up permissions...");
        console.log("IMPORTANT: This part requires the deployer to have ADMIN_ROLE on the StakingPool.");
        console.log("If you don't have admin rights, you'll need to manually configure these permissions later.");
        
        await waitForUserConfirmation("\nPress Enter to attempt setting up permissions or Ctrl+C to skip...");
        
        try {
            // Set StoragePool address as the staking engine on StakingPool
            console.log("Setting StoragePool address as staking engine on StakingPool...");
            const setStakingEngineTx = await stakingPool.connect(await ethers.getSigner(initialOwner)).setStakingEngine(storagePoolAddress);
            await setStakingEngineTx.wait();
            console.log("StakingPool configured with StoragePool address!");
            
        } catch (error: any) {
            console.error("Failed to set up permissions automatically:", error.message);
            console.log("\nManual setup required:");
            console.log(`1. Call setStakingEngine(${storagePoolAddress}) on StakingPool contract at ${stakingPoolAddress}`);
        }

        // Verify contracts if API key is available
        if (process.env.ETHERSCAN_API_KEY) {
            console.log("\nWaiting for block confirmations before verification...");
            // Wait for several blocks to make sure the contract is indexed by the explorer
            for (let i = 0; i < 6; i++) {
                console.log(`Waiting for block ${i+1}/6...`);
                await ethers.provider.getBlock("latest");
                await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds per block
            }
            
            // Verify the deployed StoragePool implementation
            console.log("Verifying StoragePool implementation contract on Etherscan...");
            try {
                await hre.run("verify:verify", {
                    address: storagePoolImplAddress,
                    constructorArguments: [],
                });
                console.log("StoragePool implementation contract verified!");
            } catch (error: any) {
                console.error("StoragePool verification failed:", error.message);
            }
            
            // If new staking pool was deployed, verify that too
            if (deployStakingPool) {
                const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);
                console.log("Verifying StakingPool implementation contract on Etherscan...");
                try {
                    await hre.run("verify:verify", {
                        address: stakingPoolImplAddress,
                        constructorArguments: [],
                    });
                    console.log("StakingPool implementation contract verified!");
                } catch (error: any) {
                    console.error("StakingPool verification failed:", error.message);
                }
            }
        }
        
        console.log("\nDeployment completed successfully!");
        console.log("Summary:");
        console.log("- StoragePool:", storagePoolAddress);
        console.log("- StakingPool:", stakingPoolAddress);
        console.log("- Storage Token:", storageTokenAddress);

    } catch (error: any) {
        console.error("Deployment failed:", error.message);
        if (error.data) {
            console.error("Error data:", error.data);
        }
        if (error.stack) {
            console.error("Stack trace:", error.stack);
        }
        process.exit(1);
    }
}

// Execute the main function and handle any errors
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Run with environment variables:
// TOKEN_ADDRESS=0x... INITIAL_OWNER=0x... INITIAL_ADMIN=0x... DEPLOY_STAKING_POOL=true ETHERSCAN_API_KEY=abc... npx hardhat run scripts/StoragePool/deployStoragePool.ts --network mainnet
// set TOKEN_ADDRESS=0x9e12735d77c72c5C3670636D428f2F3815d8A4cB & set INITIAL_OWNER=0x383a6A34C623C02dcf9BB7069FAE4482967fb713 & set INITIAL_ADMIN=0xFa8b02596a84F3b81B4144eA2F30482f8C33D446 & set ETHERESCAN_API_KEY=... & set DEPLOY_STAKING_POOL=true & npx hardhat run scripts/StoragePool/deployStoragePool.ts --network base
//
// Or for using existing staking pool:
// TOKEN_ADDRESS=0x... STAKING_POOL_ADDRESS=0x... npx hardhat run scripts/StoragePool/deployStoragePool.ts --network mainnet
