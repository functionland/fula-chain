import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { parseUnits } from "ethers";

// Import hardhat globally for verification
declare const hre: HardhatRuntimeEnvironment;

async function main() {
    console.log("Deploying StakingEngine locally on Hardhat network...");
    const [deployer, admin, user1, user2] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);

    // Get the contract factories
    const StorageToken = await ethers.getContractFactory("StorageToken");
    const StakingPool = await ethers.getContractFactory("StakingPool");
    const StakingPoolProxy = await ethers.getContractFactory("ERC1967Proxy");
    const StakingEngine = await ethers.getContractFactory("StakingEngine");
    
    // Configuration values
    const initialOwner = deployer.address;
    const initialAdmin = admin.address;
    const tokenName = "Storage Token";
    const tokenSymbol = "STRG";
    // Large token supply for testing
    const tokenSupply = parseUnits("1000000000", 18); // 1 billion tokens
    const approvalAmount = parseUnits("100000000", 18); // 100M tokens for approval
    const poolInitialAmount = parseUnits("10000000", 18); // 10M tokens for each pool
    
    // Constants for governance roles
    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

    console.log("Using configuration:");
    console.log("- Initial Owner:", initialOwner);
    console.log("- Initial Admin:", initialAdmin);
    console.log("- Token Name:", tokenName);
    console.log("- Token Symbol:", tokenSymbol);
    console.log("- Token Supply:", ethers.formatEther(tokenSupply));
    console.log("- Pool Initial Amount:", ethers.formatEther(poolInitialAmount));
    console.log("- Approval Amount:", ethers.formatEther(approvalAmount));

    try {
        // 1. Deploy Token
        console.log("\nDeploying StorageToken...");
        const storageToken = await StorageToken.deploy();
        await storageToken.waitForDeployment();
        const tokenAddress = await storageToken.getAddress();
        console.log("StorageToken deployed to:", tokenAddress);

        // Initialize the token
        console.log("\nInitializing StorageToken...");
        await storageToken.initialize(
            initialOwner,
            initialAdmin,
            tokenSupply
        );
        console.log("StorageToken initialized successfully");

        // Set up token governance
        console.log("\nSetting up token governance parameters...");
        // Increase time to bypass timelock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
        await ethers.provider.send("evm_mine", []);
        
        await storageToken.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
        
        // Wait for timelock again
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
        await ethers.provider.send("evm_mine", []);
        
        await storageToken.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
        console.log("Token governance parameters set");
        
        // 2. Deploy StakingPool Implementation
        console.log("\nDeploying StakingPool implementation...");
        const stakingPoolImplementation = await StakingPool.deploy();
        await stakingPoolImplementation.waitForDeployment();
        const stakingPoolImplAddress = await stakingPoolImplementation.getAddress();
        console.log("StakingPool implementation deployed to:", stakingPoolImplAddress);

        // 3. Deploy and initialize stake pool proxy
        console.log("\nDeploying stake pool proxy...");
        const stakePoolInitData = stakingPoolImplementation.interface.encodeFunctionData(
            "initialize",
            [tokenAddress, initialOwner, initialAdmin]
        );
        
        const stakePoolProxy = await StakingPoolProxy.deploy(
            stakingPoolImplAddress,
            stakePoolInitData
        );
        await stakePoolProxy.waitForDeployment();
        const stakePoolAddress = await stakePoolProxy.getAddress();
        console.log("Stake pool proxy deployed and initialized at:", stakePoolAddress);

        // Get a reference to the stake pool through the proxy
        const stakePool = await ethers.getContractAt("StakingPool", stakePoolAddress);

        // 4. Deploy and initialize reward pool proxy
        console.log("\nDeploying reward pool proxy...");
        const rewardPoolInitData = stakingPoolImplementation.interface.encodeFunctionData(
            "initialize",
            [tokenAddress, initialOwner, initialAdmin]
        );
        
        const rewardPoolProxy = await StakingPoolProxy.deploy(
            stakingPoolImplAddress, 
            rewardPoolInitData
        );
        await rewardPoolProxy.waitForDeployment();
        const rewardPoolAddress = await rewardPoolProxy.getAddress();
        console.log("Reward pool proxy deployed and initialized at:", rewardPoolAddress);
        
        // Get a reference to the reward pool through the proxy
        const rewardPool = await ethers.getContractAt("StakingPool", rewardPoolAddress);

        // 5. Set up governance parameters for the pools
        console.log("\nSetting up governance parameters for pools...");
        
        // Wait for timelock periods to expire for both pools
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
        await ethers.provider.send("evm_mine", []);

        // Set quorum for both pools
        await stakePool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
        await rewardPool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
        
        // Wait for timelock periods again
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
        await ethers.provider.send("evm_mine", []);
        
        // Set transaction limits
        await stakePool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
        await rewardPool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
        console.log("Governance parameters set up for both pools");

        // 6. Deploy StakingEngine
        console.log("\nDeploying StakingEngine...");
        const stakingEngine = await StakingEngine.deploy(
            tokenAddress,
            stakePoolAddress,
            rewardPoolAddress,
            initialOwner,
            initialAdmin,
            tokenName,
            tokenSymbol
        );
        
        await stakingEngine.waitForDeployment();
        const stakingEngineAddress = await stakingEngine.getAddress();
        console.log("StakingEngine deployed to:", stakingEngineAddress);

        // 7. Set up permissions for StakingEngine
        console.log("\nSetting up permissions...");
        
        // Set StakingEngine address on both pools
        console.log("Setting StakingEngine address on stake pool...");
        await stakePool.connect(deployer).setStakingEngine(stakingEngineAddress);
        console.log("Stake pool configured with StakingEngine address");
        
        console.log("Setting StakingEngine address on reward pool...");
        await rewardPool.connect(deployer).setStakingEngine(stakingEngineAddress);
        console.log("Reward pool configured with StakingEngine address");
        
        // Grant allowances from pools to StakingEngine
        console.log("Granting allowance from stake pool to StakingEngine...");
        await stakePool.connect(deployer).grantAllowanceToStakingEngine(approvalAmount);
        console.log("Stake pool allowance granted successfully");
        
        console.log("Granting allowance from reward pool to StakingEngine...");
        await rewardPool.connect(deployer).grantAllowanceToStakingEngine(approvalAmount);
        console.log("Reward pool allowance granted successfully");

        // 8. Reconcile pool balances
        console.log("\nReconciling pool balances...");
        await stakingEngine.connect(deployer).reconcilePoolBalance();
        console.log("Pool balances reconciled successfully");
        
        // 9. Get pool status after reconciliation
        console.log("\nFetching pool status after reconciliation...");
        const [totalPoolBalance, stakedAmount, rewardsAmount, actualBalance] = await stakingEngine.getPoolStatus();
        console.log("Pool status after reconciliation:");
        console.log(`- Total Pool Balance: ${ethers.formatEther(totalPoolBalance)}`);
        console.log(`- Staked Amount: ${ethers.formatEther(stakedAmount)}`);
        console.log(`- Rewards Amount: ${ethers.formatEther(rewardsAmount)}`);
        console.log(`- Actual Balance: ${ethers.formatEther(actualBalance)}`);
        
        // 10. Summary
        console.log("\nDeployment completed successfully!");
        console.log("Summary:");
        console.log("- Storage Token:", tokenAddress);
        console.log("- Stake Pool:", stakePoolAddress);
        console.log("- Reward Pool:", rewardPoolAddress);
        console.log("- StakingEngine:", stakingEngineAddress);
        console.log("\nFeel free to interact with these contracts in your tests.");

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


    // npx hardhat node
// npx hardhat run scripts/deployLocalStakingEngine.ts --network localhost