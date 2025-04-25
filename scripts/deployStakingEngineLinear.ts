import { ethers } from "hardhat";
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
    const StakingPoolProxy = await ethers.getContractFactory("ERC1967Proxy");
    const StakingEngineLinear = await ethers.getContractFactory("StakingEngineLinear");
    
    // Validate environment variables
    const tokenAddress = process.env.TOKEN_ADDRESS?.trim();
    const initialOwner = process.env.INITIAL_OWNER?.trim() || deployer.address;
    const initialAdmin = process.env.INITIAL_ADMIN?.trim() || deployer.address;
    const approvalAmount = process.env.APPROVAL_AMOUNT?.trim() || "100000000"; // 100M tokens by default
    const deployPools = (process.env.DEPLOY_POOLS || "").trim().toLowerCase() === "true"; // Whether to deploy new pools or use existing ones
    const stakePoolAddressEnv = process.env.STAKE_POOL_ADDRESS?.trim();
    const rewardPoolAddressEnv = process.env.REWARD_POOL_ADDRESS?.trim();
    console.log("Using parameters:");
    console.log("- Token Address:", tokenAddress);
    console.log("- Initial Owner:", initialOwner);
    console.log("- Initial Admin:", initialAdmin);
    console.log("- Approval Amount:", approvalAmount);
    console.log("- Deploy New Pools:", deployPools, process.env.DEPLOY_POOLS);
    
    // Constants for governance roles
    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

    // Validate required parameters
    if (!tokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }
    
    // Only check pool addresses if we're not deploying new ones
    if (!deployPools) {
        if (!stakePoolAddressEnv) {
            throw new Error("STAKE_POOL_ADDRESS environment variable not set and DEPLOY_POOLS is not true");
        }
        if (!rewardPoolAddressEnv) {
            throw new Error("REWARD_POOL_ADDRESS environment variable not set and DEPLOY_POOLS is not true");
        }
    }
    
    console.log("Using parameters:");
    console.log("- Token Address:", tokenAddress);
    console.log("- Initial Owner:", initialOwner);
    console.log("- Initial Admin:", initialAdmin);
    console.log("- Approval Amount:", approvalAmount);
    console.log("- Deploy New Pools:", deployPools);
    
    if (!deployPools) {
        console.log("- Stake Pool Address:", stakePoolAddressEnv);
        console.log("- Reward Pool Address:", rewardPoolAddressEnv);
    }

    // Check token contract before proceeding
    try {
        const tokenContract = await ethers.getContractAt("IERC20", tokenAddress);
        // Check balance
        const balance = await tokenContract.balanceOf(deployer.address);
        console.log(`Token verified with deployer balance: ${ethers.formatEther(balance)}`);
        
        // Check pool balances
        if (!deployPools) {
            const stakePoolBalance = await tokenContract.balanceOf(stakePoolAddressEnv!);
            const rewardPoolBalance = await tokenContract.balanceOf(rewardPoolAddressEnv!);
            console.log(`Stake Pool balance: ${ethers.formatEther(stakePoolBalance)}`);
            console.log(`Reward Pool balance: ${ethers.formatEther(rewardPoolBalance)}`);
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
    console.log("Deploying StakingEngineLinear and related contracts...");

    let stakePool: any, rewardPool: any;
    let stakePoolAddress: string, rewardPoolAddress: string;

    try {
        // Deploy new stake and reward pools if requested
        if (deployPools) {
            // Deploy StakingPool implementation
            console.log("Deploying StakingPool implementation...");
            const stakingPoolImplementation = await StakingPool.deploy();
            await stakingPoolImplementation.waitForDeployment();
            const stakingPoolImplAddress = await stakingPoolImplementation.getAddress();
            console.log("StakingPool implementation deployed to:", stakingPoolImplAddress);

            // Initialize function data for stake pool
            const stakePoolInitData = stakingPoolImplementation.interface.encodeFunctionData(
                "initialize",
                [tokenAddress, initialOwner, initialAdmin]
            );

            // Deploy stake pool proxy
            console.log("Deploying stake pool proxy...");
            const stakePoolProxy = await StakingPoolProxy.deploy(
                stakingPoolImplAddress,
                stakePoolInitData
            );
            await stakePoolProxy.waitForDeployment();
            stakePoolAddress = await stakePoolProxy.getAddress();
            console.log("Stake pool proxy deployed and initialized at:", stakePoolAddress);

            // Get a reference to the stake pool through the proxy
            stakePool = await ethers.getContractAt("StakingPool", stakePoolAddress);

            // Initialize function data for reward pool
            const rewardPoolInitData = stakingPoolImplementation.interface.encodeFunctionData(
                "initialize",
                [tokenAddress, initialOwner, initialAdmin]
            );

            // Deploy reward pool proxy
            console.log("Deploying reward pool proxy...");
            const rewardPoolProxy = await StakingPoolProxy.deploy(
                stakingPoolImplAddress, 
                rewardPoolInitData
            );
            await rewardPoolProxy.waitForDeployment();
            rewardPoolAddress = await rewardPoolProxy.getAddress();
            console.log("Reward pool proxy deployed and initialized at:", rewardPoolAddress);
            // Print the implementation address for reward pool (same as stake pool implementation)
            console.log("Reward Pool implementation address:", stakingPoolImplAddress);

            // Get a reference to the reward pool through the proxy
            rewardPool = await ethers.getContractAt("StakingPool", rewardPoolAddress);

            // Set up governance parameters for the new pools
            console.log("Set up governance parameters for pools...");

        } else {
            // Use provided addresses and get references
            stakePoolAddress = stakePoolAddressEnv!;
            rewardPoolAddress = rewardPoolAddressEnv!;
            stakePool = await ethers.getContractAt("StakingPool", stakePoolAddress);
            rewardPool = await ethers.getContractAt("StakingPool", rewardPoolAddress);
        }

        // Deploy StakingEngineLinear
        console.log("\nDeploying StakingEngineLinear...");
        const stakingEngine = await StakingEngineLinear.deploy(
            tokenAddress,
            stakePoolAddress,
            rewardPoolAddress,
            initialOwner,
            initialAdmin
        );

        console.log("StakingEngineLinear deployment transaction:", stakingEngine.deploymentTransaction ? stakingEngine.deploymentTransaction.hash : "Transaction hash not available");
        
        await stakingEngine.waitForDeployment();
        const contractAddress = await stakingEngine.getAddress();

        console.log("StakingEngineLinear deployed to:", contractAddress);
        console.log("Token address:", tokenAddress);
        console.log("Stake Pool proxy address:", stakePoolAddress);
        console.log("Reward Pool proxy address:", rewardPoolAddress);
        console.log("Initial owner:", initialOwner);
        console.log("Initial admin:", initialAdmin);

        // Set up permissions - Configure StakingPool contracts to interact with StakingEngineLinear
        console.log("\nSetting up permissions...");
        console.log("IMPORTANT: This part requires the deployer to have ADMIN_ROLE on the pool addresses.");
        console.log("If you don't have admin rights, you'll need to manually configure these permissions later.");
        
        await waitForUserConfirmation("\nPress Enter to attempt setting up permissions or Ctrl+C to skip...");
        
        try {
            // Set StakingEngineLinear address on both pools
            console.log("Setting StakingEngineLinear address on stake pool...");
            const setStakingEngineTx1 = await stakePool.connect(await ethers.getSigner(initialOwner)).setStakingEngine(contractAddress);
            await setStakingEngineTx1.wait();
            console.log("Stake pool configured with StakingEngineLinear address!");
            
            console.log("Setting StakingEngineLinear address on reward pool...");
            const setStakingEngineTx2 = await rewardPool.connect(await ethers.getSigner(initialOwner)).setStakingEngine(contractAddress);
            await setStakingEngineTx2.wait();
            console.log("Reward pool configured with StakingEngineLinear address!");
            
        } catch (error: any) {
            console.error("Failed to set up permissions automatically:", error.message);
            console.log("\nManual setup required:");
            console.log(`1. Call setStakingEngine(${contractAddress}) on both pool contracts`);
            console.log(`2. Call grantAllowanceToStakingEngine(${ethers.parseEther(approvalAmount)}) on both pool contracts`);
        }

        // Verify contract if API key is available
        if (process.env.ETHERSCAN_API_KEY) {
            console.log("\nWaiting for block confirmations before verification...");
            // Wait for several blocks to make sure the contract is indexed by the explorer
            for (let i = 0; i < 6; i++) {
                console.log(`Waiting for block ${i+1}/6...`);
                await ethers.provider.getBlock("latest");
                await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds per block
            }
            
            // Verify the deployed StakingEngineLinear
            console.log("Verifying StakingEngineLinear contract on Etherscan...");
            try {
                await hre.run("verify:verify", {
                    address: contractAddress,
                    constructorArguments: [
                        tokenAddress,
                        stakePoolAddress,
                        rewardPoolAddress,
                        initialOwner,
                        initialAdmin
                    ],
                });
                console.log("StakingEngineLinear contract verified!");
            } catch (error: any) {
                console.error("Verification failed:", error.message);
            }
            
            // If new pools were deployed, verify those too
            if (deployPools) {
                // Get the implementation address of the stake pool
                const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
                const implAddressBytes = await ethers.provider.getStorage(stakePoolAddress, implementationSlot);
                const implAddress = "0x" + implAddressBytes.toString().slice(26);
                
                console.log("Verifying StakingPool implementation at", implAddress);
                try {
                    await hre.run("verify:verify", {
                        address: implAddress,
                        constructorArguments: [],
                    });
                    console.log("StakingPool implementation verified!");
                } catch (error: any) {
                    console.error("StakingPool verification failed:", error.message);
                }
            }
        }
        
        console.log("\nDeployment completed successfully!");
        console.log("Summary:");
        console.log("- StakingEngineLinear:", contractAddress);
        console.log("- Stake Pool:", stakePoolAddress);
        console.log("- Reward Pool:", rewardPoolAddress);
        console.log("- Token:", tokenAddress);

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
// TOKEN_ADDRESS=0x... INITIAL_OWNER=0x... INITIAL_ADMIN=0x... APPROVAL_AMOUNT="100000000" DEPLOY_POOLS=true ETHERSCAN_API_KEY=abc... npx hardhat run scripts/deployStakingEngineLinear.ts --network mainnet
// 
// Or for using existing pools:
// TOKEN_ADDRESS=0x... STAKE_POOL_ADDRESS=0x... REWARD_POOL_ADDRESS=0x... npx hardhat run scripts/deployStakingEngineLinear.ts --network mainnet
