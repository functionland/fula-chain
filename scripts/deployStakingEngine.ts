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
    const StakingEngine = await ethers.getContractFactory("StakingEngine");
    
    // Validate environment variables
    const tokenAddress = process.env.TOKEN_ADDRESS?.trim();
    const initialOwner = process.env.INITIAL_OWNER?.trim() || deployer.address;
    const initialAdmin = process.env.INITIAL_ADMIN?.trim() || deployer.address;
    const tokenName = process.env.TOKEN_NAME?.trim() || "Staking Token";
    const tokenSymbol = process.env.TOKEN_SYMBOL?.trim() || "STK";
    const approvalAmount = process.env.APPROVAL_AMOUNT?.trim() || "100000000"; // 100M tokens by default
    const deployPools = process.env.DEPLOY_POOLS === "true"; // Whether to deploy new pools or use existing ones
    const stakePoolAddress = process.env.STAKE_POOL_ADDRESS?.trim();
    const rewardPoolAddress = process.env.REWARD_POOL_ADDRESS?.trim();

    // Validate required parameters
    if (!tokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }
    
    // Only check pool addresses if we're not deploying new ones
    if (!deployPools) {
        if (!stakePoolAddress) {
            throw new Error("STAKE_POOL_ADDRESS environment variable not set and DEPLOY_POOLS is not true");
        }
        if (!rewardPoolAddress) {
            throw new Error("REWARD_POOL_ADDRESS environment variable not set and DEPLOY_POOLS is not true");
        }
    }
    
    console.log("Using parameters:");
    console.log("- Token Address:", tokenAddress);
    console.log("- Initial Owner:", initialOwner);
    console.log("- Initial Admin:", initialAdmin);
    console.log("- Token Name:", tokenName);
    console.log("- Token Symbol:", tokenSymbol);
    console.log("- Approval Amount:", ethers.parseEther(approvalAmount).toString());
    console.log("- Deploy New Pools:", deployPools);
    
    if (!deployPools) {
        console.log("- Stake Pool Address:", stakePoolAddress);
        console.log("- Reward Pool Address:", rewardPoolAddress);
    }

    // Check token contract before proceeding
    try {
        const tokenContract = await ethers.getContractAt("IERC20", tokenAddress);
        // Check balance
        const balance = await tokenContract.balanceOf(deployer.address);
        console.log(`Token verified with deployer balance: ${ethers.formatEther(balance)}`);
        
        // Check pool balances
        if (!deployPools) {
            const stakePoolBalance = await tokenContract.balanceOf(stakePoolAddress!);
            const rewardPoolBalance = await tokenContract.balanceOf(rewardPoolAddress!);
            console.log(`Stake Pool balance: ${ethers.formatEther(stakePoolBalance)}`);
            console.log(`Reward Pool balance: ${ethers.formatEther(rewardPoolBalance)}`);
        }
        
        // Try to get name and symbol
        try {
            const tokenWithMetadata = new ethers.Contract(
                tokenAddress,
                [
                    "function name() view returns (string)",
                    "function symbol() view returns (string)"
                ],
                ethers.provider
            );
            const name = await tokenWithMetadata.name();
            const symbol = await tokenWithMetadata.symbol();
            console.log(`Token details: ${name} (${symbol})`);
        } catch (metadataError: any) {
            console.log("Token metadata (name/symbol) not available:", metadataError.message);
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
    console.log("Deploying StakingEngine...");

    let stakePool, rewardPool;

    try {
        // Deploy new stake and reward pools if requested
        let stakePoolAddress: string, rewardPoolAddress: string;

        if (deployPools) {
            console.log("Deploying new stake pool...");
            const stakePoolContract = await StakingPool.deploy();
            await stakePoolContract.waitForDeployment();
            stakePoolAddress = await stakePoolContract.getAddress();
            console.log("Stake pool deployed to:", stakePoolAddress);

            console.log("Deploying new reward pool...");
            const rewardPoolContract = await StakingPool.deploy();
            await rewardPoolContract.waitForDeployment();
            rewardPoolAddress = await rewardPoolContract.getAddress();
            console.log("Reward pool deployed to:", rewardPoolAddress);
        } else {
            // Use provided addresses
            stakePoolAddress = stakePoolAddress!;
            rewardPoolAddress = rewardPoolAddress!;
        }

        console.log("Deploying StakingEngine...");
        // Deploy the StakingEngine contract (standard deployment, not upgradeable)
        const stakingEngine = await StakingEngine.deploy(
            tokenAddress,
            stakePoolAddress,
            rewardPoolAddress,
            initialOwner,
            initialAdmin,
            tokenName,
            tokenSymbol
        );

        console.log("StakingEngine deployment transaction:", stakingEngine.deploymentTransaction?.() ? stakingEngine.deploymentTransaction().hash : "Transaction hash not available");
        
        await stakingEngine.waitForDeployment();
        const contractAddress = await stakingEngine.getAddress();

        console.log("StakingEngine deployed to:", contractAddress);
        console.log("Token address:", tokenAddress);
        console.log("Stake Pool address:", stakePoolAddress);
        console.log("Reward Pool address:", rewardPoolAddress);
        console.log("Initial owner:", initialOwner);
        console.log("Initial admin:", initialAdmin);

        // Set up permissions - Grant allowances from pools to StakingEngine
        console.log("\nSetting up permissions...");
        console.log("IMPORTANT: This part requires the deployer to have control over the pool addresses.");
        console.log("If you don't control these addresses, you'll need to manually grant allowances later.");
        
        await waitForUserConfirmation("\nPress Enter to attempt setting up permissions or Ctrl+C to skip...");
        
        try {
            // Try to set allowance from the stake pool
            console.log("Setting allowance from stake pool to StakingEngine...");
            const stakePoolTx = await stakePool.approve(
                contractAddress, 
                ethers.parseEther(approvalAmount)
            );
            await stakePoolTx.wait();
            console.log("Stake pool allowance set successfully!");
            
            // Try to set allowance from the reward pool
            console.log("Setting allowance from reward pool to StakingEngine...");
            const rewardPoolTx = await rewardPool.approve(
                contractAddress, 
                ethers.parseEther(approvalAmount)
            );
            await rewardPoolTx.wait();
            console.log("Reward pool allowance set successfully!");
            
        } catch (error) {
            console.error("Failed to set up permissions automatically:", error.message);
            console.log("\nManual setup required:");
            console.log(`1. Connect to the stake pool address (${stakePoolAddress})`);
            console.log(`2. Call approve(${contractAddress}, ${ethers.parseEther(approvalAmount)}) on the token contract (${tokenAddress})`);
            console.log(`3. Connect to the reward pool address (${rewardPoolAddress})`);
            console.log(`4. Call approve(${contractAddress}, ${ethers.parseEther(approvalAmount)}) on the token contract (${tokenAddress})`);
        }
        
        // Reconcile pool balances
        console.log("\nReconciling pool balances...");
        await waitForUserConfirmation("Press Enter to reconcile pool balances or Ctrl+C to skip...");
        
        try {
            const stakingEngineWithOwner = new ethers.Contract(
                contractAddress,
                [
                    "function reconcilePoolBalance() external"
                ],
                await ethers.getSigner(initialOwner)
            );
            
            const reconcileTx = await stakingEngineWithOwner.reconcilePoolBalance();
            await reconcileTx.wait();
            console.log("Pool balances reconciled successfully!");
            
            // Get pool status after reconciliation
            const stakingEngineForStatus = new ethers.Contract(
                contractAddress,
                [
                    "function getPoolStatus() external view returns (uint256, uint256, uint256, uint256)"
                ],
                ethers.provider
            );
            
            const [totalPoolBalance, stakedAmount, rewardsAmount, actualBalance] = await stakingEngineForStatus.getPoolStatus();
            console.log("\nPool status after reconciliation:");
            console.log(`- Total Pool Balance: ${ethers.formatEther(totalPoolBalance)}`);
            console.log(`- Staked Amount: ${ethers.formatEther(stakedAmount)}`);
            console.log(`- Rewards Amount: ${ethers.formatEther(rewardsAmount)}`);
            console.log(`- Actual Balance: ${ethers.formatEther(actualBalance)}`);
            
        } catch (error) {
            console.error("Failed to reconcile pool balances:", error.message);
            console.log("\nManual reconciliation required:");
            console.log(`1. Connect to the contract with the owner address (${initialOwner})`);
            console.log(`2. Call reconcilePoolBalance() on the StakingEngine contract (${contractAddress})`);
        }

        // Verify contract
        if (process.env.ETHERSCAN_API_KEY) {
            console.log("\nWaiting for 6 block confirmations before verification...");
            // Wait for several blocks to make sure the contract is indexed by the explorer
            for (let i = 0; i < 6; i++) {
                console.log(`Waiting for block ${i+1}/6...`);
                await ethers.provider.getBlock("latest");
                await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds per block
            }

            try {
                console.log("Verifying contract...");
                await hre.run("verify:verify", {
                    address: contractAddress,
                    constructorArguments: [
                        tokenAddress,
                        stakePoolAddress,
                        rewardPoolAddress,
                        initialOwner,
                        initialAdmin,
                        tokenName,
                        tokenSymbol
                    ]
                });
                console.log("Contract verified successfully");
            } catch (error: any) {
                if (error.message.includes("Already Verified")) {
                    console.log("Contract already verified");
                } else {
                    console.error("Error verifying contract:", error);
                }
            }
        }
        
        console.log("\nDeployment complete! Summary:");
        console.log("-----------------------------");
        console.log(`StakingEngine: ${contractAddress}`);
        console.log(`Token: ${tokenAddress}`);
        console.log(`Stake Pool: ${stakePoolAddress}`);
        console.log(`Reward Pool: ${rewardPoolAddress}`);
        console.log("-----------------------------");
        console.log("Next steps:");
        console.log("1. Ensure both pools have sufficient allowance for the StakingEngine");
        console.log("2. Fund the reward pool with tokens for rewards");
        console.log("3. Add rewards to the pool using addRewardsToPool()");
        
    } catch (error) {
        console.error("Deployment failed:", error);
        
        // Detailed error analysis
        if (error.message.includes("nonce too low")) {
            const match = error.message.match(/next nonce (\d+), tx nonce (\d+)/);
            if (match) {
                const nextNonce = parseInt(match[1]);
                console.log(`\nNonce error detected. Try using: NONCE=${nextNonce} npx hardhat run scripts/deployStakingEngine.ts --network your-network`);
            }
        } 
        else if (error.message.includes("insufficient funds")) {
            console.log("\nInsufficient funds error. Make sure your account has enough native tokens for gas.");
        }
        else if (error.message.includes("execution reverted")) {
            console.log("\nContract execution reverted. This might be due to:");
            console.log("1. Invalid parameters passed to the constructor");
            console.log("2. Deployment logic failing (e.g., token contract issues)");
            console.log("3. Network-specific limitations");
            
            console.log("\nTry with an explicit high gas limit: GAS_LIMIT=8000000 npx hardhat run scripts/deployStakingEngine.ts --network your-network");
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
// TOKEN_ADDRESS=<Token_address> STAKE_POOL_ADDRESS=<Stake_Pool_address> REWARD_POOL_ADDRESS=<Reward_Pool_address> INITIAL_OWNER=<owner_address> INITIAL_ADMIN=<admin_address> npx hardhat run scripts/deployStakingEngine.ts --network <network>
// Optional parameters: TOKEN_NAME, TOKEN_SYMBOL, APPROVAL_AMOUNT
// Note: Contract verification is handled automatically if ETHERSCAN_API_KEY environment variable is set
